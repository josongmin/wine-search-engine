import { describe, expect, it } from 'vitest';
import { buildEntityRouteRankedResults } from '../search-usecase-entity-ranked-results.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../../domain/resolver/model/resolve-result.js';
import type { ResolverCandidate } from '../../../domain/resolver/model/resolved-candidate.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';

const ENTITY_ID = createCanonicalEntityId('wine-ce-kalaris');

function makePlan(): QueryPlanV1 {
  return {
    rawQuery: 'Kalaris Merlot',
    normalizedQuery: 'kalaris merlot',
    intent: 'entity_exact',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
    anchors: [],
    constraints: {
      hard: [{
        attribute: 'grape_primary',
        operator: '=',
        value: 'Merlot',
        source_phrase: 'Merlot',
        confidence: 1,
      }],
      soft: [],
      inferred: [],
    },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      fallbackMode: 'hybrid',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.05,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.95,
      anchorConfidence: 0.95,
      constraintConfidence: 0.95,
    },
    plannerVersion: 'test',
    policyRuleVersion: 'test',
    thresholdProfileId: 'default',
  };
}

function makeResolveResult(): EntityResolveResult {
  return {
    status: 'resolved',
    recommendedNextAction: 'return_result',
    decisionConfidenceC: 0.97,
    topEntity: {
      entityId: ENTITY_ID,
      canonicalLabel: '2014 Kalaris Merlot',
      calibratedScore: 0.97,
    },
    candidates: [{
      entityId: ENTITY_ID,
      canonicalLabel: '2014 Kalaris Merlot',
      calibratedScore: 0.97,
      rank: 1,
      evidenceRefs: ['Kalaris Merlot'],
      source: 'alias',
      sources: ['alias'],
    }],
    decisionTrace: {
      queryClass: 'short_entity',
      top1CalibratedScore: 0.97,
      top2CalibratedScore: 0,
      calibratedGap: 0.97,
      decisionConfidenceC: 0.97,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.02 },
      outcomeReasonCodes: ['RESOLVED_ALL_GATES_PASSED'],
    },
    conformalSetSize: 1,
  };
}

describe('buildEntityRouteRankedResults', () => {
  it('projects hard-constraint evidence into synthetic entity ranked results', () => {
    const rankedResults = buildEntityRouteRankedResults(
      makePlan(),
      makeResolveResult(),
      [{
        entityId: ENTITY_ID,
        entityType: 'wine',
        canonicalLabel: '2014 Kalaris Merlot',
        aliasMatches: [],
        attributeHints: {
          grape_primary: 'Merlot',
          producer: 'Kalaris',
          vintage_year: 2014,
          vintage: 2014,
        },
        sourceSignals: {
          canonicalExactMatch: 1,
          canonicalNormalizedMatch: 1,
          aliasExactMatch: 1,
          aliasFuzzyMatch: 0,
          aliasTypePrior: 1,
          producerMatch: 0,
          vintageMatch: 0,
          regionMatch: 0,
          grapeHintMatch: 0,
          phoneticMatch: 0,
          editDistanceScore: 0,
          ambiguityPenalty: 0,
        },
        source: 'alias',
        sources: ['alias'],
      } satisfies ResolverCandidate],
    );

    expect(rankedResults).toHaveLength(1);
    expect(rankedResults[0]?.componentScores.hardConstraintPass).toBe(true);
    expect(rankedResults[0]?.matchedConstraints).toContain('grape_primary');
    expect(rankedResults[0]?.unmetConstraints).toEqual([]);
    expect(rankedResults[0]?.evidenceItems.some((item) => item.type === 'constraint_pass')).toBe(true);
  });

  it('marks hard-constraint failures when entity metadata contradicts the query plan', () => {
    const rankedResults = buildEntityRouteRankedResults(
      makePlan(),
      makeResolveResult(),
      [{
        entityId: ENTITY_ID,
        entityType: 'wine',
        canonicalLabel: '2014 Kalaris Merlot',
        aliasMatches: [],
        attributeHints: {
          grape_primary: 'Cabernet Sauvignon',
        },
        sourceSignals: {
          canonicalExactMatch: 1,
          canonicalNormalizedMatch: 1,
          aliasExactMatch: 1,
          aliasFuzzyMatch: 0,
          aliasTypePrior: 1,
          producerMatch: 0,
          vintageMatch: 0,
          regionMatch: 0,
          grapeHintMatch: 0,
          phoneticMatch: 0,
          editDistanceScore: 0,
          ambiguityPenalty: 0,
        },
        source: 'alias',
        sources: ['alias'],
      } satisfies ResolverCandidate],
    );

    expect(rankedResults).toHaveLength(1);
    expect(rankedResults[0]?.componentScores.hardConstraintPass).toBe(false);
    expect(rankedResults[0]?.matchedConstraints).not.toContain('grape_primary');
    expect(rankedResults[0]?.unmetConstraints).toContain('grape_primary');
    expect(rankedResults[0]?.evidenceItems.some((item) => item.type === 'constraint_fail')).toBe(true);
  });
});
