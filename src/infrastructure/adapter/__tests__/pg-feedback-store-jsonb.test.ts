/**
 * Regression: DecisionSnapshotJsonbSchema validation — loud failure on corrupted JSONB.
 *
 * T-E7-01: parseDecisionSnapshotJsonb now throws CorruptedJsonbError instead of
 * returning a silent CORRUPTED_SNAPSHOT_SENTINEL. These tests verify the throw
 * behavior and that valid input still parses correctly.
 */
import { describe, it, expect } from 'vitest';
import {
  parseDecisionSnapshotJsonb,
  CorruptedJsonbError,
} from '../jsonb-schemas.js';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DecisionSnapshotJsonbSchema validation (loud failure)', () => {
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
    const parsed = parseDecisionSnapshotJsonb(validSnapshot, 'test');
    expect(parsed.snapshot_id).toBe('snap-abc-123');
    expect(parsed.policy_rule_version).toBe('v2.1');
    expect(parsed.model_versions).toEqual({ embedding: 'bge-m3-v1.2', reranker: 'cross-encoder-v2' });
    expect(parsed.index_versions).toEqual({ wine_content: '2026-04-01' });
    expect(parsed.feature_flags).toEqual({ dense_retrieval: true, anchor_boost: false });
    expect(parsed.response_contract_version).toBe('search_response_v1');
  });

  it('throws CorruptedJsonbError for malformed JSONB (missing required field)', () => {
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

    expect(() => parseDecisionSnapshotJsonb(malformed, 'test')).toThrow(CorruptedJsonbError);
    expect(() => parseDecisionSnapshotJsonb(malformed, 'test')).toThrow(/decision_snapshot/);
  });

  it('throws CorruptedJsonbError for completely invalid input (null)', () => {
    expect(() => parseDecisionSnapshotJsonb(null, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError when snapshot_id is empty string', () => {
    expect(() => parseDecisionSnapshotJsonb({
      ...validSnapshot,
      snapshot_id: '', // .min(1) rejects empty
    }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('CorruptedJsonbError carries column, caller, and issues metadata', () => {
    try {
      parseDecisionSnapshotJsonb(null, 'PgFeedbackStore');
      expect.fail('Expected CorruptedJsonbError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptedJsonbError);
      const typed = err as CorruptedJsonbError;
      expect(typed.column).toBe('decision_snapshot');
      expect(typed.caller).toBe('PgFeedbackStore');
      expect(typed.issues.length).toBeGreaterThan(0);
      expect(typed.name).toBe('CorruptedJsonbError');
    }
  });

  it('accepts extra passthrough fields without rejecting (passthrough mode)', () => {
    const withExtra = {
      ...validSnapshot,
      extra_field: 'should not cause rejection',
    };
    const parsed = parseDecisionSnapshotJsonb(withExtra, 'test');
    expect(parsed.snapshot_id).toBe('snap-abc-123');
  });
});
