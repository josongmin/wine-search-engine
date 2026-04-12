#!/usr/bin/env tsx
/**
 * Hard Negative Miner: Identifies confusable entity pairs for evaluation.
 *
 * Three mining strategies:
 * 1. Same-producer confusables (e.g. Antinori → Tignanello vs Solaia)
 * 2. Same-vintage different-chateau (e.g. Margaux 2015 → Palmer 2015)
 * 3. Alias collision (e.g. "Léoville" → 3 châteaux)
 *
 * Output: NDJSON of hard negative pairs for augmenting golden query relevance sets.
 *
 * Usage:
 *   npx tsx scripts/eval/mine-hard-negatives.ts
 *   npx tsx scripts/eval/mine-hard-negatives.ts --fixture-repo ../wine-engine-fixture
 */

import fs from 'node:fs/promises';
import { parseNdjson } from '../etl/ndjson.js';
import type { EnrichedSilverRecord } from '../etl/types.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import {
  buildEntityIdBySourceId,
  loadGoldCanonicalLookupForBuild,
} from '../etl/snapshot-entity-identity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INPUT = resolveDataPath('data/silver-docquery.ndjson');
const DEFAULT_OUTPUT = resolveDataPath('data/hard-negatives.jsonl');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CanonicalEntityIdOf = (record: EnrichedSilverRecord) => string;

interface HardNegativePair {
  readonly strategy: 'same_producer' | 'same_vintage_region' | 'alias_collision';
  readonly query: string;
  readonly positive_entity_id: string;
  readonly negative_entity_ids: readonly string[];
  readonly explanation: string;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  input: string;
  output: string;
  fixtureRepo?: string | undefined;
} {
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;
  let fixtureRepo: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--output' || a === '-o') output = argv[++i] ?? DEFAULT_OUTPUT;
    else if (a === '--fixture-repo') {
      const next = argv[++i];
      if (next != null && next.length > 0) fixtureRepo = next;
    }
  }
  return { input, output, fixtureRepo };
}

// ---------------------------------------------------------------------------
// Strategy 1: Same-producer confusables
// ---------------------------------------------------------------------------

