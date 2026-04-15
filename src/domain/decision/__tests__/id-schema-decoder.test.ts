import { describe, expect, it } from 'vitest';
import { buildAuthorityTraceRef } from '../service/authority-trace.js';
import {
  decodeAuthorityTraceRef,
  decodeBatchId,
  decodeSnapshotId,
} from '../service/id-schema-decoder.js';
import { buildDeterministicSnapshotId, buildDeterministicSnapshotIdV2 } from '../../../infrastructure/adapter/pg-snapshot-store.js';
import type { DecisionSnapshot } from '../../shared/types/index.js';
import { deterministicHash } from '../../shared/utils/hash.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';

function makeSnapshot(): DecisionSnapshot {
  return {
    model_versions: { embedding: 'bge-m3' },
    index_versions: { wine_content: '2026-04-07' },
    policy_rule_version: 'policy-v1',
    threshold_profile_id: 'default-v2',
    planner_version: 'planner-v1',
    feature_flags: {},
  };
}

function makeQueryPlan(): QueryPlanV1 {
  return {
    normalizedQuery: 'opus one 2018',
    queryClass: 'known_item',
    retrievalMode: 'entity_lookup',
    route: 'entity',
    anchors: [],
    constraints: {
      hard: [],
      soft: [],
      inferred: [],
    },
    policy: {
      route: 'entity',
      strategy: 'direct_lookup',
      requiresClarification: false,
      blockingRequested: false,
    },
  };
}

describe('id schema decoder', () => {
  it('decodes authority trace refs for replay/audit', () => {
    const ref = buildAuthorityTraceRef({
      queryPlan: makeQueryPlan(),
      snapshot: makeSnapshot(),
      route: 'entity',
      retrievalMode: 'entity_lookup',
      chosenEntityId: 'wine-opus-one-2018',
      decisionStatus: 'resolved',
      nextAction: 'return_result',
    });

    expect(decodeAuthorityTraceRef(ref)).toEqual({
      family: 'decision',
      schemaVersion: 'v1',
      queryClass: 'known_item',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('rejects malformed authority trace refs', () => {
    expect(decodeAuthorityTraceRef('decision:v2:known_item:not-a-digest')).toBeNull();
  });

  it('decodes deterministic batch ids', () => {
    const batchId = `batch:v1:${deterministicHash({ query: 'opus one 2018', limit: 5 })}`;

    expect(decodeBatchId(batchId)).toEqual({
      schemaVersion: 'v1',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('decodes v1 and v2 snapshot ids', () => {
    const snapshot = makeSnapshot();
    const v1 = buildDeterministicSnapshotId(snapshot);
    const v2 = buildDeterministicSnapshotIdV2({
      snapshot,
      versionContract: {
        plannerVersion: snapshot.planner_version,
        policyRuleVersion: snapshot.policy_rule_version,
        thresholdProfileId: snapshot.threshold_profile_id,
        executionRoute: 'hybrid',
        retrievalMode: 'entity_lookup',
      },
    });

    expect(decodeSnapshotId(v1)).toEqual({
      schemaVersion: 'v1',
      thresholdProfileId: 'default-v2',
      plannerVersion: 'planner-v1',
      policyRuleVersion: 'policy-v1',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(decodeSnapshotId(v2)).toEqual({
      schemaVersion: 'v2',
      thresholdProfileId: 'default-v2',
      plannerVersion: 'planner-v1',
      policyRuleVersion: 'policy-v1',
      executionRoute: 'hybrid',
      retrievalMode: 'entity_lookup',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('rejects malformed snapshot ids', () => {
    expect(decodeSnapshotId('snapshot:v1:missing:digest')).toBeNull();
    expect(decodeSnapshotId('snapshot:v3:unknown')).toBeNull();
  });
});
