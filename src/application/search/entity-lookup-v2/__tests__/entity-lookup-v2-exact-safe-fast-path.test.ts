import { describe, expect, it, vi } from 'vitest';
import { ConceptAdmissionGate } from '../../../../domain/resolver/v2/concept-admission-gate.js';
import { EntityLookupV2UseCase } from '../entity-lookup-v2.usecase.js';
import { createEntityId } from '../../../../domain/shared/types/index.js';
import type { LookupPlannerPort } from '../lookup-planner.port.js';
import type { EntityResolverPort } from '../../port/search-pipeline-deps.port.js';
import type { NormalizedQueryViews } from '../../../../domain/query/model/query-views.js';

function makeViews(query: string): NormalizedQueryViews {
  const lower = query.toLowerCase();
  return {
    raw: query,
    strict: lower,
    accentless: lower,
    collapsedWhitespace: lower,
    punctuationStripped: lower,
    compact: lower.replace(/[^\p{L}\p{N}]/gu, ''),
    vintageCanonicalized: lower,
    vintageStripped: lower,
    semanticVariants: [lower],
    lookupVariants: [lower],
  };
}

describe('EntityLookupV2UseCase exact-safe fast path', () => {
  it('skips timed retrieval when the exact-safe registry plan pins a singleton witness', async () => {
    const entityId = createEntityId('opus-one-2018');
    const exactPlan = {
      rawQuery: 'opus one',
      normalizedQuery: 'opus one',
      intent: 'entity_exact',
      route: 'entity',
      retrievalMode: 'entity_lookup',
      queryClass: 'exact_entity',
      anchors: [{
        surfaceForm: 'opus one',
        normalizedForm: 'opus one',
        candidateEntityIds: [entityId],
        lookupStrategies: ['exact'],
        aliasType: 'canonical',
        confidence: 1,
        source: 'alias',
        lookupVariants: ['opus one'],
      }],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {},
      uncertainty: {},
      normalizedQueryViews: makeViews('opus one'),
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
    };

    const lookupPlanner: LookupPlannerPort = {
      plan: vi.fn().mockImplementation(async (_query, context) => {
        if (context?.earlyExitOnly === true || context?.prefetchedAnchors === undefined) {
          return exactPlan;
        }
        return exactPlan;
      }),
    };

    const entityResolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [{
          entityId,
          canonicalLabel: 'Opus One 2018',
          calibratedScore: 0.99,
          rank: 1,
          evidenceRefs: [],
        }],
        topEntity: {
          entityId,
          canonicalLabel: 'Opus One 2018',
          calibratedScore: 0.99,
        },
        decisionTrace: {
          queryClass: 'exact_entity',
          top1CalibratedScore: 0.99,
          top2CalibratedScore: undefined,
          calibratedGap: undefined,
          decisionConfidenceC: 0.99,
          calibrationTrusted: true,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
          outcomeReasonCodes: ['exact_identity'],
        },
        conformalSetSize: 1,
      }),
    };

    const candidateRetrieval = {
      retrieve: vi.fn().mockResolvedValue({
        candidates: [],
        coverage: [],
      }),
    };

    const resolverProjectionLookup = {
      getResolverProjections: vi.fn(async (ids: readonly unknown[]) => new Map(
        ids.map((id) => [id, {
          entityId: id,
          entityType: 'wine',
          canonicalLabel: 'Opus One 2018',
          aliasesIdentitySafe: [],
          identitySafeKeys: [],
        }]),
      )),
    };

    const useCase = new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      lookupPlanner,
      entityResolver,
      resolverProjectionLookup: resolverProjectionLookup as never,
      candidateRetrieval: candidateRetrieval as never,
      querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
    });

    const out = await useCase.execute({ query: 'opus one', maxCandidates: 10, mode: 'default' });

    expect(out.status).toBe('resolved');
    expect(candidateRetrieval.retrieve).not.toHaveBeenCalled();
    expect(entityResolver.resolve).toHaveBeenCalled();
  });
});
