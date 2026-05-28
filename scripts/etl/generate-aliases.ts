#!/usr/bin/env tsx
/**
 * Alias Generator: Reads Silver NDJSON, produces typed ProposedAlias bundles
 * per entity, and writes enriched Silver records to NDJSON.
 *
 * RFC-003 compliant: aliases are typed proposals with lineage tracking.
 * Projection arrays (identitySafe, noisyRecall) are derived from typed proposals.
 *
 * Usage:
 *   npx tsx scripts/etl/generate-aliases.ts
 *   npx tsx scripts/etl/generate-aliases.ts --input data/silver.ndjson --output data/silver-aliases.ndjson
 */

import fs from 'node:fs/promises';
import type {
  SilverWineRecord,
  EnrichedSilverRecord,
  ProposedAlias,
  AliasBundle,
} from './types.js';
import { parseNdjson } from './ndjson.js';
import { atomicWriteFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.silver;
export const DEFAULT_OUTPUT = ETL_ARTIFACT_FILES.aliases;

/** Confidence thresholds for projection decisions. */
const IDENTITY_SAFE_THRESHOLD = 0.80;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  output: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--output' || a === '-o') out.output = argv[++i] ?? DEFAULT_OUTPUT;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: generate-aliases.ts [--input PATH] [--output PATH]');
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Accent folding (Château → Chateau, Müller → Muller)
// ---------------------------------------------------------------------------

/**
 * Removes combining diacritical marks from Latin characters.
 * Preserves CJK characters untouched (important for Korean).
 */
function removeAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

// ---------------------------------------------------------------------------
// Short name extraction
// ---------------------------------------------------------------------------

const CHATEAU_PREFIXES = [
  'château', 'chateau', 'domaine', 'domain', 'maison',
  'tenuta', 'cantina', 'bodega', 'weingut', 'cave',
  'villa', 'clos', 'quinta', 'casa', 'fattoria', 'azienda',
  'bodegas', 'viña', 'vina',
];

/**
 * Extracts a short name from the producer.
 * "Château Margaux" → "Margaux"
 * "Opus One Winery" → "Opus One"
 */
function extractShortName(producer: string): string | null {
  // NFC-normalize before lowercasing so NFD-decomposed inputs (e.g. "Château".normalize('NFD'))
  // match the NFC-encoded CHATEAU_PREFIXES entries (e.g. 'château'). Without NFC the
  // startsWith() comparison fails for any producer name with precomposed accented characters.
  const lower = producer.normalize('NFC').toLowerCase();

  // Remove common prefixes
  for (const prefix of CHATEAU_PREFIXES) {
    if (lower.startsWith(prefix + ' ')) {
      const rest = producer.slice(prefix.length + 1).trim();
      if (rest.length > 0) return rest;
    }
  }

  // Remove trailing "Winery", "Vineyards", etc.
  const suffixes = /\s+(winery|vineyards?|cellars?|estate|wines?|vini|vinicola|cooperative|s\.?a\.?)$/i;
  const stripped = producer.replace(suffixes, '').trim();
  if (stripped.length > 0 && stripped !== producer) return stripped;

  return null;
}

// ---------------------------------------------------------------------------
// Alias generation
// ---------------------------------------------------------------------------

