#!/usr/bin/env tsx
/**
 * Bronze → Silver ETL: Transforms Vivino wine_pdp_snapshot rows into
 * normalised SilverWineRecord NDJSON.
 *
 * Includes deduplication (RFC-002 idempotency) and popularity normalization.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/etl/vivino-to-silver.ts
 *   npx tsx --env-file=.env scripts/etl/vivino-to-silver.ts --limit 100
 *   npx tsx --env-file=.env scripts/etl/vivino-to-silver.ts --output data/silver.ndjson
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pg from 'pg';
import type { PoolConfig } from 'pg';
import type {
  BronzeRow,
  VivinoPayload,
  SilverWineRecord,
  WineType,
  PriceBand,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = 'vivino';
const DEFAULT_OUTPUT = 'data/silver.ndjson';

const VIVINO_STYLE_MAP: Record<string, WineType> = {
  'red wine': 'red',
  'white wine': 'white',
  'rosé wine': 'rosé',
  'rose wine': 'rosé',
  'sparkling wine': 'sparkling',
  'dessert wine': 'dessert',
  'fortified wine': 'fortified',
};

// ---------------------------------------------------------------------------
// DB connection (matches fetch-vivino-snapshots pattern)
// ---------------------------------------------------------------------------

function wantsRdsSsl(host: string): boolean {
  return host.includes('rds.amazonaws.com');
}

function poolFromEnv(): pg.Pool {
  const conn = process.env['DATABASE_URL'];
  if (conn !== undefined && conn.length > 0) {
    let host = '';
    try {
      host = new URL(conn).hostname;
    } catch {
      throw new Error('DATABASE_URL is not a valid URL');
    }
    const ssl = wantsRdsSsl(host)
      ? { rejectUnauthorized: false as const }
      : undefined;
    return new pg.Pool({ connectionString: conn, ssl, max: 2, connectionTimeoutMillis: 20_000 });
  }

  const host = process.env['PG_HOST'];
  const port = Number(process.env['PG_PORT'] ?? '5432');
  const database = process.env['PG_DATABASE'];
  const user = process.env['PG_USER'];
  const password = process.env['PG_PASSWORD'];
  if (!host || !database || !user || password === undefined) {
    throw new Error(
      'Set DATABASE_URL or PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD',
    );
  }
  const ssl = wantsRdsSsl(host)
    ? { rejectUnauthorized: false as const }
    : undefined;
  const cfg: PoolConfig = { host, port, database, user, password, ssl, max: 2, connectionTimeoutMillis: 20_000 };
  return new pg.Pool(cfg);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  limit: number;
  output: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 0, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      out.limit = Math.max(1, Number(argv[++i] ?? '0'));
    } else if (a === '--output' || a === '-o') {
      out.output = argv[++i] ?? DEFAULT_OUTPUT;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: vivino-to-silver.ts [--limit N] [--output PATH]');
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** Deterministic entity ID from source + external_id (RFC-002 idempotency). */
function makeEntityId(externalId: string): string {
  return `vivino-${crypto
    .createHash('sha256')
    .update(`${SOURCE_ID}:${externalId}`)
    .digest('hex')
    .slice(0, 16)}`;
}

/**
 * Normalise Vivino display_name to canonical label (RFC-002).
 *
 * Rules:
 * 1. Trim whitespace, collapse multiple spaces.
 * 2. Remove leading producer duplication ("Opus One Winery Opus One" → "Opus One").
 * 3. Ensure vintage year is appended if present and not already in string.
 */
function normalizeLabel(
  displayName: string,
  producer: string | null,
  vintageYear: number | null,
): string {
  let label = displayName.trim().replace(/\s+/g, ' ');

  // Remove leading producer duplication: "Chateau Margaux Chateau Margaux 2015"
  if (producer) {
    const lowerLabel = label.toLowerCase();
    const lowerProducer = producer.toLowerCase().trim();
    if (
      lowerLabel.startsWith(lowerProducer) &&
      lowerLabel.length > lowerProducer.length
    ) {
      const rest = label.slice(lowerProducer.length).trim();
      if (rest.toLowerCase().startsWith(lowerProducer)) {
        label = rest;
      }
    }
  }

  // Append vintage if not already present
  if (vintageYear !== null) {
    const yearStr = String(vintageYear);
    if (!label.includes(yearStr)) {
      label = `${label} ${yearStr}`;
    }
  }

  return label;
}