function mineSameProducer(
  records: readonly EnrichedSilverRecord[],
  canonicalEntityId: CanonicalEntityIdOf,
): HardNegativePair[] {
  const byProducer = new Map<string, EnrichedSilverRecord[]>();
  for (const rec of records) {
    const key = rec.producer.toLowerCase().trim();
    if (key.length === 0) continue;
    const existing = byProducer.get(key);
    if (existing) {
      existing.push(rec);
    } else {
      byProducer.set(key, [rec]);
    }
  }

  const pairs: HardNegativePair[] = [];
  for (const [producer, wines] of byProducer) {
    if (wines.length < 2) continue;

    // Pick first wine as "positive", rest as confusable negatives
    const positive = wines[0]!;
    const negatives = wines.slice(1, 5);

    pairs.push({
      strategy: 'same_producer',
      query: positive.producer,
      positive_entity_id: canonicalEntityId(positive),
      negative_entity_ids: negatives.map((n) => canonicalEntityId(n)),
      explanation: `Producer "${producer}" has ${wines.length} wines — query by producer name alone is ambiguous`,
    });
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Strategy 2: Same-vintage different-producer in same region
// ---------------------------------------------------------------------------

function mineSameVintageRegion(
  records: readonly EnrichedSilverRecord[],
  canonicalEntityId: CanonicalEntityIdOf,
): HardNegativePair[] {
  const byVintageRegion = new Map<string, EnrichedSilverRecord[]>();
  for (const rec of records) {
    if (rec.vintageYear === null || !rec.region) continue;
    const key = `${rec.vintageYear}::${rec.region.toLowerCase()}`;
    const existing = byVintageRegion.get(key);
    if (existing) {
      existing.push(rec);
    } else {
      byVintageRegion.set(key, [rec]);
    }
  }

  const pairs: HardNegativePair[] = [];
  for (const [key, wines] of byVintageRegion) {
    if (wines.length < 3) continue; // need meaningful confusable set

    // Pick most popular as "positive"
    const sorted = [...wines].sort(
      (a, b) => b.popularityScore - a.popularityScore,
    );
    const positive = sorted[0]!;
    const negatives = sorted.slice(1, 5);
    const [vintage, region] = key.split('::');

    pairs.push({
      strategy: 'same_vintage_region',
      query: `${region} ${vintage}`,
      positive_entity_id: canonicalEntityId(positive),
      negative_entity_ids: negatives.map((n) => canonicalEntityId(n)),
      explanation: `"${region} ${vintage}" matches ${wines.length} different wines — requires disambiguation`,
    });
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Strategy 3: Alias collision
// ---------------------------------------------------------------------------

function removeAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

function mineAliasCollision(
  records: readonly EnrichedSilverRecord[],
  canonicalEntityId: CanonicalEntityIdOf,
): HardNegativePair[] {
  // Build alias → entity mapping
  const aliasToEntities = new Map<string, EnrichedSilverRecord[]>();

  for (const rec of records) {
    const allAliases = [
      ...rec.aliases.identitySafeProjection,
      ...rec.aliases.noisyRecallProjection,
    ];

    for (const alias of allAliases) {
      const normalized = removeAccents(alias).toLowerCase().trim();
      if (normalized.length < 3) continue;

      const existing = aliasToEntities.get(normalized);
      if (existing) {
        // Only add if different entity
        if (!existing.some((e) => e.sourceId === rec.sourceId)) {
          existing.push(rec);
        }
      } else {
        aliasToEntities.set(normalized, [rec]);
      }
    }
  }

  const pairs: HardNegativePair[] = [];
  for (const [alias, entities] of aliasToEntities) {
    if (entities.length < 2) continue;

    const positive = entities[0]!;
    const negatives = entities.slice(1, 5);

    pairs.push({
      strategy: 'alias_collision',
      query: alias,
      positive_entity_id: canonicalEntityId(positive),
      negative_entity_ids: negatives.map((n) => canonicalEntityId(n)),
      explanation: `Alias "${alias}" collides across ${entities.length} entities: ${entities.map((e) => e.canonicalLabel).join(', ')}`,
    });
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading enriched Silver from ${args.input} …`);
  const content = await fs.readFile(args.input, 'utf8');
  const { records } = parseNdjson<EnrichedSilverRecord>(content, args.input);
  console.log(`  Loaded ${records.length} records`);

  const goldLookup = await loadGoldCanonicalLookupForBuild({ fixtureRepoRoot: args.fixtureRepo });
  const sourceToCanonical = buildEntityIdBySourceId(records, goldLookup);
  const canonicalEntityId: CanonicalEntityIdOf = (r) => {
    const id = sourceToCanonical.get(r.sourceId);
    if (id === undefined) {
      throw new Error(`Missing canonical entity id mapping for sourceId=${r.sourceId}`);
    }
    return id;
  };

  console.log('\nMining hard negatives …');

  const sameProducer = mineSameProducer(records, canonicalEntityId);
  console.log(`  Same-producer:          ${sameProducer.length} pairs`);

  const sameVintageRegion = mineSameVintageRegion(records, canonicalEntityId);
  console.log(`  Same-vintage-region:    ${sameVintageRegion.length} pairs`);

  const aliasCollision = mineAliasCollision(records, canonicalEntityId);
  console.log(`  Alias collision:        ${aliasCollision.length} pairs`);

  const allPairs = [...sameProducer, ...sameVintageRegion, ...aliasCollision];
  console.log(`  Total:                  ${allPairs.length} pairs`);

  const lines = allPairs.map((p) => JSON.stringify(p)).join('\n');
  await fs.writeFile(args.output, lines + '\n', 'utf8');
  console.log(`\n  Written to: ${args.output}`);
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
