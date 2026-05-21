/**
 * Golden query train/val/gate leakage checks (RFC-017 §2.5).
 * Shared by `verify-splits.ts` CLI and `run-offline-eval.ts` (--verify-splits).
 *
 * SOTA++ extension (maturity 5): entity-synonym group leakage detection +
 * property-based invariants. The new {@link groupQueriesByEntity} helper
 * and {@link assignSplitsByEntityGroup} routine elevate split assignment
 * from per-query dedup to per-entity-group dedup so vintage / template
 * variants (e.g. "Opus One" vs "Opus One 2018") cannot leak across splits.
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

/**
 * Minimum allowed split size before a split is considered degenerate.
 * Domain justification: with k=3 splits and 70/15/15 ratios, even the
 * smallest (val / gate) must hold enough queries for stable LTR / eval
 * signal — under 10 queries the metric variance dominates the signal.
 * Surfaced as a named constant per CLAUDE.md test discipline rule 15.
 */
export const SPLIT_INTEGRITY_MIN_SPLIT_SIZE = 10;

/**
 * Canonical field name used as the entity-group key when partitioning
 * queries for leakage-safe split assignment. Sourced from
 * `GoldenQuery.leakage_keys.entity_id` — the canonical entity id assigned
 * by entity resolution before split-builder runs. Surfaced as a named
 * constant so callers and tests don't hard-code a magic field name.
 */
export const SPLIT_INTEGRITY_ENTITY_GROUP_KEY_FN = 'canonical_entity_id';

/**
 * Approximate train/val/gate ratios used by {@link assignSplitsByEntityGroup}.
 * Mirrors the targets in `build-splits.ts` (70/15/15). Kept here so the
 * leakage-safe assignment helper is usable standalone in tests / offline
 * tooling without round-tripping through the file-system builder.
 */
const SPLIT_INTEGRITY_TARGET_RATIOS = {
  train: 0.7,
  val: 0.15,
  gate: 0.15,
} as const;

/**
 * Builds an entity-group key for a query. Queries with a non-empty
 * `entity_id` share the same group key (so vintage / template variants
 * co-locate). Queries with an empty `entity_id` fall back to a qid-scoped
 * key so distinct empty-entity queries are NOT collapsed into one group.
 */
function entityGroupKey(q: GoldenQuery): string {
  const eid = q.leakage_keys.entity_id;
  if (eid === '') return `__qid__::${q.qid}`;
  return eid;
}

/**
 * Groups a list of golden queries by their canonical entity_id. Queries
 * with empty entity_id fall back to one group per qid so they are not
 * collapsed together.
 *
 * Pure / deterministic: iteration order of the returned map follows
 * first-seen insertion order of the input array.
 */
export function groupQueriesByEntity(
  queries: readonly GoldenQuery[],
): Map<string, GoldenQuery[]> {
  const groups = new Map<string, GoldenQuery[]>();
  for (const q of queries) {
    const key = entityGroupKey(q);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [q]);
    } else {
      bucket.push(q);
    }
  }
  return groups;
}

/**
 * Deterministic 32-bit hash (FNV-1a) over a string. Used to derive a
 * stable per-group ordering keyed by `(seed, groupKey)` so split
 * assignment is referentially transparent for a given `(queries, seed)`
 * pair. Not cryptographic — only used for shuffle-derived ordering.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Leakage-safe split assignment at the entity-group level.
 *
 * Invariants (verified by `split-integrity-entity-leakage.regression.test.ts`):
 *  - All queries sharing a non-empty `entity_id` land in the same split.
 *  - No qid appears in more than one split.
 *  - Same `(queries, seed)` input yields byte-identical splits.
 *  - Empty input → empty splits, never throws.
 *  - The split assignment does not depend on `retrieval_labels` (gold
 *    label) — only on the group key.
 */
export function assignSplitsByEntityGroup(
  queries: readonly GoldenQuery[],
  seed: number,
): {
  readonly train: readonly GoldenQuery[];
  readonly val: readonly GoldenQuery[];
  readonly gate: readonly GoldenQuery[];
} {
  if (queries.length === 0) {
    return { train: [], val: [], gate: [] };
  }

  const groups = groupQueriesByEntity(queries);

  // Stable ordering: rank groups by (fnv1a32(seed::groupKey), groupKey).
  // The seed perturbs the order; the groupKey tiebreak guarantees the
  // sort is total and deterministic.
  const seedString = `${seed}`;
  const ordered = [...groups.entries()].sort((a, b) => {
    const ha = fnv1a32(`${seedString}::${a[0]}`);
    const hb = fnv1a32(`${seedString}::${b[0]}`);
    if (ha !== hb) return ha - hb;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  const totalQueries = queries.length;
  // Target sizes by ratio. With 70/15/15 splits and small N the ratio-only
  // approach can starve val/gate below SPLIT_INTEGRITY_MIN_SPLIT_SIZE, so
  // when there are enough total queries we floor val and gate to MIN before
  // distributing the remainder to train. Below the threshold the ratios
  // win — the property test pre-conditions on a sufficiently large N.
  const minSize = SPLIT_INTEGRITY_MIN_SPLIT_SIZE;
  const enoughForMin = totalQueries >= 3 * minSize;
  const valTarget = enoughForMin
    ? Math.max(Math.floor(totalQueries * SPLIT_INTEGRITY_TARGET_RATIOS.val), minSize)
    : Math.floor(totalQueries * SPLIT_INTEGRITY_TARGET_RATIOS.val);
  const gateTarget = enoughForMin
    ? Math.max(Math.floor(totalQueries * SPLIT_INTEGRITY_TARGET_RATIOS.gate), minSize)
    : Math.floor(totalQueries * SPLIT_INTEGRITY_TARGET_RATIOS.gate);
  // train absorbs the remainder; never negative because val+gate ≤ 2*MIN ≤
  // (2/3)*totalQueries under enoughForMin.
  const trainTarget = Math.max(totalQueries - valTarget - gateTarget, 0);

  const train: GoldenQuery[] = [];
  const val: GoldenQuery[] = [];
  const gate: GoldenQuery[] = [];

  // Fill val first, then gate, then train. Filling minority splits first
  // protects them from being starved when the final group is oversized.
  for (const [, bucket] of ordered) {
    if (val.length < valTarget) {
      val.push(...bucket);
    } else if (gate.length < gateTarget) {
      gate.push(...bucket);
    } else if (train.length < trainTarget) {
      train.push(...bucket);
    } else {
      // Overflow falls into train so we never drop queries.
      train.push(...bucket);
    }
  }

  return { train, val, gate };
}

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

  // SOTA++ extension: also check train↔val. The base rules historically
  // only fenced gate, but the entity-group invariant (no canonical entity
  // spans split boundaries) must hold across every pair. Empty entity_id
  // is excluded since it's the synthetic / exploration fallback bucket
  // and intentionally non-canonical.
  for (const eid of valEntityIds) {
    if (eid === '') continue;
    if (trainEntityIds.has(eid)) {
      violations.push(`ENTITY_LEAK: entity_id "${eid}" in both train and val`);
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
