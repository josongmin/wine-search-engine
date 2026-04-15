import { describe, expect, it, vi } from 'vitest';
import { ResolveUseCase } from '../../../../src/application/search/resolve.usecase.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import { decodeAuthorityTraceRefDetailed } from '../../../../src/domain/decision/service/id-schema-decoder.js';
import type {
  BlockingUseCasePort,
  EntityDocumentLookupPort,
  EntityResolverPort,
  QueryPlannerPort,
} from '../../../../src/application/search/port/search-pipeline-deps.port.js';

describe('ResolveUseCase', () => {
  it('reuses the shared planner context mapping for locale, session, and budget', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'Opus One',
        normalizedQuery: 'opus one',
        intent: 'known_item',
        route: 'entity',
        retrievalMode: 'entity_lookup',
        queryClass: 'known-item',
        anchors: [],
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {},
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      }),
    };

    const entityResolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [],
        topEntity: undefined,
        decisionTrace: {
          queryClass: 'known-item',
          top1CalibratedScore: 1,
          top2CalibratedScore: 0,
          calibratedGap: 1,
          decisionConfidenceC: 1,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      }),
    };

    const previousEntity = createEntityId('prev');
    const useCase = new ResolveUseCase({
      queryPlanner,
      entityResolver,
      querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'Opus One' }) },
    });

    await useCase.execute({
      query: '  Opus One  ',
      context: { locale: 'en-US', currency: 'USD' },
      sessionContext: {
        sessionId: 'session-42',
        previousEntities: [previousEntity],
      },
      queryBudget: {
        maxLatencyMs: 850,
        maxCandidates: 24,
        rerankLimit: 10,
      },
    });

    expect(queryPlanner.plan).toHaveBeenCalledWith('Opus One', {
      locale: 'en-US',
      session: {
        sessionId: 'session-42',
        previousEntities: [previousEntity],
      },
      budget: {
        maxLatencyMs: 850,
        maxCandidates: 24,
        rerankLimit: 10,
      },
    });
  });

  it('includes requestId in decision_trace_ref when provided', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'Opus One 2018',
        normalizedQuery: 'opus one 2018',
        intent: 'known_item',
        route: 'entity',
        retrievalMode: 'entity_lookup',
        queryClass: 'known-item',
        anchors: [],
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {},
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      }),
    };

    const entityResolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [],
        topEntity: undefined,
        decisionTrace: {
          queryClass: 'known-item',
          top1CalibratedScore: 1,
          top2CalibratedScore: 0,
          calibratedGap: 1,
          decisionConfidenceC: 1,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      }),
    };

    const useCase = new ResolveUseCase({
      queryPlanner,
      entityResolver,
      querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'Opus One 2018' }) },
    });

    const result = await useCase.execute({ query: 'Opus One 2018', requestId: 'req-123' });

    expect(result.decision_trace_ref).toMatch(/^decision:v1:known-item:[a-f0-9]{64}$/);
    expect(result.authority_trace_ref).toBe(result.decision_trace_ref);
    expect(result.request_id).toBe('req-123');
    expect(decodeAuthorityTraceRefDetailed(result.authority_trace_ref)).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it('hydrates anchor candidates into resolver candidateEntities when entityLookup is available', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: '오푸스원',
        normalizedQuery: '오푸스원',
        intent: 'known_item',
        route: 'entity',
        retrievalMode: 'entity_lookup',
        queryClass: 'short_entity',
        anchors: [
          {
            surfaceForm: '오푸스원',
            normalizedForm: '오푸스원',
            candidateEntityIds: [createEntityId('opus-one-2018')],
            lookupStrategies: ['transliterated_exact'],
            confidence: 0.98,
            source: 'alias',
          },
        ],
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {},
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      }),
    };

    const entityResolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [],
        topEntity: undefined,
        decisionTrace: {
          queryClass: 'short_entity',
          top1CalibratedScore: 1,
          top2CalibratedScore: 0,
          calibratedGap: 1,
          decisionConfidenceC: 1,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      }),
    };

    const opusDoc = {
      entityId: createEntityId('opus-one-2018'),
      entityType: 'wine' as const,
      canonicalLabel: 'Opus One 2018',
    };
    const entityLookup = {
      getDocument: vi.fn().mockResolvedValue(opusDoc),
      getDocuments: vi.fn().mockResolvedValue(
        new Map([[createEntityId('opus-one-2018'), opusDoc]]),
      ),
    };

    const useCase = new ResolveUseCase({
      queryPlanner,
      entityResolver,
      entityLookup,
      querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: '오푸스원' }) },
    });

    await useCase.execute({ query: '오푸스원' });

    expect(entityLookup.getDocuments).toHaveBeenCalledWith([createEntityId('opus-one-2018')]);
    expect(entityResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateEntities: [
          expect.objectContaining({
            entityId: createEntityId('opus-one-2018'),
            canonicalLabel: 'Opus One 2018',
          }),
        ],
      }),
    );
  });

  // ─── TA2-T5: blocker integration in ResolveUseCase ───────────────────────

  describe('TA2-T5: blocker integration', () => {
    function makePlan(overrides: Record<string, unknown> = {}) {
      return {
        rawQuery: '오퍼스원 2019',
        normalizedQuery: '오퍼스원 2019',
        intent: 'known_item',
        route: 'entity',
        retrievalMode: 'entity_lookup',
        queryClass: 'short_entity',
        anchors: [],
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {},
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
        ...overrides,
      };
    }

    function makeResolver(status: 'resolved' | 'failed' | 'ambiguous' = 'resolved'): EntityResolverPort {
      return {
        resolve: vi.fn().mockResolvedValue({
          status,
          candidates: status === 'resolved'
            ? [{ entityId: createEntityId('opus-one-2019'), canonicalLabel: 'Opus One 2019', calibratedScore: 0.92, rank: 1, evidenceRefs: [], source: 'blocker_seed' }]
            : [],
          topEntity: status === 'resolved'
            ? { entityId: createEntityId('opus-one-2019'), canonicalLabel: 'Opus One 2019', calibratedScore: 0.92 }
            : undefined,
          decisionTrace: {
            queryClass: 'short_entity',
            top1CalibratedScore: status === 'resolved' ? 0.92 : 0,
            top2CalibratedScore: 0,
            calibratedGap: status === 'resolved' ? 0.92 : 0,
            decisionConfidenceC: status === 'resolved' ? 0.88 : 0.1,
            ambiguityDetected: false,
            ambiguityTypes: [],
            appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
            outcomeReasonCodes: [],
          },
          conformalSetSize: status === 'resolved' ? 1 : 0,
        }),
      };
    }

    function makeEntityLookup(entityId: string, label: string): EntityDocumentLookupPort {
      const doc = {
        entityId: createEntityId(entityId),
        entityType: 'wine' as const,
        canonicalLabel: label,
      };
      return {
        getDocument: vi.fn().mockResolvedValue(doc),
        getDocuments: vi.fn(async (ids: readonly unknown[]) => {
          const map = new Map();
          for (const id of ids) {
            map.set(id, doc);
          }
          return map;
        }),
      };
    }

    it('P0-1-A: calls blocker when provided and passes rawQuery + normalizedQuery', async () => {
      const blocker: BlockingUseCasePort = {
        block: vi.fn().mockResolvedValue([createEntityId('opus-one-2019')]),
      };
      const entityLookup = makeEntityLookup('opus-one-2019', 'Opus One 2019');
      const useCase = new ResolveUseCase({
        queryPlanner: { plan: vi.fn().mockResolvedValue(makePlan()) },
        entityResolver: makeResolver(),
        entityLookup,
        blocker,
        querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: '오퍼스원 2019' }) },
      });

      await useCase.execute({ query: '오퍼스원 2019', requestId: 'req-blocker-call' });

      expect(blocker.block).toHaveBeenCalledOnce();
      expect(blocker.block).toHaveBeenCalledWith('오퍼스원 2019', '오퍼스원 2019');
    });

    it('P0-1-B: anchor miss + blocker hit → resolver receives blocker-seeded candidate (not empty)', async () => {
      // Scenario: planner finds no alias anchors (anchor miss),
      // but blocker returns an entity ID (blocker hit).
      // /resolve MUST NOT end with 0 candidates.
      const blockerEntityId = createEntityId('opus-one-2019');
      const blocker: BlockingUseCasePort = {
        block: vi.fn().mockResolvedValue([blockerEntityId]),
      };
      const entityLookup = makeEntityLookup('opus-one-2019', 'Opus One 2019');
      const resolver = makeResolver('resolved');

      const useCase = new ResolveUseCase({
        queryPlanner: {
          plan: vi.fn().mockResolvedValue(makePlan({ anchors: [] })), // no anchors
        },
        entityResolver: resolver,
        entityLookup,
        blocker,
        querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: '오퍼스원 2019' }) },
      });

      const result = await useCase.execute({ query: '오퍼스원 2019', requestId: 'req-anchor-miss' });

      // Resolver was called with candidateEntities populated from blocker seed
      expect(resolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateEntities: expect.arrayContaining([
            expect.objectContaining({ entityId: blockerEntityId }),
          ]),
        }),
      );
      // Result is not empty — exact recovery path opened
      expect(result.status).toBe('resolved');
      expect(result.candidates.length).toBeGreaterThan(0);
    });

    it('P0-1-C: without blocker, anchor miss → resolver is called with empty candidateEntities', async () => {
      // Regression: the old path (no blocker) should still work — resolver is
      // called but candidateEntities are empty, so result is failed.
      const resolver: EntityResolverPort = {
        resolve: vi.fn().mockResolvedValue({
          status: 'failed',
          candidates: [],
          topEntity: undefined,
          decisionTrace: {
            queryClass: 'short_entity',
            top1CalibratedScore: 0,
            top2CalibratedScore: 0,
            calibratedGap: 0,
            decisionConfidenceC: 0,
            ambiguityDetected: false,
            ambiguityTypes: [],
            appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
            outcomeReasonCodes: [],
          },
          conformalSetSize: 0,
        }),
      };

      const useCase = new ResolveUseCase({
        queryPlanner: { plan: vi.fn().mockResolvedValue(makePlan({ anchors: [] })) },
        entityResolver: resolver,
        // no blocker, no entityLookup
        querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: '오퍼스원 2019' }) },
      });

      const result = await useCase.execute({ query: '오퍼스원 2019' });

      expect(resolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ candidateEntities: [] }),
      );
      expect(result.status).toBe('failed');
    });

    it('P0-1-D: blocker IDs already covered by anchors are filtered out (blockerOnlyIds dedup)', async () => {
      // The overlapping entity ID must NOT produce a duplicate candidate.
      const sharedId = createEntityId('opus-one-2019');
      const extraId = createEntityId('opus-one-2018');

      const blocker: BlockingUseCasePort = {
        block: vi.fn().mockResolvedValue([sharedId, extraId]),
      };
      const entityLookup: EntityDocumentLookupPort = {
        getDocument: vi.fn().mockImplementation(async (id) => ({
          entityId: id,
          entityType: 'wine',
          canonicalLabel: String(id) === String(sharedId) ? 'Opus One 2019' : 'Opus One 2018',
        })),
        getDocuments: vi.fn(async (ids: readonly unknown[]) => {
          const map = new Map();
          for (const id of ids) {
            map.set(id, {
              entityId: id,
              entityType: 'wine',
              canonicalLabel: String(id) === String(sharedId) ? 'Opus One 2019' : 'Opus One 2018',
            });
          }
          return map;
        }),
      };
      const resolver = makeResolver('resolved');

      const useCase = new ResolveUseCase({
        queryPlanner: {
          plan: vi.fn().mockResolvedValue(makePlan({
            anchors: [{
              surfaceForm: '오퍼스원 2019',
              normalizedForm: '오퍼스원 2019',
              candidateEntityIds: [sharedId], // sharedId already in anchor
              lookupStrategies: ['transliterated_exact'],
              confidence: 0.95,
              source: 'alias',
            }],
          })),
        },
        entityResolver: resolver,
        entityLookup,
        blocker,
        querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: '오퍼스원 2019' }) },
      });

      await useCase.execute({ query: '오퍼스원 2019' });

      // candidateEntities must not contain sharedId twice
      const resolverCall = (resolver.resolve as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const candidateIds = resolverCall?.candidateEntities.map((c: { entityId: unknown }) => String(c.entityId));
      const uniqueIds = new Set(candidateIds);
      expect(uniqueIds.size).toBe(candidateIds?.length); // no duplicates
      // extraId must be present (blocker-only seed)
      expect(candidateIds).toContain(String(extraId));
    });

    it('P0-1-E: blocker-seeded candidate carries source=blocker_seed in resolver input (provenance tag preserved)', async () => {
      const blockerEntityId = createEntityId('barolo-2020');
      const blocker: BlockingUseCasePort = {
        block: vi.fn().mockResolvedValue([blockerEntityId]),
      };
      const entityLookup = makeEntityLookup('barolo-2020', 'Barolo 2020');
      const resolver = makeResolver('resolved');

      const useCase = new ResolveUseCase({
        queryPlanner: { plan: vi.fn().mockResolvedValue(makePlan({ anchors: [] })) },
        entityResolver: resolver,
        entityLookup,
        blocker,
        querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'barolo 2020' }) },
      });

      await useCase.execute({ query: 'barolo 2020' });

      const resolverCall = (resolver.resolve as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      const candidate = resolverCall?.candidateEntities.find(
        (c: { entityId: unknown }) => String(c.entityId) === String(blockerEntityId),
      );
      expect(candidate?.source).toBe('blocker_seed');
      expect(candidate?.sources).toContain('blocker_seed');
    });

    it('P0-1-F: /search vs /resolve blocker contract — blocker.block called with same query args', async () => {
      // Structural contract test: both /search and /resolve invoke
      // blocker.block(rawQuery, normalizedQuery) — same argument signature.
      // This test guards that resolve.usecase matches the search.usecase pattern.
      const RAW_QUERY = '로마네꽁티 2015';
      const NORMALIZED_QUERY = '로마네꽁티 2015';

      const blocker: BlockingUseCasePort = {
        block: vi.fn().mockResolvedValue([]),
      };

      const useCase = new ResolveUseCase({
        queryPlanner: {
          plan: vi.fn().mockResolvedValue(makePlan({ rawQuery: RAW_QUERY, normalizedQuery: NORMALIZED_QUERY })),
        },
        entityResolver: makeResolver('failed'),
        blocker,
        querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: RAW_QUERY }) },
      });

      await useCase.execute({ query: RAW_QUERY });

      expect(blocker.block).toHaveBeenCalledWith(RAW_QUERY, NORMALIZED_QUERY);
    });

    it('P0-1-G: blocker returns empty array → resolver still called, candidateEntities empty', async () => {
      // When blocker finds nothing and anchors are also empty, the resolver
      // must still be invoked (not short-circuited) so it can return 'failed'
      // with a proper decisionTrace.
      const blocker: BlockingUseCasePort = {
        block: vi.fn().mockResolvedValue([]), // nothing found
      };
      const resolver: EntityResolverPort = {
        resolve: vi.fn().mockResolvedValue({
          status: 'failed',
          candidates: [],
          topEntity: undefined,
          decisionTrace: {
            queryClass: 'short_entity',
            top1CalibratedScore: 0,
            top2CalibratedScore: 0,
            calibratedGap: 0,
            decisionConfidenceC: 0,
            ambiguityDetected: false,
            ambiguityTypes: [],
            appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
            outcomeReasonCodes: [],
          },
          conformalSetSize: 0,
        }),
      };

      const useCase = new ResolveUseCase({
        queryPlanner: { plan: vi.fn().mockResolvedValue(makePlan({ anchors: [] })) },
        entityResolver: resolver,
        blocker,
        querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: '없는와인' }) },
      });

      await useCase.execute({ query: '없는와인' });

      expect(blocker.block).toHaveBeenCalledOnce();
      // Resolver is still called even when blocker found nothing
      expect(resolver.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ candidateEntities: [] }),
      );
    });

    it('P0-1-H: broader=false is used (standard recall, not corrective-retry recall)', async () => {
      // resolve.usecase should call block() WITHOUT broader:true
      // (broader recall is for corrective retry in search.usecase, not resolve)
      const blocker: BlockingUseCasePort = {
        block: vi.fn().mockResolvedValue([]),
      };

      const useCase = new ResolveUseCase({
        queryPlanner: { plan: vi.fn().mockResolvedValue(makePlan()) },
        entityResolver: makeResolver('failed'),
        blocker,
        querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'test' }) },
      });

      await useCase.execute({ query: 'test' });

      // block() must NOT have been called with broader:true
      const callArgs = (blocker.block as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(callArgs?.[2]).not.toEqual({ broader: true });
    });
  });

  it('fails fast on contradictory hard constraints without calling the resolver', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'cheap expensive merlot',
        normalizedQuery: 'cheap expensive merlot',
        intent: 'search',
        route: 'entity',
        retrievalMode: 'entity_lookup',
        queryClass: 'constraint_heavy',
        anchors: [],
        constraints: {
          hard: [
            { attribute: 'price', operator: '<=', value: 20 },
            { attribute: 'price', operator: '>=', value: 50 },
          ],
          soft: [],
          inferred: [],
        },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {},
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      }),
    };

    const entityResolver: EntityResolverPort = {
      resolve: vi.fn(),
    };

    const useCase = new ResolveUseCase({
      queryPlanner,
      entityResolver,
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'cheap expensive merlot' }),
      },
    });

    await expect(useCase.execute({ query: 'cheap expensive merlot', requestId: 'req-constraint' })).resolves.toEqual({
      status: 'failed',
      candidates: [],
      topEntity: undefined,
      decision_trace_ref: expect.stringMatching(/^decision:v1:constraint_heavy:[a-f0-9]{64}$/),
      authority_trace_ref: expect.stringMatching(/^decision:v1:constraint_heavy:[a-f0-9]{64}$/),
      request_id: 'req-constraint',
    });
    expect(entityResolver.resolve).not.toHaveBeenCalled();
  });
});
