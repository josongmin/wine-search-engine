import { describe, it, expect } from 'vitest';
import {
  CORRUPTED_SNAPSHOT_ID,
  isCorruptedSnapshot,
  type DecisionSnapshot,
} from '../decision-snapshot.js';

describe('CORRUPTED_SNAPSHOT_ID', () => {
  it('is the expected sentinel string', () => {
    expect(CORRUPTED_SNAPSHOT_ID).toBe('__corrupted__');
  });
});

describe('isCorruptedSnapshot', () => {
  const VALID_SNAPSHOT: DecisionSnapshot = {
    snapshot_id: 'snapshot:v2:default:1.0.0:1.0.0:abc123',
    model_versions: { embedding: 'text-embedding-3-small-v1.2' },
    index_versions: { wine_content: '2026-04-01' },
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    response_contract_version: 'search_response_v1',
    feature_flags: { killSwitchLearning: false },
  };

  const CORRUPTED_SENTINEL: DecisionSnapshot = {
    snapshot_id: CORRUPTED_SNAPSHOT_ID,
    model_versions: {},
    index_versions: {},
    policy_rule_version: CORRUPTED_SNAPSHOT_ID,
    threshold_profile_id: CORRUPTED_SNAPSHOT_ID,
    planner_version: CORRUPTED_SNAPSHOT_ID,
    response_contract_version: CORRUPTED_SNAPSHOT_ID,
    feature_flags: {},
  };

  it('returns true for the corrupted sentinel', () => {
    expect(isCorruptedSnapshot(CORRUPTED_SENTINEL)).toBe(true);
  });

  it('returns true for a frozen corrupted sentinel', () => {
    expect(isCorruptedSnapshot(Object.freeze(CORRUPTED_SENTINEL))).toBe(true);
  });

  it('returns true for any object with snapshot_id === __corrupted__', () => {
    expect(isCorruptedSnapshot({ snapshot_id: '__corrupted__' })).toBe(true);
  });

  it('returns false for a valid snapshot', () => {
    expect(isCorruptedSnapshot(VALID_SNAPSHOT)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCorruptedSnapshot(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isCorruptedSnapshot(undefined)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isCorruptedSnapshot('__corrupted__')).toBe(false);
  });

  it('returns false for an empty object', () => {
    expect(isCorruptedSnapshot({})).toBe(false);
  });

  it('returns false for an object with a different snapshot_id', () => {
    expect(isCorruptedSnapshot({ snapshot_id: 'valid-id' })).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isCorruptedSnapshot(42)).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isCorruptedSnapshot([])).toBe(false);
  });
});
