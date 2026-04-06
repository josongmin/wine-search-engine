import { describe, it, expect } from 'vitest';
import {
  buildDeterministicSnapshotId,
  buildDeterministicSnapshotIdV2,
  type BuildSnapshotIdV2Args,
} from '../pg-snapshot-store.js';
import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';
import type { SnapshotVersionContractV2 } from '../../../application/search/snapshot-version-contract.js';

function baseSnapshot(overrides?: Partial<DecisionSnapshot>): DecisionSnapshot {
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

function baseV2Contract(overrides?: Partial<SnapshotVersionContractV2>): SnapshotVersionContractV2 {
  return {
    plannerVersion: 'pl1',
    policyRuleVersion: 'pr1',
    thresholdProfileId: 'tp1',
    executionRoute: 'hybrid',
    retrievalMode: 'entity_lookup',
    ...overrides,
  };
}

function v2Args(
  snapshotOverrides?: Partial<DecisionSnapshot>,
  contractOverrides?: Partial<SnapshotVersionContractV2>,
): BuildSnapshotIdV2Args {
  return {
    snapshot: baseSnapshot(snapshotOverrides),
    versionContract: baseV2Contract(contractOverrides),
  };
}

describe('buildDeterministicSnapshotIdV2', () => {
  it('includes executionRoute and retrievalMode in the ID', () => {
    const id = buildDeterministicSnapshotIdV2(v2Args());
    expect(id).toMatch(/^snapshot:v2:tp1:pl1:pr1:hybrid:entity_lookup:[a-f0-9]{64}$/);
  });

  it('is deterministic — same input produces same output', () => {
    const a = buildDeterministicSnapshotIdV2(v2Args());
    const b = buildDeterministicSnapshotIdV2(v2Args());
    expect(a).toBe(b);
  });

  it('changes when executionRoute changes', () => {
    const a = buildDeterministicSnapshotIdV2(v2Args());
    const b = buildDeterministicSnapshotIdV2(v2Args(undefined, { executionRoute: 'exact' }));
    expect(a).not.toBe(b);
  });

  it('changes when retrievalMode changes', () => {
    const a = buildDeterministicSnapshotIdV2(v2Args());
    const b = buildDeterministicSnapshotIdV2(
      v2Args(undefined, { retrievalMode: 'semantic_search' }),
    );
    expect(a).not.toBe(b);
  });

  it('changes when a shared version field changes', () => {
    const a = buildDeterministicSnapshotIdV2(v2Args());
    const b = buildDeterministicSnapshotIdV2(v2Args(undefined, { plannerVersion: 'pl2' }));
    expect(a).not.toBe(b);
  });

  it('produces IDs distinct from V1 IDs (different schema version prefix)', () => {
    const snap = baseSnapshot();
    const v1Id = buildDeterministicSnapshotId(snap);
    const v2Id = buildDeterministicSnapshotIdV2(v2Args());

    expect(v1Id).toMatch(/^snapshot:v1:/);
    expect(v2Id).toMatch(/^snapshot:v2:/);
    expect(v1Id).not.toBe(v2Id);
  });

  it('V1 and V2 IDs are never equal even with matching shared fields', () => {
    // Confirm structural distinctness: schema version alone makes them different.
    const snap = baseSnapshot();
    const v1Id = buildDeterministicSnapshotId(snap);
    const v2Id = buildDeterministicSnapshotIdV2({
      snapshot: snap,
      versionContract: baseV2Contract({
        plannerVersion: snap.planner_version,
        policyRuleVersion: snap.policy_rule_version,
        thresholdProfileId: snap.threshold_profile_id,
      }),
    });
    expect(v1Id).not.toBe(v2Id);
  });
});
