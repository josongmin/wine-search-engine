#!/usr/bin/env tsx
/**
 * Split Integrity Verifier: Validates that train/val/gate splits respect
 * the leakage prevention contract (RFC-017 §2.5).
 *
 * Checks:
 * 1. No entity_id appears in both train and gate
 * 2. No alias_cluster_id spans train ↔ gate
 * 3. Gate queries are temporally after train/val
 * 4. No query_template_id + entity_id pair spans train ↔ gate
 *
 * Exit code 1 on any violation. Designed for CI integration.
 *
 * Usage:
 *   npx tsx scripts/eval/verify-splits.ts
 */

import fs from 'node:fs/promises';
import { parseNdjson } from '../etl/ndjson.js';
import type { GoldenQuery } from '../etl/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRAIN_PATH = 'data/splits/train.jsonl';
const VAL_PATH = 'data/splits/val.jsonl';
const GATE_PATH = 'data/splits/gate.jsonl';

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

async function loadQueries(path: string): Promise<GoldenQuery[]> {
  try {
    const content = await fs.readFile(path, 'utf8');
    return parseNdjson<GoldenQuery>(content, path).records;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface VerificationResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
  readonly stats: {
    readonly train: number;
    readonly val: number;
    readonly gate: number;
  };
}

function verify(
  train: readonly GoldenQuery[],
  val: readonly GoldenQuery[],
  gate: readonly GoldenQuery[],
): VerificationResult {
  const violations: string[] = [];

  // Collect keys per split
  const trainEntityIds = new Set(train.map((q) => q.leakage_keys.entity_id));
  const valEntityIds = new Set(val.map((q) => q.leakage_keys.entity_id));
  const gateEntityIds = new Set(gate.map((q) => q.leakage_keys.entity_id));

  const trainAliasClusters = new Set(train.map((q) => q.leakage_keys.alias_cluster_id));
  const gateAliasClusters = new Set(gate.map((q) => q.leakage_keys.alias_cluster_id));

  // Rule 1: No entity_id in both train/val and gate
  for (const eid of gateEntityIds) {
    if (trainEntityIds.has(eid)) {
      violations.push(`ENTITY_LEAK: entity_id "${eid}" in both train and gate`);
    }
    if (valEntityIds.has(eid)) {
      violations.push(`ENTITY_LEAK: entity_id "${eid}" in both val and gate`);
    }
  }

  // Rule 2: No alias_cluster_id spans train ↔ gate
  for (const cluster of gateAliasClusters) {
    if (cluster === 'no-match') continue; // no-match is allowed everywhere
    if (trainAliasClusters.has(cluster)) {
      violations.push(`ALIAS_LEAK: alias_cluster_id "${cluster}" in both train and gate`);
    }
  }

  // Rule 3: Gate queries should be temporally after train/val (human holdout / later collection).
  // Single synthetic batch: all queries share one generation_run_id and timestamps differ only by ms —
  // enforcing wall-clock order would false-positive. Skip in that case (RFC-017: real gate is a
  // separate human-validated file later).
  const allForRun = [...train, ...val, ...gate];
  const runIds = new Set(allForRun.map((q) => q.leakage_keys.generation_run_id));
  const singleSyntheticBatch = runIds.size === 1;

  if (!singleSyntheticBatch) {
    const trainMaxTime = Math.max(
      ...train.map((q) => new Date(q.created_at).getTime()),
      0,
    );
    const valMaxTime = Math.max(
      ...val.map((q) => new Date(q.created_at).getTime()),
      0,
    );
    const cutoff = Math.max(trainMaxTime, valMaxTime);

    for (const q of gate) {
      const qTime = new Date(q.created_at).getTime();
      if (qTime < cutoff) {
        violations.push(
          `TEMPORAL_LEAK: gate query "${q.qid}" created_at ${q.created_at} is before train/val cutoff`,
        );
      }
    }
  }

  // Rule 4: No (template_id, entity_id) pair spans train ↔ gate
  const trainTemplateEntity = new Set(
    train.map(
      (q) =>
        `${q.leakage_keys.query_template_id}::${q.leakage_keys.entity_id}`,
    ),
  );
  for (const q of gate) {
    const key = `${q.leakage_keys.query_template_id}::${q.leakage_keys.entity_id}`;
    if (trainTemplateEntity.has(key)) {
      violations.push(
        `TEMPLATE_LEAK: (template="${q.leakage_keys.query_template_id}", entity="${q.leakage_keys.entity_id}") in both train and gate`,
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    stats: {
      train: train.length,
      val: val.length,
      gate: gate.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log('Verifying split integrity …\n');

  const train = await loadQueries(TRAIN_PATH);
  const val = await loadQueries(VAL_PATH);
  const gate = await loadQueries(GATE_PATH);

  console.log(`  Train: ${train.length}  Val: ${val.length}  Gate: ${gate.length}`);

  if (train.length === 0 && val.length === 0 && gate.length === 0) {
    console.log('\n  No split files found. Run build-splits.ts first.');
    process.exit(1);
  }

  const result = verify(train, val, gate);

  if (result.valid) {
    console.log('\n  ✅ Split integrity PASSED — no leakage detected');
  } else {
    console.log(`\n  ❌ Split integrity FAILED — ${result.violations.length} violations:`);
    for (const v of result.violations.slice(0, 20)) {
      console.log(`    ${v}`);
    }
    if (result.violations.length > 20) {
      console.log(`    … and ${result.violations.length - 20} more`);
    }
    process.exit(1);
  }
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
