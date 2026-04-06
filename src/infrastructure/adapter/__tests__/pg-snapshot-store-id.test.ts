import { describe, it, expect } from 'vitest';
import { buildDeterministicSnapshotId } from '../pg-snapshot-store.js';
import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';

function snap(overrides?: Partial<DecisionSnapshot>): DecisionSnapshot {
  return {
    model_versions: { e: '1' },
    index_versions: { wine_content: '2026-01-01' },
    policy_rule_version: 'pr1',
    threshold_profile_id: 'tp1',
    planner_version: 'pl1',
    feature_flags: { f: true },
    ...overrides,
  };
}

describe('buildDeterministicSnapshotId', () => {
  it('is stable for identical snapshot content', () => {
    const a = buildDeterministicSnapshotId(snap());
    const b = buildDeterministicSnapshotId(snap());
    expect(a).toBe(b);
    expect(a).toMatch(/^snapshot:v1:tp1:pl1:pr1:[a-f0-9]{64}$/);
  });

  it('changes when policy version changes', () => {
    const a = buildDeterministicSnapshotId(snap());
    const b = buildDeterministicSnapshotId(snap({ policy_rule_version: 'pr2' }));
    expect(a).not.toBe(b);
  });
});
