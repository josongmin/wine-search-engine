#!/usr/bin/env tsx
/**
 * Split Builder: Assigns train/val/gate splits to golden queries while
 * respecting the leakage prevention contract (RFC-017 §2.5).
 *
 * Clustering (split assignment unit):
 * - Non–`no-match`: group by `alias_cluster_id` (producer-prefix collision bucket) so the
 *   same prefix never spans train ↔ gate (matches verify-splits Rule 2).
 * - `no-match`: one cluster per synthetic entity (`no-match::${entity_id}`) so they can
 *   distribute across splits without one giant cluster.
 *
 * Usage:
 *   npx tsx scripts/eval/build-splits.ts
 *   npx tsx scripts/eval/build-splits.ts --input data/golden-queries-bronze.jsonl
 */

import fs from 'node:fs/promises';
import { parseNdjson } from '../etl/ndjson.js';
import type { GoldenQuery } from '../etl/types.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import {
  OFFLINE_EVAL_SILVER_CORPUS,
  requireFixtureCorpusPath,
} from './fixture-corpus-paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_TRAIN = resolveDataPath('data/splits/train.jsonl');
const OUTPUT_VAL = resolveDataPath('data/splits/val.jsonl');
const OUTPUT_GATE = resolveDataPath('data/splits/gate.jsonl');

/** Target split ratios. */
const TRAIN_RATIO = 0.70;
const VAL_RATIO = 0.15;
// gate = 0.15

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { input: string } {
  const defaultInput = requireFixtureCorpusPath(
    OFFLINE_EVAL_SILVER_CORPUS,
    'build-splits default input resolution',
  );
  let input = defaultInput;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' || argv[i] === '-i') input = argv[++i] ?? defaultInput;
  }
  return { input };
}

// ---------------------------------------------------------------------------
// Clustering: Group queries by leakage keys
// ---------------------------------------------------------------------------

interface QueryCluster {
  /** Deterministic cluster key for leakage-safe split assignment. */
  readonly clusterKey: string;
  readonly queries: GoldenQuery[];
}

function buildClusters(queries: readonly GoldenQuery[]): QueryCluster[] {
  const clusterMap = new Map<string, GoldenQuery[]>();

  for (const q of queries) {
    const aliasId = q.leakage_keys.alias_cluster_id;
    const key =
      aliasId === 'no-match'
        ? `no-match::${q.leakage_keys.entity_id}`
        : aliasId;

    const existing = clusterMap.get(key);
    if (existing) {
      existing.push(q);
    } else {
      clusterMap.set(key, [q]);
    }
  }

  return [...clusterMap.entries()].map(([clusterKey, clusterQueries]) => ({
    clusterKey,
    queries: clusterQueries,
  }));
}

// ---------------------------------------------------------------------------
// Split assignment
// ---------------------------------------------------------------------------

type Split = 'train' | 'val' | 'gate';

interface SplitAssignment {
  readonly train: GoldenQuery[];
  readonly val: GoldenQuery[];
  readonly gate: GoldenQuery[];
}

function assignSplits(clusters: readonly QueryCluster[]): SplitAssignment {
  // Sort clusters: earliest query time first, then stable clusterKey (batch runs often share ms)
  const sorted = [...clusters].sort((a, b) => {
    const aTime = Math.min(
      ...a.queries.map((q) => new Date(q.created_at).getTime()),
      Number.POSITIVE_INFINITY,
    );
    const bTime = Math.min(
      ...b.queries.map((q) => new Date(q.created_at).getTime()),
      Number.POSITIVE_INFINITY,
    );
    if (aTime !== bTime) return aTime - bTime;
    return a.clusterKey.localeCompare(b.clusterKey);
  });

  const totalQueries = sorted.reduce((sum, c) => sum + c.queries.length, 0);
  const trainTarget = Math.floor(totalQueries * TRAIN_RATIO);
  const valTarget = Math.floor(totalQueries * VAL_RATIO);

  const train: GoldenQuery[] = [];
  const val: GoldenQuery[] = [];
  const gate: GoldenQuery[] = [];

  let trainCount = 0;
  let valCount = 0;

  for (const cluster of sorted) {
    // Temporal split: earliest → train, middle → val, latest → gate
    let target: Split;
    if (trainCount < trainTarget) {
      target = 'train';
    } else if (valCount < valTarget) {
      target = 'val';
    } else {
      target = 'gate';
    }

    // Assign entire cluster to same split
    for (const q of cluster.queries) {
      if (target === 'train') {
        train.push(q);
        trainCount++;
      } else if (target === 'val') {
        val.push(q);
        valCount++;
      } else {
        gate.push(q);
      }
    }
  }

  return { train, val, gate };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading golden queries from ${args.input} …`);
  const content = await fs.readFile(args.input, 'utf8');
  const { records: queries } = parseNdjson<GoldenQuery>(content, args.input);
  console.log(`  Total queries: ${queries.length}`);

  // Build clusters
  const clusters = buildClusters(queries);
  console.log(`  Clusters: ${clusters.length}`);

  // Assign splits
  const splits = assignSplits(clusters);
  console.log(`  Train: ${splits.train.length}  Val: ${splits.val.length}  Gate: ${splits.gate.length}`);

  // Write
  await fs.mkdir(resolveDataPath('data/splits'), { recursive: true });

  await fs.writeFile(
    OUTPUT_TRAIN,
    splits.train.map((q) => JSON.stringify(q)).join('\n') + '\n',
    'utf8',
  );
  await fs.writeFile(
    OUTPUT_VAL,
    splits.val.map((q) => JSON.stringify(q)).join('\n') + '\n',
    'utf8',
  );
  await fs.writeFile(
    OUTPUT_GATE,
    splits.gate.map((q) => JSON.stringify(q)).join('\n') + '\n',
    'utf8',
  );

  console.log(`\n  Written to:`);
  console.log(`    ${OUTPUT_TRAIN} (${splits.train.length})`);
  console.log(`    ${OUTPUT_VAL} (${splits.val.length})`);
  console.log(`    ${OUTPUT_GATE} (${splits.gate.length})`);
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
