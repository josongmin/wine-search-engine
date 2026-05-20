/**
 * Golden query train/val/gate leakage checks (RFC-017 §2.5).
 * Shared by `verify-splits.ts` CLI and `run-offline-eval.ts` (--verify-splits).
 */

import fs from 'node:fs/promises';
import { parseNdjson } from '../etl/ndjson.js';
import type { GoldenQuery } from '../etl/types.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';

export const DEFAULT_SPLIT_PATHS = {
  train: resolveDataPath('data/splits/train.jsonl'),
  val: resolveDataPath('data/splits/val.jsonl'),
  gate: resolveDataPath('data/splits/gate.jsonl'),
} as const;

export interface SplitIntegrityResult {
  readonly valid: boolean;
  readonly violations: readonly string[];
  readonly stats: {
    readonly train: number;
    readonly val: number;
    readonly gate: number;
  };
}

export async function loadGoldenQueriesFromFile(path: string): Promise<GoldenQuery[]> {
  try {
    const content = await fs.readFile(path, 'utf8');
    return parseNdjson<GoldenQuery>(content, path).records;
  } catch {
    return [];
  }
}

/**
 * Verifies split integrity for pre-loaded query arrays.
 */
export function verifyGoldenSplitIntegrity(
  train: readonly GoldenQuery[],
  val: readonly GoldenQuery[],
  gate: readonly GoldenQuery[],
): SplitIntegrityResult {
  const violations: string[] = [];

  const trainEntityIds = new Set(train.map((q) => q.leakage_keys.entity_id));
  const valEntityIds = new Set(val.map((q) => q.leakage_keys.entity_id));
  const gateEntityIds = new Set(gate.map((q) => q.leakage_keys.entity_id));

  const trainAliasClusters = new Set(train.map((q) => q.leakage_keys.alias_cluster_id));
  const gateAliasClusters = new Set(gate.map((q) => q.leakage_keys.alias_cluster_id));

  for (const eid of gateEntityIds) {
    if (trainEntityIds.has(eid)) {
      violations.push(`ENTITY_LEAK: entity_id "${eid}" in both train and gate`);
    }
    if (valEntityIds.has(eid)) {
      violations.push(`ENTITY_LEAK: entity_id "${eid}" in both val and gate`);
    }
  }

  for (const cluster of gateAliasClusters) {
    if (cluster === 'no-match') continue;
    if (trainAliasClusters.has(cluster)) {
      violations.push(`ALIAS_LEAK: alias_cluster_id "${cluster}" in both train and gate`);
    }
  }

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

/**
 * Loads default split files and runs {@link verifyGoldenSplitIntegrity}.
 */
export async function verifyDefaultGoldenSplits(): Promise<SplitIntegrityResult> {
  const train = await loadGoldenQueriesFromFile(DEFAULT_SPLIT_PATHS.train);
  const val = await loadGoldenQueriesFromFile(DEFAULT_SPLIT_PATHS.val);
  const gate = await loadGoldenQueriesFromFile(DEFAULT_SPLIT_PATHS.gate);
  return verifyGoldenSplitIntegrity(train, val, gate);
}