export function generateAliases(record: SilverWineRecord): AliasBundle {
  const proposed: ProposedAlias[] = [];

  // 1. Accent-folded label (e.g. Château → Chateau)
  const folded = removeAccents(record.canonicalLabel);
  if (folded !== record.canonicalLabel) {
    proposed.push({
      value: folded,
      type: 'translation',
      source: 'rule:accent_fold_v1',
      confidencePrior: 0.92,
      needsReview: false,
    });
  }

  // 2. Accent-folded producer
  const foldedProducer = removeAccents(record.producer);
  if (foldedProducer !== record.producer) {
    proposed.push({
      value: foldedProducer,
      type: 'translation',
      source: 'rule:accent_fold_producer_v1',
      confidencePrior: 0.90,
      needsReview: false,
    });
  }

  // 3. Short producer name ("Château Margaux" → "Margaux")
  const shortName = extractShortName(record.producer);
  if (shortName) {
    proposed.push({
      value: shortName,
      type: 'catalog_noise_alias',
      source: 'rule:short_name_v1',
      confidencePrior: 0.40,
      needsReview: true,
    });
  }

  // 4. Label without vintage (for vintage-agnostic search).
  //
  // This MUST be anchored to the canonical wine label, not the producer
  // field. Producer-only aliases are not identity-safe for wine entities:
  // they collide across sibling wines from the same producer
  // ("Opus One" vs "Overture", multiple vintages, etc.). The
  // vintage-stripped canonical label stays attached to a specific wine label.
  //    Use Unicode-safe boundary assertions (CLAUDE.md Rule 8, Rule 24):
  //    \b is ASCII-only and silently fails on non-ASCII boundaries.
  //    (?<![\\p{L}\\p{N}]) / (?![\\p{L}\\p{N}]) match any Unicode letter-or-digit boundary.
  //    Vintage years are always 4 ASCII digits, but Korean wine names often appear
  //    adjacent to the year (e.g. "보르도 2015"), so Unicode-safe boundaries prevent
  //    false removal of "2015" in "20150" or similar edge cases across locales.
  if (record.vintageYear !== null) {
    const yearPattern = new RegExp(`(?<![\\p{L}\\p{N}])${record.vintageYear}(?![\\p{L}\\p{N}])`, 'gu');
    const noVintage = record.canonicalLabel
      .replace(yearPattern, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (noVintage.length > 0 && noVintage !== record.canonicalLabel) {
      proposed.push({
        value: noVintage,
        type: 'translation',
        source: 'rule:no_vintage_v1',
        confidencePrior: 0.85,
        needsReview: false,
      });
    }
  }

  // 5. Primary grape + region (recall alias)
  if (record.grapePrimary && record.region) {
    proposed.push({
      value: `${record.region} ${record.grapePrimary}`,
      type: 'catalog_noise_alias',
      source: 'rule:region_grape_v1',
      confidencePrior: 0.25,
      needsReview: true,
    });
  }

  // Build projections from proposed aliases (deduplicated)
  const identitySafeProjection = [...new Set(
    proposed
      .filter((a) => a.confidencePrior >= IDENTITY_SAFE_THRESHOLD && !a.needsReview)
      .map((a) => a.value),
  )];

  const noisyRecallProjection = [...new Set(
    proposed
      .filter((a) => a.confidencePrior < IDENTITY_SAFE_THRESHOLD || a.needsReview)
      .map((a) => a.value),
  )];

  return { proposed, identitySafeProjection, noisyRecallProjection };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading Silver records from ${args.input} …`);
  const content = await fs.readFile(args.input, 'utf8');
  const { records, skipped } = parseNdjson<SilverWineRecord>(content, args.input);
  if (skipped > 0) console.warn(`  Skipped ${skipped} malformed lines`);

  console.log(`  Loaded ${records.length} Silver records`);

  const enriched: EnrichedSilverRecord[] = records.map((rec) => ({
    ...rec,
    aliases: generateAliases(rec),
  }));

  // Stats
  const totalAliases = enriched.reduce(
    (sum, r) => sum + r.aliases.proposed.length,
    0,
  );
  const meanAliases = enriched.length > 0 ? totalAliases / enriched.length : 0;
  const needsReview = enriched.reduce(
    (sum, r) => sum + r.aliases.proposed.filter((a) => a.needsReview).length,
    0,
  );

  console.log(`  Total aliases: ${totalAliases}  (mean: ${meanAliases.toFixed(1)}/entity)`);
  console.log(`  Needs review: ${needsReview}`);

  const lines = enriched.map((r) => JSON.stringify(r)).join('\n');
  await atomicWriteFile(args.output, lines + '\n');
  console.log(`  Written to: ${args.output}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
