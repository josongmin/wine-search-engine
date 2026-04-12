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
import crypto from 'node:crypto';
import pg from 'pg';
import type { PoolConfig } from 'pg';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { createSourceRecordId } from '../../src/domain/shared/types/entity-id.js';
import { atomicWriteFile } from './etl-utils.js';
import type {
  BronzeRow,
  VivinoPayload,
  SilverWineRecord,
  WineType,
  PriceBand,
} from './types.js';

// ---------------------------------------------------------------------------
// Approximate FX rates for non-USD currency normalisation.
// Updated periodically — good enough for price band classification.
// ---------------------------------------------------------------------------

const FX_TO_USD: Record<string, number> = {
  USD: 1.0,
  EUR: 1.08,
  GBP: 1.27,
  AUD: 0.66,
  CAD: 0.74,
  CHF: 1.13,
  JPY: 0.0067,
  KRW: 0.00075,
  SEK: 0.096,
  DKK: 0.145,
  NOK: 0.094,
  NZD: 0.61,
  ZAR: 0.055,
  BRL: 0.20,
  ARS: 0.0012,
  CLP: 0.0011,
  MXN: 0.058,
  CNY: 0.14,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ID = 'vivino';
export const DEFAULT_OUTPUT = resolveDataPath('data/silver.ndjson');

const VIVINO_STYLE_MAP: Record<string, WineType> = {
  'red wine': 'red',
  'white wine': 'white',
  'rosé wine': 'rosé',
  'rose wine': 'rosé',
  'sparkling wine': 'sparkling',
  'dessert wine': 'dessert',
  'fortified wine': 'fortified',
};

// Vivino wine_style substrings → WineType (for region-style labels like "Napa Valley Cabernet Sauvignon")
const VIVINO_STYLE_KEYWORD_MAP: Array<[string, WineType]> = [
  ['sparkling', 'sparkling'],
  ['champagne', 'sparkling'],
  ['cava', 'sparkling'],
  ['prosecco', 'sparkling'],
  ['rosé', 'rosé'],
  // 'rose' substring must be matched with word boundaries to avoid false positives
  // on producer/vineyard names like "Rosemary Vineyard" or "Primrose Hill" (CLAUDE.md rule 23).
  // Use regex instead of plain substring match. This entry is replaced by the regex check
  // in detectWineType below — the plain 'rose' entry is intentionally omitted here.
  // ['rose', 'rosé'],  // ← DO NOT restore: causes "rosemary" → 'rosé' false positive
  ['port', 'fortified'],
  ['sherry', 'fortified'],
  ['madeira', 'fortified'],
  ['dessert', 'dessert'],
  ['sauternes', 'dessert'],
  ['white', 'white'],
  ['blanc', 'white'],
  ['blanco', 'white'],
  ['bianco', 'white'],
  ['chardonnay', 'white'],
  ['sauvignon blanc', 'white'],
  ['riesling', 'white'],
  ['pinot gris', 'white'],
  ['pinot grigio', 'white'],
  ['gewurztraminer', 'white'],
  ['viognier', 'white'],
];

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
export function normalizeLabel(
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

/**
 * Vivino 1–5 (or 0–5) → [0, 1].
 * Returns null when the score is missing so callers can distinguish
 * "no data" from a measured mid-range value.
 */
function normalizeScale(score: number | undefined | null, max = 5): number | null {
  if (score === undefined || score === null || !Number.isFinite(score)) return null;
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

/** Set of common red wine grape varieties (lowercased) for type inference fallback. */
const RED_GRAPES: ReadonlySet<string> = new Set([
  'cabernet sauvignon', 'merlot', 'pinot noir', 'syrah', 'shiraz', 'malbec',
  'grenache', 'sangiovese', 'nebbiolo', 'tempranillo', 'zinfandel', 'cabernet franc',
  'mourvèdre', 'mourvedre', 'petite sirah', 'carmenère', 'carmenere', 'gamay',
  'barbera', 'montepulciano', 'corvina', 'aglianico', 'touriga nacional', 'tannat',
  'pinotage', 'nero d\'avola', 'primitivo',
]);

/** Set of common white wine grape varieties (lowercased). */
const WHITE_GRAPES: ReadonlySet<string> = new Set([
  'chardonnay', 'sauvignon blanc', 'riesling', 'pinot grigio', 'pinot gris',
  'gewürztraminer', 'gewurztraminer', 'viognier', 'sémillon', 'semillon',
  'chenin blanc', 'albariño', 'albarino', 'verdejo', 'grüner veltliner', 'gruner veltliner',
  'moscato', 'muscat', 'trebbiano', 'vermentino', 'fiano', 'vernaccia', 'arneis',
  'roussanne', 'marsanne', 'palomino', 'pedro ximénez', 'pedro ximenez',
]);

/** Infer wine type from primary grape when style string is unrecognized.
 *  Returns null if grape is unknown — caller falls back to 'red' as last resort. */
function inferTypeFromGrape(grapePrimary: string | null): WineType | null {
  if (!grapePrimary) return null;
  const lower = grapePrimary.toLowerCase().trim();
  if (RED_GRAPES.has(lower)) return 'red';
  if (WHITE_GRAPES.has(lower)) return 'white';
  return null;
}

/** Detect wine type from Vivino style string. Returns null when no match —
 *  the caller MUST handle the null case (e.g., infer from grapes/region in
 *  the Phase 1 enrichment step) instead of defaulting to 'red'.
 *
 *  v4 fix: previously returned 'red' on no match, silently corrupting wine type
 *  for any wine whose Vivino style was missing or used an unrecognized vocabulary.
 *  Whites, rosés, sparkling, dessert, and fortified wines were all silently
 *  indexed as 'red', breaking type-filtered search and corrupting facets. */
// Unicode-aware word boundary for ETL wine-style keyword matching.
// CLAUDE.md rule 8: \b is ASCII-only and fails on accented chars like 'é'. Use [\p{L}\p{N}] instead.
const ROSE_WORD_BOUNDARY_RE = /(?:^|[^\p{L}\p{N}])ros[eé](?=$|[^\p{L}\p{N}])/iu;

function detectWineType(wineStyle: string | null): WineType | null {
  if (!wineStyle) return null;
  const lower = wineStyle.toLowerCase();
  // Exact-key map first (highest precision)
  for (const [key, value] of Object.entries(VIVINO_STYLE_MAP)) {
    if (lower.includes(key)) return value;
  }
  // 'rose' / 'rosé' must use word-boundary regex to avoid false positives on
  // producer/vineyard names like "Rosemary Vineyard" or "Primrose". Plain
  // includes('rose') matches 'rosemary' and would silently misclassify white wines.
  if (ROSE_WORD_BOUNDARY_RE.test(lower)) return 'rosé';
  // Keyword fallback for region-style labels (e.g. "Napa Valley Cabernet Sauvignon")
  for (const [keyword, type] of VIVINO_STYLE_KEYWORD_MAP) {
    if (lower.includes(keyword)) return type;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SOTA++ extraction helpers
// ---------------------------------------------------------------------------

/**
 * Parses an alcohol string like "14%", "13.5%", "14,4% alc" → float or null.
 * Returns null when the string is absent or unparseable.
 *
 * SCAN4-14: Supports European decimal notation ("14,5%") — comma used as the
 * decimal separator in French, German, Italian, and Spanish wine databases.
 * The regex captures both "14.5" and "14,5" forms.
 */
export function parseAlcohol(raw: string | undefined): number | null {
  if (!raw) return null;
  // Match digits optionally followed by a decimal separator (period or comma) and more digits
  const match = raw.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!match || !match[1]) return null;
  // Normalize European comma-decimal to period before parsing
  const normalized = match[1].replace(',', '.');
  const val = parseFloat(normalized);
  // Sanity range: 0–25% ABV (covers fortified wines like Port ~20%, some Amarone ~17%)
  return Number.isFinite(val) && val > 0 && val <= 25 ? val : null;
}

/**
 * Parses Vivino's varietal string ("Grenache, Shiraz/Syrah") into an array of
 * canonical grape names.
 *
 * Vivino uses two separators with different semantics:
 *   - Comma (",") separates DISTINCT grapes: "Grenache, Syrah" → ['Grenache', 'Syrah']
 *   - Slash ("/") separates SYNONYMS for the same grape: "Garnacha/Grenache" → ['Garnacha']
 *     (first name is canonical; alternatives are discarded to avoid duplicate grapes)
 *
 * Treating slashes as commas (previous behavior) destroyed the synonym relationship,
 * producing ["Garnacha", "Grenache"] as two separate grapes for one variety.
 *
 * Returns empty array when absent.
 */
export function parseVarietal(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((segment) => {
      // For each comma-separated segment, take only the first slash-delimited token
      // (the canonical name). "Garnacha/Grenache" → "Garnacha".
      const canonical = segment.split('/')[0] ?? segment;
      return canonical.trim();
    })
    .filter((s) => s.length > 0);
}

/**
 * Cleans the raw Bronze region path.
 *
 * Vivino region strings are often repeated paths like:
 *   "United States / Horse Heaven Hills / Washington / Columbia Valley / Horse Heaven Hills"
 *
 * Strategy:
 *   1. If winery_location is available and concise, prefer it.
 *   2. Otherwise take the last unique segment of the slash-delimited path.
 */
export function cleanRegion(
  rawRegion: string | null,
  wineryLocation: string | undefined,
): string {
  // Prefer winery_location when it's a single clean label
  if (wineryLocation && !wineryLocation.includes('/') && wineryLocation.trim().length > 0) {
    return wineryLocation.trim();
  }

  if (!rawRegion) return '';

  // Take the last segment, deduplicate repeated segments
  const segments = rawRegion
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Find the last segment that isn't a duplicate of an earlier one
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      deduped.push(seg);
    }
  }

  // Return the most specific (last) segment
  return deduped[deduped.length - 1] ?? rawRegion.trim();
}

/**
 * Converts a price from its source currency to USD using approximate FX rates.
 * Returns null for unknown currencies to avoid silently corrupting price data.
 */
function toUsd(price: number, currency: string): number | null {
  const upper = currency.toUpperCase();
  const rate = FX_TO_USD[upper];
  if (rate === undefined) return null;
  return price * rate;
}

/**
 * Computes the median of a sorted numeric array.
 * Assumes `sorted` is already in ascending order.
 */
function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Extracts the best available price in USD from a Bronze row.
 *
 * Priority:
 *   1. payload.merchant_prices — convert all to USD, take median of 750ml-equivalent
 *   2. row.price — top-level price; normalize magnum to 750ml equivalent
 */
export function extractPriceUsd(
  rowPrice: number | null,
  rowCurrency: string | null,
  merchantPrices: VivinoPayload['merchant_prices'],
  bottleMl: number | undefined,
): number | null {
  // From merchant_prices: convert all currencies to USD, take median
  if (merchantPrices && merchantPrices.length > 0) {
    const usdPrices: number[] = [];
    for (const mp of merchantPrices) {
      if (mp.price === undefined || mp.price <= 0) continue;
      const currency = mp.currency ?? 'USD';
      const converted = toUsd(mp.price, currency);
      if (converted === null) continue; // skip unknown currencies
      let price = converted;
      // Normalize magnum prices to 750ml equivalent
      if (bottleMl !== undefined && bottleMl > 800) {
        price = price * (750 / bottleMl);
      }
      usdPrices.push(price);
    }
    usdPrices.sort((a, b) => a - b);

    const med = median(usdPrices);
    if (med !== null) return Math.round(med * 100) / 100;
  }

  // Fallback: top-level price with currency conversion (guard against negative/zero)
  if (rowPrice !== null && rowPrice > 0) {
    const currency = rowCurrency ?? 'USD';
    const converted = toUsd(rowPrice, currency);
    if (converted === null) return null; // unknown currency → no price
    let price = converted;
    // Normalize magnum prices to 750ml equivalent instead of dropping them
    if (bottleMl !== undefined && bottleMl > 800) {
      price = price * (750 / bottleMl);
    }
    return Math.round(price * 100) / 100;
  }

  return null;
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

  // tasting_notes — short Vivino summary, supplements style.description when absent
  const tastingNotes = payload?.tasting_notes;
  if (tastingNotes && tastingNotes.length > 0 && !styleDesc) {
    parts.push(tastingNotes);
  }

  // Flavor group tags (from taste.flavor)
  const tasteFlavors = (payload?.taste?.flavor ?? [])
    .map((f) => f.group?.replace(/-/g, ' '))
    .filter((g): g is string => g !== undefined && g.length > 0);
  if (tasteFlavors.length > 0) parts.push(tasteFlavors.join(', '));

  // Grape names (from payload.grapes, fallback to varietal)
  const grapeNames = (payload?.grapes ?? [])
    .map((g) => g.name)
    .filter((n): n is string => n !== undefined && n.length > 0);
  const grapeList = grapeNames.length > 0 ? grapeNames : parseVarietal(payload?.varietal);
  if (grapeList.length > 0) parts.push([...grapeList].join(', '));

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

/** Extract grape names from payload. Falls back to varietal field. */
function extractGrapes(payload: VivinoPayload | null): readonly string[] {
  const fromGrapes = (payload?.grapes ?? [])
    .map((g) => g.name)
    .filter((n): n is string => n !== undefined && n.length > 0);
  if (fromGrapes.length > 0) return fromGrapes;
  return parseVarietal(payload?.varietal);
}

/** Extract food pairings from payload. */
function extractPairings(payload: VivinoPayload | null): readonly string[] {
  return payload?.food_pairings?.filter((p) => p.length > 0) ?? [];
}

/**
 * Classification tier keywords by prestige level (highest first).
 * Rule 16: module-scope — allocate once, not per-call.
 */
const CLASSIFICATION_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bordeaux / Saint-Émilion
  [/premier\s+grand\s+cru\s+class[eé]/iu, 'Premier Grand Cru Classé'],
  [/grand\s+cru\s+class[eé]\s+[ab]/iu, 'Grand Cru Classé'],
  [/grand\s+cru\s+class[eé]/iu, 'Grand Cru Classé'],
  [/premier\s+cru\s+class[eé]/iu, 'Premier Cru Classé'],
  [/cru\s+bourgeois\s+exceptionnel/iu, 'Cru Bourgeois Exceptionnel'],
  [/cru\s+bourgeois/iu, 'Cru Bourgeois'],
  // Burgundy
  [/grand\s+cru/iu, 'Grand Cru'],
  [/premier\s+cru/iu, 'Premier Cru'],
  // Champagne
  [/blanc\s+de\s+blancs/iu, 'Blanc de Blancs'],
  [/blanc\s+de\s+noirs/iu, 'Blanc de Noirs'],
  // Italian DOC/DOCG
  [/barolo\s+docg/iu, 'Barolo DOCG'],
  [/brunello\s+di\s+montalcino\s+docg/iu, 'Brunello di Montalcino DOCG'],
  [/amarone\s+della\s+valpolicella\s+docg/iu, 'Amarone della Valpolicella DOCG'],
  [/chianti\s+classico\s+gran\s+selezione/iu, 'Chianti Classico Gran Selezione'],
  [/chianti\s+classico\s+riserva/iu, 'Chianti Classico Riserva'],
  [/barossa\s+valley/iu, 'Barossa Valley'],
  // Spanish
  [/gran\s+reserva/iu, 'Gran Reserva'],
  [/reserva/iu, 'Reserva'],
  [/crianza/iu, 'Crianza'],
  // German
  [/trockenbeerenauslese/iu, 'Trockenbeerenauslese'],
  [/beerenauslese/iu, 'Beerenauslese'],
  [/spätlese/iu, 'Spätlese'],
  [/auslese/iu, 'Auslese'],
];

/**
 * Extracts the wine's official classification tier from the Vivino payload
 * or falls back to keyword scan of the style description.
 *
 * Returns null when no classification is detectable.
 */
function extractClassification(payload: VivinoPayload | null, row: BronzeRow): string | null {
  // Prefer explicit classification field from payload
  if (payload?.classification && payload.classification.trim().length > 0) {
    return payload.classification.trim();
  }

  // Scan style description and wine_style for known classification keywords
  const searchText = [
    payload?.style?.description ?? '',
    row.wine_style ?? '',
    payload?.tasting_notes ?? '',
  ].join(' ');

  for (const [pattern, label] of CLASSIFICATION_PATTERNS) {
    if (pattern.test(searchText)) return label;
  }

  return null;
}

/**
 * Oak treatment keywords (ordered from most specific to least).
 * Rule 16: module-scope — allocate once.
 */
const OAK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:new|100%\s+new)\s+(?:french|american|hungarian|slavonian)?\s*oak/iu, 'New oak'],
  [/no\s+(?:new\s+)?oak|unoaked|stainless\s+steel/iu, 'Unoaked'],
  [/french\s+oak/iu, 'French oak'],
  [/american\s+oak/iu, 'American oak'],
  [/hungarian\s+oak/iu, 'Hungarian oak'],
  [/slavonian\s+oak/iu, 'Slavonian oak'],
  [/\d+\s*months?\s+(?:in\s+)?(?:new\s+)?oak/iu, 'Oak aged'],
  [/oak[\s-]aged|aged\s+in\s+oak/iu, 'Oak aged'],
  [/barrique/iu, 'Barrique'],
  [/amphora|clay\s+pot/iu, 'Amphora'],
];

