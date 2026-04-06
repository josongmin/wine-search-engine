import { describe, expect, it } from 'vitest';
import { buildDecisionSnapshotFromPlan } from '../search-usecase-decision-snapshot.js';

describe('buildDecisionSnapshotFromPlan', () => {
  it('carries runtime feature flags into the decision snapshot', () => {
    const snapshot = buildDecisionSnapshotFromPlan(
      {
        rawQuery: 'find bordeaux',
        normalizedQuery: 'find bordeaux',
        intent: 'search',
        additionalIntents: [],
        queryClass: 'short_entity',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: false,
          fallbackMode: 'clarify',
          policyReasonCodes: [],
        },
        anchors: [],
        uncertainty: { terms: [], confidence: 0 },
        route: 'hybrid',
        retrievalMode: 'entity_lookup',
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policyRuleVersion: '1.0.0',
        thresholdProfileId: 'default',
        plannerVersion: '1.0.0',
      } as never,
      {
        modelVersions: { embedding: 'bge-m3' },
        indexVersions: { wine_content: 'wine_content' },
        featureFlags: {
          killSwitchDenseRetrieval: false,
          killSwitchInjectionJudge: true,
        },
      },
    );

    expect(snapshot.feature_flags).toEqual({
      killSwitchDenseRetrieval: false,
      killSwitchInjectionJudge: true,
    });
  });
});
