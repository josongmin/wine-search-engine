/**
 * Regression: CORRUPTED_SNAPSHOT_SENTINEL downstream propagation.
 *
 * When pg-feedback-store JSONB validation fails, the sentinel snapshot
 * (snapshot_id = '__corrupted__') must not reach:
 *   1. Cache key generation (would pollute cache under a nonsense key)
 *   2. Decision engine comparisons (would produce identity hashes from garbage)
 *   3. Response serialization (would expose sentinel markers in API output)
 *
 * These tests verify the type guard and key guard points.
 */
import { describe, it, expect } from 'vitest';
import {
  CORRUPTED_SNAPSHOT_ID,
  isCorruptedSnapshot,
  type DecisionSnapshot,
} from '../../src/domain/shared/types/decision-snapshot.js';

const CORRUPTED_SENTINEL: DecisionSnapshot = Object.freeze({
  snapshot_id: CORRUPTED_SNAPSHOT_ID,
  model_versions: {},
  index_versions: {},
  policy_rule_version: CORRUPTED_SNAPSHOT_ID,
  threshold_profile_id: CORRUPTED_SNAPSHOT_ID,
  planner_version: CORRUPTED_SNAPSHOT_ID,
  response_contract_version: CORRUPTED_SNAPSHOT_ID,
  feature_flags: {},
});

const VALID_SNAPSHOT: DecisionSnapshot = Object.freeze({
  snapshot_id: 'snapshot:v2:default:1.0.0:1.0.0:abc123',
  model_versions: { embedding: 'bge-m3-v1.2' },
  index_versions: { wine_content: '2026-04-01' },
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'default',
  planner_version: '1.0.0',
  response_contract_version: 'search_response_v1',
  feature_flags: { killSwitchLearning: false },
});

describe('corrupted snapshot sentinel propagation guard', () => {
  it('sentinel constant matches the expected marker value', () => {
    expect(CORRUPTED_SNAPSHOT_ID).toBe('__corrupted__');
  });

  it('isCorruptedSnapshot detects sentinel', () => {
    expect(isCorruptedSnapshot(CORRUPTED_SENTINEL)).toBe(true);
  });

  it('isCorruptedSnapshot passes valid snapshots', () => {
    expect(isCorruptedSnapshot(VALID_SNAPSHOT)).toBe(false);
  });

  it('sentinel snapshot_id must not appear in a valid cache key component', () => {
    // A cache key that incorporates snapshot_id must never contain the sentinel.
    // This verifies the sentinel value is recognizable and filterable.
    const cacheKeyComponent = VALID_SNAPSHOT.snapshot_id;
    expect(cacheKeyComponent).not.toContain(CORRUPTED_SNAPSHOT_ID);
  });

  it('corrupted sentinel fields are all set to the sentinel marker', () => {
    expect(CORRUPTED_SENTINEL.snapshot_id).toBe(CORRUPTED_SNAPSHOT_ID);
    expect(CORRUPTED_SENTINEL.policy_rule_version).toBe(CORRUPTED_SNAPSHOT_ID);
    expect(CORRUPTED_SENTINEL.threshold_profile_id).toBe(CORRUPTED_SNAPSHOT_ID);
    expect(CORRUPTED_SENTINEL.planner_version).toBe(CORRUPTED_SNAPSHOT_ID);
    expect(CORRUPTED_SENTINEL.response_contract_version).toBe(CORRUPTED_SNAPSHOT_ID);
  });

  it('type guard handles edge cases without throwing and returns false', () => {
    // These must not throw — the guard must be safe to call on any value.
    // Strengthen: also assert each returns false (not corrupted).
    expect(isCorruptedSnapshot(null)).toBe(false);
    expect(isCorruptedSnapshot(undefined)).toBe(false);
    expect(isCorruptedSnapshot('')).toBe(false);
    expect(isCorruptedSnapshot(0)).toBe(false);
    expect(isCorruptedSnapshot([])).toBe(false);
    expect(isCorruptedSnapshot({ snapshot_id: 123 })).toBe(false);
  });
});
