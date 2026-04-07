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
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { atomicWriteFile } from './etl-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = resolveDataPath('data/silver.ndjson');
export const DEFAULT_OUTPUT = resolveDataPath('data/silver-aliases.ndjson');

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
  const lower = producer.toLowerCase();

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

  // 1. Producer identity (high confidence)
  if (record.producer.length > 0) {
    proposed.push({
      value: record.producer,
      type: 'translation',
      source: 'rule:producer_identity_v1',
      confidencePrior: 0.95,
      needsReview: false,
    });
  }

  // 2. Producer + vintage
  if (record.producer.length > 0 && record.vintageYear !== null) {
    proposed.push({
      value: `${record.producer} ${record.vintageYear}`,
      type: 'translation',
      source: 'rule:producer_vintage_v1',
      confidencePrior: 0.95,
      needsReview: false,
    });
  }

  // 3. Accent-folded label (e.g. Château → Chateau)
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

  // 4. Accent-folded producer
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

  // 5. Short producer name ("Château Margaux" → "Margaux")
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

  // 6. Label without vintage (for vintage-agnostic search).
  //    Use word-boundary regex to avoid matching the year as a substring
  //    (e.g. "2015" in "20150" or similar edge cases).
  if (record.vintageYear !== null) {
    const yearPattern = new RegExp(`\\b${record.vintageYear}\\b`, 'g');
    const noVintage = record.canonicalLabel
      .replace(yearPattern, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (noVintage.length > 0 && noVintage !== record.producer) {
      proposed.push({
        value: noVintage,
        type: 'translation',
        source: 'rule:no_vintage_v1',
        confidencePrior: 0.85,
        needsReview: false,
      });
    }
  }

  // 7. Primary grape + region (recall alias)
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
