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
          region: 'Napa Valley',
          appellation: 'Oak Knoll District',
          country: 'United States',
          vintage_year: 2014,
          vintage: 2014,
          style: 'velvety red',
          price_band: 'premium',
          pairing: ['beef'],
          occasion: ['dinner'],
          body: 0.8,
          tannin: 0.4,
          acidity: 0.5,
          sweetness: 0.1,
          critic_score_normalized: 0.93,
          producer_prestige: 0.66,
          certifications: ['organic'],
          classification: 'Estate',
          alcohol_pct: 14.2,
          price_usd: 79,
          drinking_window_start: 2022,
          drinking_window_end: 2030,
          drinking_window_model_version: 'dw-v1',
        },
        sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'wine-kalaris' }],
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
    expect(rankedResults[0]?.producer).toBe('Kalaris');
    expect(rankedResults[0]?.region).toBe('Napa Valley');
    expect(rankedResults[0]?.appellation).toBe('Oak Knoll District');
    expect(rankedResults[0]?.style).toBe('velvety red');
    expect(rankedResults[0]?.priceBand).toBe('premium');
    expect(rankedResults[0]?.pairingTags).toEqual(['beef']);
    expect(rankedResults[0]?.occasion).toEqual(['dinner']);
    expect(rankedResults[0]?.certifications).toEqual(['organic']);
    expect(rankedResults[0]?.classification).toBe('Estate');
    expect(rankedResults[0]?.alcoholPct).toBe(14.2);
    expect(rankedResults[0]?.priceUsd).toBe(79);
    expect(rankedResults[0]?.drinkingWindowStart).toBe(2022);
    expect(rankedResults[0]?.drinkingWindowEnd).toBe(2030);
    expect(rankedResults[0]?.drinkingWindowModelVersion).toBe('dw-v1');
    expect(rankedResults[0]?.criticScoreNormalized).toBe(0.93);
    expect(rankedResults[0]?.avgCriticProxyScore).toBe(99);
    expect(rankedResults[0]?.producerPrestige).toBe(0.66);
    expect(rankedResults[0]?.grapePrimaryEnc).not.toBeUndefined();
    expect(rankedResults[0]?.regionEnc).not.toBeUndefined();
    expect(rankedResults[0]?.countryEnc).not.toBeUndefined();
    expect(rankedResults[0]?.sourceRecordRefs).toEqual([
      { sourceSystem: 'vivino-silver', sourceRecordId: 'wine-kalaris' },
    ]);
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

  it('preserves resolver rank instead of rebuilding rank from synthetic order', () => {
    const rankedResults = buildEntityRouteRankedResults(
      makePlan(),
      {
        ...makeResolveResult(),
        candidates: [{
          ...makeResolveResult().candidates[0]!,
          rank: 7,
        }],
      },
      [{
        entityId: ENTITY_ID,
        entityType: 'wine',
        canonicalLabel: '2014 Kalaris Merlot',
        aliasMatches: [],
        attributeHints: {
          grape_primary: 'Merlot',
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
    expect(rankedResults[0]?.rank).toBe(7);
  });

  it('throws when resolver output contains duplicate entity IDs', () => {
    const resolveResult = makeResolveResult();

    expect(() =>
      buildEntityRouteRankedResults(
        makePlan(),
        {
          ...resolveResult,
          candidates: [
            resolveResult.candidates[0]!,
            {
              ...resolveResult.candidates[0]!,
              evidenceRefs: ['duplicate'],
              rank: 2,
            },
          ],
        },
        [{
          entityId: ENTITY_ID,
          entityType: 'wine',
          canonicalLabel: '2014 Kalaris Merlot',
          aliasMatches: [],
          attributeHints: {
            grape_primary: 'Merlot',
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
      )).toThrow(/duplicate entity IDs/);
  });
});
