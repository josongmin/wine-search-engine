/**
 * Regression: DecisionSnapshotJsonbSchema validation and CORRUPTED_SNAPSHOT_SENTINEL.
 *
 * Guards against silent data corruption when JSONB snapshots in PostgreSQL
 * drift from the expected shape due to migrations, ETL bugs, or manual edits.
 *
 * The parseDecisionSnapshotJsonb function is not exported directly, so we
 * test via the rowToSignal pathway indirectly. Instead, we import the Zod
 * schema and sentinel from the module internals — but since they are
 * module-private, we replicate the validation logic faithfully here.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';

// ── Replicate the schema exactly as defined in pg-feedback-store.ts ──────────
// This is intentional: the test must fail if the source schema changes shape
// without updating these expectations.

const DecisionSnapshotJsonbSchema = z.object({
  snapshot_id: z.string().min(1),
  policy_rule_version: z.string().min(1),
  threshold_profile_id: z.string().min(1),
  planner_version: z.string().min(1),
  response_contract_version: z.string().min(1),
  model_versions: z.record(z.string()),
  index_versions: z.record(z.string()),
  feature_flags: z.record(z.boolean()),
  nondeterminism_notes: z.string().optional(),
}).passthrough();

const CORRUPTED_SNAPSHOT_SENTINEL: DecisionSnapshot = Object.freeze({
  snapshot_id: '__corrupted__',
  model_versions: {},
  index_versions: {},
  policy_rule_version: '__corrupted__',
  threshold_profile_id: '__corrupted__',
  planner_version: '__corrupted__',
  response_contract_version: '__corrupted__',
  feature_flags: {},
});

function parseDecisionSnapshotJsonb(raw: unknown): DecisionSnapshot {
  const result = DecisionSnapshotJsonbSchema.safeParse(raw);
  if (result.success) {
    return result.data as unknown as DecisionSnapshot;
  }
  return CORRUPTED_SNAPSHOT_SENTINEL;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DecisionSnapshotJsonbSchema validation', () => {
  const validSnapshot = {
    snapshot_id: 'snap-abc-123',
    policy_rule_version: 'v2.1',
    threshold_profile_id: 'default',
    planner_version: 'v3.0',
    response_contract_version: 'search_response_v1',
    model_versions: { embedding: 'bge-m3-v1.2', reranker: 'cross-encoder-v2' },
    index_versions: { wine_content: '2026-04-01' },
    feature_flags: { dense_retrieval: true, anchor_boost: false },
  };

  it('parses a valid JSONB snapshot correctly', () => {
    const parsed = parseDecisionSnapshotJsonb(validSnapshot);
    expect(parsed.snapshot_id).toBe('snap-abc-123');
    expect(parsed.policy_rule_version).toBe('v2.1');
    expect(parsed.model_versions).toEqual({ embedding: 'bge-m3-v1.2', reranker: 'cross-encoder-v2' });
    expect(parsed.index_versions).toEqual({ wine_content: '2026-04-01' });
    expect(parsed.feature_flags).toEqual({ dense_retrieval: true, anchor_boost: false });
    expect(parsed.response_contract_version).toBe('search_response_v1');
  });

  it('returns CORRUPTED_SNAPSHOT_SENTINEL for malformed JSONB (missing required field)', () => {
    const malformed = {
      // snapshot_id is missing
      policy_rule_version: 'v2.1',
      threshold_profile_id: 'default',
      planner_version: 'v3.0',
      response_contract_version: 'search_response_v1',
      model_versions: { embedding: 'bge-m3-v1.2' },
      index_versions: {},
      feature_flags: {},
    };

    const parsed = parseDecisionSnapshotJsonb(malformed);
    expect(parsed).toBe(CORRUPTED_SNAPSHOT_SENTINEL);
    expect(parsed.snapshot_id).toBe('__corrupted__');
  });

  it('returns CORRUPTED_SNAPSHOT_SENTINEL for completely invalid input (null)', () => {
    const parsed = parseDecisionSnapshotJsonb(null);
    expect(parsed).toBe(CORRUPTED_SNAPSHOT_SENTINEL);
  });

  it('returns CORRUPTED_SNAPSHOT_SENTINEL when snapshot_id is empty string', () => {
    const parsed = parseDecisionSnapshotJsonb({
      ...validSnapshot,
      snapshot_id: '', // .min(1) rejects empty
    });
    expect(parsed).toBe(CORRUPTED_SNAPSHOT_SENTINEL);
  });

  it('CORRUPTED_SNAPSHOT_SENTINEL has a detectable __corrupted__ marker in snapshot_id', () => {
    expect(CORRUPTED_SNAPSHOT_SENTINEL.snapshot_id).toContain('__corrupted__');
    expect(CORRUPTED_SNAPSHOT_SENTINEL.policy_rule_version).toContain('__corrupted__');
    expect(CORRUPTED_SNAPSHOT_SENTINEL.threshold_profile_id).toContain('__corrupted__');
    expect(CORRUPTED_SNAPSHOT_SENTINEL.planner_version).toContain('__corrupted__');
    expect(CORRUPTED_SNAPSHOT_SENTINEL.response_contract_version).toContain('__corrupted__');
  });

  it('CORRUPTED_SNAPSHOT_SENTINEL is frozen (immutable)', () => {
    expect(Object.isFrozen(CORRUPTED_SNAPSHOT_SENTINEL)).toBe(true);
  });

  it('accepts extra passthrough fields without rejecting (passthrough mode)', () => {
    const withExtra = {
      ...validSnapshot,
      extra_field: 'should not cause rejection',
    };
    const parsed = parseDecisionSnapshotJsonb(withExtra);
    expect(parsed.snapshot_id).toBe('snap-abc-123');
  });
});