/** Vivino 1–5 (or 0–5) → [0, 1]. */
function normalizeScale(score: number | undefined | null, max = 5): number {
  if (score === undefined || score === null || !isFinite(score)) return 0.5;
  return Math.max(0, Math.min(1, score / max));
}

/** Price USD → price band. */
function priceBand(priceUsd: number | null): PriceBand {
  if (priceUsd === null) return 'mid'; // unknown → neutral
  if (priceUsd >= 500) return 'luxury';
  if (priceUsd >= 100) return 'premium';
  if (priceUsd >= 30) return 'mid';
  return 'value';
}

/** Detect wine type from Vivino style string. */
function detectWineType(wineStyle: string | null): WineType {
  if (!wineStyle) return 'red'; // default
  const lower = wineStyle.toLowerCase();
  for (const [key, value] of Object.entries(VIVINO_STYLE_MAP)) {
    if (lower.includes(key)) return value;
  }
  return 'red';
}

/** Build English search text from payload fields. */
function buildSearchText(
  row: BronzeRow,
  payload: VivinoPayload | null,
): string {
  const parts: string[] = [];

  // Style description (richest tasting note source)
  const styleDesc = payload?.style?.description;
  if (styleDesc) parts.push(styleDesc);

  // Body description
  const bodyDesc = payload?.style?.body_description;
  if (bodyDesc) parts.push(bodyDesc);

  // Acidity description
  const acidDesc = payload?.style?.acidity_description;
  if (acidDesc) parts.push(acidDesc);

  // Flavor group tags
  const flavors = (payload?.taste?.flavor ?? [])
    .map((f) => f.group?.replace(/-/g, ' '))
    .filter((g): g is string => g !== undefined && g.length > 0);
  if (flavors.length > 0) parts.push(flavors.join(', '));

  // Grape names
  const grapes = (payload?.grapes ?? [])
    .map((g) => g.name)
    .filter((n): n is string => n !== undefined && n.length > 0);
  if (grapes.length > 0) parts.push(grapes.join(', '));

  // Canonical info for recall
  if (row.producer) parts.push(row.producer);
  if (row.region) parts.push(row.region);
  if (row.country) parts.push(row.country);

  return parts.join('. ').trim();
}

/** Extract flavor profile tags from payload. */
function extractFlavorProfiles(payload: VivinoPayload | null): readonly string[] {
  if (!payload?.taste?.flavor) return [];
  return payload.taste.flavor
    .map((f) => f.group?.replace(/-/g, ' '))
    .filter((g): g is string => g !== undefined && g.length > 0);
}

/** Extract grape names from payload. */
function extractGrapes(payload: VivinoPayload | null): readonly string[] {
  if (!payload?.grapes) return [];
  return payload.grapes
    .map((g) => g.name)
    .filter((n): n is string => n !== undefined && n.length > 0);
}

/** Extract food pairings from payload. */
function extractPairings(payload: VivinoPayload | null): readonly string[] {
  return payload?.food_pairings?.filter((p) => p.length > 0) ?? [];
}

// ---------------------------------------------------------------------------
// Transform: BronzeRow → SilverWineRecord (pre-popularity)
// ---------------------------------------------------------------------------

interface PreSilver extends Omit<SilverWineRecord, 'popularityScore'> {
  readonly ratingsCount: number;
}

function transformRow(row: BronzeRow): PreSilver | null {
  const externalId = row.external_id;
  if (!externalId) return null;

  const payload = row.payload;
  const producer = row.producer?.trim() ?? payload?.winery?.name?.trim() ?? '';
  if (!producer) return null; // can't index without producer

  const vintageYear =
    row.vintage_year ?? payload?.vintage?.year ?? null;

  const canonicalLabel = normalizeLabel(
    row.display_name,
    producer,
    vintageYear,
  );

  const country =
    row.country?.trim() ??
    payload?.region?.country?.name?.trim() ??
    '';

  const region =
    row.region?.trim() ??
    payload?.region?.name?.trim() ??
    '';

  const grapes = extractGrapes(payload);
  const grapePrimary = grapes[0] ?? null;

  const taste = payload?.taste?.structure;

  return {
    sourceId: makeEntityId(externalId),
    externalId,
    canonicalLabel,
    producer,
    vintageYear,
    country,
    region,
    appellation: null, // Vivino rarely has appellation-level detail
    wineType: detectWineType(row.wine_style),
    grapePrimary,
    grapes,
    body: normalizeScale(taste?.intensity, 5),
    sweetness: normalizeScale(taste?.sweetness, 5),
    acidity: normalizeScale(taste?.acidity, 5),
    tannin: normalizeScale(taste?.tannin, 5),
    pairingTags: extractPairings(payload),
    flavorProfiles: extractFlavorProfiles(payload),
    searchTextEn: buildSearchText(row, payload),
    ratingAvg: row.rating ?? payload?.statistics?.ratings_average ?? null,
    ratingsCount: payload?.statistics?.ratings_count ?? 0,
    priceUsd: row.price, // simplified: treat all currencies as USD for now
    priceBand: priceBand(row.price),
    scrapedAt: row.scraped_at,
  };
}

