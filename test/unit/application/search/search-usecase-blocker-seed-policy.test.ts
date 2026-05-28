import { describe, expect, it, vi } from 'vitest';
import { SearchUseCase } from '../../../../src/application/search/search.usecase.js';
import { shouldSuppressBlockerSeedExpansion } from '../../../../src/application/search/search-usecase-blocker-seed-policy.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import { createCanonicalEntityId } from '../../../../src/domain/shared/types/index.js';

const PRIMARY_ENTITY_ID = createCanonicalEntityId('wine-ce-meo-camuzet-2010');
const BLOCKER_ENTITY_ID = createCanonicalEntityId('wine-ce-meo-camuzet-2019');

function makeExactCanonicalAnchorPlan(): QueryPlanV1 {
  return {
    rawQuery: '2010 Méo-Camuzet Marsannay',
    normalizedQuery: '2010 méo-camuzet marsannay',
    intent: 'entity_exact',
    route: 'entity',
    retrievalMode: 'entity_lookup',
    queryClass: 'short_entity',
    anchors: [{
      surfaceForm: '2010 Méo-Camuzet Marsannay',
      normalizedForm: '2010 méo-camuzet marsannay',
      candidateEntityIds: [PRIMARY_ENTITY_ID],
      lookupStrategies: ['exact', 'compact_exact'],
      aliasType: 'canonical',
      confidence: 1,
      source: 'alias',
    }],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: true,
      allowApproximate: false,
      requireClarification: false,
      fallbackMode: 'clarify',
      policyReasonCodes: [],
    },
    uncertainty: {
      overall: 0.05,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 1,
      anchorConfidence: 1,
      constraintConfidence: 1,
    },
    plannerVersion: 'test',
    policyRuleVersion: 'test',
    thresholdProfileId: 'default',
  };
}

function makeCompiled(): CompiledWineQuery {
  return {
    query: {
      rawQuery: '2010 Méo-Camuzet Marsannay',
      normalizedQuery: '2010 méo-camuzet marsannay',
      intent: 'entity_exact',
      queryClass: 'short_entity',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.05,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 1,
        anchorConfidence: 1,
        constraintConfidence: 1,
      },
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    } as never,
    execution: {
      effectiveRoute: 'entity',
      executionTopology: 'entity_only',
      effectiveRetrievalMode: 'entity_lookup',
      routeSource: 'planner',
      budget: {
        maxCandidates: 10,
        rerankLimit: 0,
        enablePrecisionRerank: false,
      },
      provenancePolicy: {
        requireIdentitySeal: true,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  };
}

describe('shouldSuppressBlockerSeedExpansion', () => {
  it('returns true for authoritative singleton canonical anchors', () => {
    expect(shouldSuppressBlockerSeedExpansion(makeExactCanonicalAnchorPlan().anchors)).toBe(true);
  });

  it('returns false for non-canonical singleton anchors', () => {
    const plan = makeExactCanonicalAnchorPlan();
    plan.anchors = [{
      ...plan.anchors[0]!,
      aliasType: 'translation',
      confidence: 0.92,
    }];
    expect(shouldSuppressBlockerSeedExpansion(plan.anchors)).toBe(false);
  });
});

describe('SearchUseCase blocker seed suppression', () => {
  it('skips blocker widening for exact canonical singleton entity routes', async () => {
    const blocker = {
      block: vi.fn().mockResolvedValue([BLOCKER_ENTITY_ID]),
    };
    const entityLookup = {
      getDocuments: vi.fn(async (ids: readonly unknown[]) => {
        const docs = new Map();
        for (const id of ids) {
          docs.set(id, {
            entityId: id,
            entityType: 'wine',
            canonicalLabel: String(id) === String(PRIMARY_ENTITY_ID)
              ? '2010 Méo-Camuzet Marsannay'
              : '2019 Méo-Camuzet Fixin',
          });
        }
        return docs;
      }),
    };
    const resolveMock = vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [{
          entityId: PRIMARY_ENTITY_ID,
          canonicalLabel: '2010 Méo-Camuzet Marsannay',
          calibratedScore: 1,
          rank: 1,
          evidenceRefs: ['2010 Méo-Camuzet Marsannay'],
          source: 'alias',
          sources: ['alias'],
        }],
        topEntity: {
          entityId: PRIMARY_ENTITY_ID,
          canonicalLabel: '2010 Méo-Camuzet Marsannay',
          calibratedScore: 1,
        },
        decisionTrace: {
          queryClass: 'short_entity',
          top1CalibratedScore: 1,
          top2CalibratedScore: undefined,
          calibratedGap: undefined,
          decisionConfidenceC: 1,
          calibrationTrusted: false,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.45, gapThreshold: 0.02 },
          outcomeReasonCodes: ['SINGLETON_BYPASS_RESOLVED'],
        },
        conformalSetSize: 1,
        recommendedNextAction: 'return_result',
        decisionConfidenceC: 1,
      });
    const entityResolver = {
      resolve: resolveMock,
    };

    const useCase = new SearchUseCase({
      queryPlanner: {} as never,
      entityResolver: entityResolver as never,
      entityLookup: entityLookup as never,
      blocker: blocker as never,
      candidatePool: {} as never,
      ranker: {} as never,
      decisionEngine: {} as never,
      responseBuilder: {} as never,
      mixedSolver: {} as never,
      querySanitizer: {} as never,
    });

    const route = useCase as unknown as {
      executeEntityRoute(plan: QueryPlanV1, compiled: CompiledWineQuery): Promise<{
        identityResolveResult: { status: string };
      }>;
    };

    const result = await route.executeEntityRoute(makeExactCanonicalAnchorPlan(), makeCompiled());

    expect(blocker.block).not.toHaveBeenCalled();
    const resolverInput = resolveMock.mock.calls[0]?.[0];
    const candidateIds = resolverInput.candidateEntities.map((candidate: { entityId: unknown }) => String(candidate.entityId));
    expect(candidateIds).toEqual([String(PRIMARY_ENTITY_ID)]);
    expect(result.identityResolveResult.status).toBe('resolved');
  });
});
