import { describe, expect, it } from 'vitest';
import { extractExtendedLTRFeatures } from '../ltr-feature-extractor.js';
import { SignalComputer } from '../signal-computer.js';
import type { HybridCandidate } from '../../../retrieval/model/hybrid-candidate.js';
import type { QueryPlanV1 } from '../../../query/model/query-plan.js';
import { createEntityId } from '../../../shared/types/index.js';
import { makeHybridCandidate } from '../../../../../test/support/hybrid-candidate-test-factory.js';

function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return makeHybridCandidate({
    entityId: createEntityId('wine-test'),
    fusionRrfTotal: 0.5,
    retrievalTrace: {
      retrievalProfile: 'default',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [],
    },
    ...overrides,
  });
}

function makeQueryPlan(): QueryPlanV1 {
  return {
    rawQuery: 'test',
    normalizedQuery: 'test',
    intent: 'semantic_discovery',
    route: 'hybrid',
    queryClass: 'semantic_preference',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

describe('producer prestige missingness', () => {
  it('SignalComputer preserves missing producerPrestige instead of fabricating a neutral midpoint', () => {
    const signalComputer = new SignalComputer();
    const scores = signalComputer.computeAll(
      makeCandidate(),
      makeQueryPlan(),
      { hard: [], soft: [], inferred: [] },
    );

    expect(scores.producerPrestige).toBeUndefined();
  });

  it('extended LTR features do not fabricate neutral prestige when missing', () => {
    const features = extractExtendedLTRFeatures({
      semantic: 0.6,
      popularity: 0.3,
      attributeAlignment: 0.4,
      preferenceAlignment: 0.5,
    });

    expect(features.producerPrestigeFeature).toBe(0);
  });
});