// ---------------------------------------------------------------------------
// Deduplication (RFC-002 idempotency)
// ---------------------------------------------------------------------------

/**
 * Dedup by (external_id, vintage_year). Keeps the row with:
 * 1. Most recent scraped_at
 * 2. Highest ratings_count
 * 3. Non-empty search text
 */
function dedup(records: PreSilver[]): PreSilver[] {
  const byKey = new Map<string, PreSilver>();

  for (const rec of records) {
    const key = `${rec.externalId}::${rec.vintageYear ?? 'NV'}`;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, rec);
      continue;
    }

    // Prefer newer scrape
    const existingTime = existing.scrapedAt
      ? new Date(existing.scrapedAt).getTime()
      : 0;
    const newTime = rec.scrapedAt ? new Date(rec.scrapedAt).getTime() : 0;
    if (newTime > existingTime) {
      byKey.set(key, rec);
      continue;
    }
    if (newTime === existingTime && rec.ratingsCount > existing.ratingsCount) {
      byKey.set(key, rec);
      continue;
    }
    if (
      newTime === existingTime &&
      rec.ratingsCount === existing.ratingsCount &&
      rec.searchTextEn.length > existing.searchTextEn.length
    ) {
      byKey.set(key, rec);
    }
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Popularity normalisation (log1p across corpus)
// ---------------------------------------------------------------------------

function normalizePopularity(records: PreSilver[]): SilverWineRecord[] {
  const maxCount = records.reduce(
    (mx, r) => Math.max(mx, r.ratingsCount),
    1,
  );

  return records.map((r) => ({
    ...r,
    popularityScore: Math.log1p(r.ratingsCount) / Math.log1p(maxCount),
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = poolFromEnv();

  try {
    console.log('Fetching Bronze rows from wine_pdp_snapshot …');

    const limitClause = args.limit > 0 ? `LIMIT ${args.limit}` : '';
    const query = `
      SELECT
        id, external_id, display_name, producer, vintage_year,
        region, country, wine_style, rating, price, currency,
        scraped_at, source_url, payload
      FROM wine_pdp_snapshot
      WHERE source_id = $1
      ORDER BY scraped_at DESC NULLS LAST
      ${limitClause}
    `;

    const result = await pool.query<BronzeRow>(query, [SOURCE_ID]);
    console.log(`  Bronze rows fetched: ${result.rows.length}`);

    // Transform
    const preSilver: PreSilver[] = [];
    let skipped = 0;
    for (const row of result.rows) {
      const rec = transformRow(row);
      if (rec) {
        preSilver.push(rec);
      } else {
        skipped++;
      }
    }
    console.log(`  Transformed: ${preSilver.length}  (skipped: ${skipped})`);

    // Dedup
    const deduped = dedup(preSilver);
    console.log(`  After dedup: ${deduped.length}`);

    // Popularity normalization
    const silver = normalizePopularity(deduped);

    // Write NDJSON
    const lines = silver.map((r) => JSON.stringify(r)).join('\n');
    await fs.writeFile(args.output, lines + '\n', 'utf8');
    console.log(`  Written to: ${args.output}`);

    // Summary stats
    const withTasting = silver.filter((r) => r.searchTextEn.length > 30).length;
    const withPrice = silver.filter((r) => r.priceUsd !== null).length;
    const withGrape = silver.filter((r) => r.grapePrimary !== null).length;
    console.log(`  Coverage: tasting=${withTasting}/${silver.length} (${((withTasting / silver.length) * 100).toFixed(1)}%), price=${withPrice}, grape=${withGrape}`);
  } finally {
    await pool.end();
  }
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
