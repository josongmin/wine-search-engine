/**
 * Regression: CORRUPTED_SNAPSHOT_SENTINEL downstream propagation.
 *
 * T-E7-01: parseDecisionSnapshotJsonb now throws CorruptedJsonbError instead
 * of returning the sentinel. The isCorruptedSnapshot guard and CORRUPTED_SNAPSHOT_ID
 * remain in the domain layer for any code that previously stored or cached
 * sentinel snapshots (backward compat for reads from old data). These tests
 * verify:
 *   1. The type guard still works (for migration-period reads)
 *   2. The sentinel constant is still recognized
 *   3. CorruptedJsonbError is thrown on corrupted JSONB input
 */
import { describe, it, expect } from 'vitest';
import {
  CORRUPTED_SNAPSHOT_ID,
  isCorruptedSnapshot,
  type DecisionSnapshot,
} from '../../src/domain/shared/types/decision-snapshot.js';
import {
  parseDecisionSnapshotJsonb,
  CorruptedJsonbError,
} from '../../src/infrastructure/adapter/jsonb-schemas.js';

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
  model_versions: { embedding: 'text-embedding-3-small-v1.2' },
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

  it('isCorruptedSnapshot detects sentinel (backward compat for old stored data)', () => {
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

describe('T-E7-01: parseDecisionSnapshotJsonb throws on corrupted input', () => {
  it('throws CorruptedJsonbError for null input instead of returning sentinel', () => {
    expect(() => parseDecisionSnapshotJsonb(null, 'test')).toThrow(CorruptedJsonbError);
  });

  it('throws CorruptedJsonbError for missing required fields', () => {
    expect(() => parseDecisionSnapshotJsonb({ snapshot_id: 'ok' }, 'test')).toThrow(CorruptedJsonbError);
  });

  it('returns valid snapshot for well-formed input', () => {
    const result = parseDecisionSnapshotJsonb(VALID_SNAPSHOT, 'test');
    expect(result.snapshot_id).toBe(VALID_SNAPSHOT.snapshot_id);
  });

  it('CorruptedJsonbError has correct metadata', () => {
    try {
      parseDecisionSnapshotJsonb({}, 'TestCaller');
      expect.fail('Expected CorruptedJsonbError');
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptedJsonbError);
      const typed = err as CorruptedJsonbError;
      expect(typed.column).toBe('decision_snapshot');
      expect(typed.caller).toBe('TestCaller');
      expect(typed.issues.length).toBeGreaterThan(0);
    }
  });
});