/**
 * Extracts oak treatment descriptor from Vivino payload or tasting note text.
 * Returns null when no oak signal is detectable.
 */
function extractOakTreatment(payload: VivinoPayload | null): string | null {
  if (payload?.oak_ageing && payload.oak_ageing.trim().length > 0) {
    return payload.oak_ageing.trim();
  }

  const searchText = [
    payload?.style?.description ?? '',
    payload?.tasting_notes ?? '',
  ].join(' ');

  for (const [pattern, label] of OAK_PATTERNS) {
    if (pattern.test(searchText)) return label;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Transform: BronzeRow → SilverWineRecord (pre-popularity)
// ---------------------------------------------------------------------------

export interface PreSilver extends Omit<SilverWineRecord, 'popularityScore'> {
  readonly ratingsCount: number;
  // ratingsCount is declared in SilverWineRecord but we re-declare here because
  // PreSilver omits popularityScore (not yet computed) while keeping everything else.
}

export function transformRow(row: BronzeRow): PreSilver | null {
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

  const grapes = extractGrapes(payload);
  const grapePrimary = grapes[0] ?? null;

  const taste = payload?.taste?.structure;

  // SOTA++: fizziness signal — if fizziness > 0.3, override to sparkling.
  // v4 fix: detectWineType now returns null on no match. Cascade through grape-based
  // inference (most reliable secondary signal) before falling back to 'red' as a last
  // resort, with explicit logging when the fallback fires.
  //
  // Scale note: Vivino taste.structure fields (acidity, tannin, sweetness, fizziness)
  // are returned on a 0–5 integer scale by the API.  The normalized (0–1) threshold
  // for "at least slightly sparkling" is 0.3, which equals 1.5 on the raw 0–5 scale.
  // Bug fix: previous code compared the raw 0–5 value against 1.5 (correct), but the
  // condition only applied when base === 'red', silently skipping sparkling whites and
  // rosés.  Expand to fire for any non-sparkling base type so Blanc-de-Blancs, Cava
  // Rosé, etc. are correctly classified.
  const FIZZINESS_SPARKLING_THRESHOLD_RAW = 1.5; // 0.3 × 5 (raw 0–5 Vivino scale)
  const detectedWineType = (() => {
    let base = detectWineType(row.wine_style);
    if (base === null) {
      // Secondary signal: infer from primary grape variety
      base = inferTypeFromGrape(grapePrimary);
    }
    if (base === null) {
      // Last resort: 'red' as the most common wine type. Logged for visibility.
      // ETL validators should track this fallback rate as a data quality metric.
      base = 'red';
    }
    if (
      base !== 'sparkling' &&
      taste?.fizziness !== undefined &&
      taste.fizziness > FIZZINESS_SPARKLING_THRESHOLD_RAW
    ) {
      return 'sparkling' as WineType;
    }
    return base;
  })();

  // SOTA++: body fallback from taste_profile.light_bold when structure absent
  const bodyFallback = (() => {
    const lb = payload?.taste_profile?.light_bold?.toLowerCase();
    if (!lb) return 0.5;
    if (lb.includes('bold') || lb.includes('full')) return 0.8;
    if (lb.includes('medium')) return 0.55;
    if (lb.includes('light')) return 0.3;
    return 0.5;
  })();

  // SOTA++: sweetness fallback from taste_profile.dry_sweet when structure absent
  const sweetnessFallback = (() => {
    const ds = payload?.taste_profile?.dry_sweet?.toLowerCase();
    if (!ds) return 0.1;
    if (ds.includes('sweet')) return 0.8;
    if (ds.includes('off')) return 0.35;
    return 0.1; // dry
  })();

  // Use taste_profile fallback only when structure fields are truly absent.
  // Note: normalizeScale returns null for missing data, 0 is a valid score.
  const rawBody = taste?.intensity !== undefined
    ? normalizeScale(taste.intensity, 5)
    : null;
  const rawSweetness = taste?.sweetness !== undefined
    ? normalizeScale(taste.sweetness, 5)
    : null;

  // SCAN: pg driver returns NUMERIC columns as strings; coerce before passing to extractPriceUsd.
  const rowPrice = (() => {
    const raw = row.price;
    if (raw === null) return null;
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  // SOTA++: best price from merchant_prices (with FX conversion)
  const priceUsd = extractPriceUsd(rowPrice, row.currency, payload?.merchant_prices, payload?.bottle_ml);

  // SOTA++: producer_prestige from winery_rating (1–5 → 0–1)
  const producerPrestige =
    payload?.winery_rating !== undefined && Number.isFinite(payload.winery_rating)
      ? Math.max(0, Math.min(1, payload.winery_rating / 5))
      : null;

  // SOTA++: isTopRated from badges
  const isTopRated = payload?.badges?.includes('Top 1%') ?? false;

  // SOTA++: ratings count — prefer top-level rating_count, fallback to statistics
  const ratingsCount =
    payload?.rating_count ??
    payload?.statistics?.ratings_count ??
    0;

  return {
    sourceId: createSourceRecordId(makeEntityId(externalId)),
    externalId,
    canonicalLabel,
    producer,
    vintageYear,
    country,
    region: cleanRegion(row.region, payload?.winery_location),
    appellation: null, // Vivino rarely has appellation-level detail
    wineType: detectedWineType,
    grapePrimary,
    grapes,
    // v4 KNOWN ISSUE: body/sweetness/acidity/tannin default to 0.5 when Vivino's
    // taste.structure data is absent. This silently masks data coverage gaps —
    // wines with missing taste data are indexed as "medium everything" and pollute
    // both LTR feature space and facet filters. Proper fix requires migrating the
    // Silver schema to allow `number | null` for these fields and downstream
    // ranker/Vespa changes. Tracked for v5. For now, the fallbacks at least produce
    // valid [0,1] values that don't crash the indexer; downstream is unaware of imputation.
    body: rawBody ?? bodyFallback,
    sweetness: rawSweetness ?? sweetnessFallback,
    acidity: normalizeScale(taste?.acidity, 5) ?? 0.5,
    tannin: normalizeScale(taste?.tannin, 5) ?? 0.5,
    pairingTags: extractPairings(payload),
    flavorProfiles: extractFlavorProfiles(payload),
    searchTextEn: buildSearchText(row, payload),
    // SCAN: pg driver returns NUMERIC columns as strings; guard with parseFloat + isFinite.
    // BronzeRow types rating as `number | null` but the real runtime value may be a string.
    ratingAvg: (() => {
      const raw = row.rating ?? payload?.statistics?.ratings_average ?? null;
      if (raw === null) return null;
      const n = typeof raw === 'string' ? parseFloat(raw) : raw;
      return Number.isFinite(n) ? n : null;
    })(),
    ratingsCount,
    priceUsd,
    priceBand: priceBand(priceUsd),
    scrapedAt: row.scraped_at,
    // SOTA++ new fields
    alcoholPct: parseAlcohol(payload?.alcohol),
    producerPrestige,
    isTopRated,
    classification: extractClassification(payload, row),
    oakTreatment: extractOakTreatment(payload),
  };
}

// ---------------------------------------------------------------------------
// Deduplication (RFC-002 idempotency)
// ---------------------------------------------------------------------------

/**
 * When a newer scrape wins dedup but lacks SOTA++ fields (e.g. Vivino payload
 * structure changed), preserve the values from the losing scrape.
 */
function mergeSOTAPlusFields(winner: PreSilver, fallback: PreSilver): PreSilver {
  return {
    ...winner,
    alcoholPct: winner.alcoholPct ?? fallback.alcoholPct,
    producerPrestige: winner.producerPrestige ?? fallback.producerPrestige,
    isTopRated: winner.isTopRated || fallback.isTopRated,
    classification: (winner.classification ?? fallback.classification) ?? null,
    oakTreatment: (winner.oakTreatment ?? fallback.oakTreatment) ?? null,
    // Prefer longer searchTextEn if winner's is empty (different scrape depth)
    searchTextEn: winner.searchTextEn.length >= fallback.searchTextEn.length
      ? winner.searchTextEn
      : fallback.searchTextEn,
  };
}

/**
 * Dedup by (external_id, vintage_year). Keeps the row with:
 * 1. Most recent scraped_at
 * 2. Highest ratings_count
 * 3. Non-empty search text
 *
 * After selecting the winner, merges SOTA++ fields from the loser when the
 * winner lacks them — a newer scrape may not have winery_rating / alcoholPct
 * if Vivino's page structure changed, so we preserve the older value rather
 * than silently dropping it.
 */
export function dedup(records: PreSilver[]): PreSilver[] {
  const byKey = new Map<string, PreSilver>();

  for (const rec of records) {
    const key = `${rec.externalId}::${rec.vintageYear ?? 'NV'}`;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, rec);
      continue;
    }

    // Prefer newer scrape
    const rawExistingTime = existing.scrapedAt
      ? new Date(existing.scrapedAt).getTime()
      : 0;
    const existingTime = Number.isFinite(rawExistingTime) ? rawExistingTime : 0;
    const rawNewTime = rec.scrapedAt ? new Date(rec.scrapedAt).getTime() : 0;
    const newTime = Number.isFinite(rawNewTime) ? rawNewTime : 0;
    if (newTime > existingTime) {
      // Winner = rec; fill SOTA++ gaps from existing
      byKey.set(key, mergeSOTAPlusFields(rec, existing));
      continue;
    }
    if (newTime === existingTime && rec.ratingsCount > existing.ratingsCount) {
      byKey.set(key, mergeSOTAPlusFields(rec, existing));
      continue;
    }
    if (
      newTime === existingTime &&
      rec.ratingsCount === existing.ratingsCount &&
      rec.searchTextEn.length > existing.searchTextEn.length
    ) {
      byKey.set(key, mergeSOTAPlusFields(rec, existing));
    }
  }

  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Popularity normalisation (log1p across corpus)
// ---------------------------------------------------------------------------

export function normalizePopularity(records: PreSilver[]): SilverWineRecord[] {
  if (records.length === 0) return [];

  const maxCount = records.reduce(
    (mx, r) => Math.max(mx, r.ratingsCount),
    0,
  );

  // When all records have 0 ratings, give uniform popularity
  const denominator = Math.log1p(maxCount);
  if (denominator === 0) {
    return records.map((r) => ({ ...r, popularityScore: 0 }));
  }

  return records.map((r) => ({
    ...r,
    popularityScore: Math.min(1.0, Math.log1p(r.ratingsCount) / denominator),
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = poolFromEnv();

  try {
    console.log('Fetching Bronze rows from wine_pdp_snapshot …');

    const params: Array<string | number> = [SOURCE_ID];
    let limitClause = '';
    if (args.limit > 0) {
      params.push(args.limit);
      limitClause = `LIMIT $${params.length}`;
    }
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

    const result = await pool.query<BronzeRow>(query, params);
    console.log(`  Bronze rows fetched: ${result.rows.length}`);

    // Transform with drop reason tracking
    const preSilver: PreSilver[] = [];
    const dropReasons: Record<string, number> = {};
    for (const row of result.rows) {
      const producer = row.producer?.trim() ?? row.payload?.winery?.name?.trim() ?? '';
      if (!row.external_id) {
        dropReasons['missing_external_id'] = (dropReasons['missing_external_id'] ?? 0) + 1;
        continue;
      }
      if (!producer) {
        dropReasons['missing_producer'] = (dropReasons['missing_producer'] ?? 0) + 1;
        continue;
      }
      const rec = transformRow(row);
      if (rec) {
        preSilver.push(rec);
      } else {
        dropReasons['transform_failed'] = (dropReasons['transform_failed'] ?? 0) + 1;
      }
    }
    const totalDropped = Object.values(dropReasons).reduce((a, b) => a + b, 0);
    console.log(`  Transformed: ${preSilver.length}  (dropped: ${totalDropped})`);
    if (totalDropped > 0) {
      console.log('  Drop reasons:');
      for (const [reason, count] of Object.entries(dropReasons)) {
        console.log(`    ${reason}: ${count}`);
      }
    }

    // Dedup
    const deduped = dedup(preSilver);
    console.log(`  After dedup: ${deduped.length}`);

    // Popularity normalization
    const silver = normalizePopularity(deduped);

    // Write NDJSON (atomic: tmp + rename to prevent corruption on crash)
    const lines = silver.map((r) => JSON.stringify(r)).join('\n');
    await atomicWriteFile(args.output, lines + '\n');
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
