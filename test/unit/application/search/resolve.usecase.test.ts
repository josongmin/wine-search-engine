import { describe, expect, it, vi } from 'vitest';
import { ResolveUseCase } from '../../../../src/application/search/resolve.usecase.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import { decodeAuthorityTraceRefDetailed } from '../../../../src/domain/decision/service/id-schema-decoder.js';
import type {
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

    const entityLookup = {
      getDocument: vi.fn().mockResolvedValue({
        entityId: createEntityId('opus-one-2018'),
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
      }),
    };

    const useCase = new ResolveUseCase({
      queryPlanner,
      entityResolver,
      entityLookup,
      querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: '오푸스원' }) },
    });

    await useCase.execute({ query: '오푸스원' });

    expect(entityLookup.getDocument).toHaveBeenCalledWith(createEntityId('opus-one-2018'));
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
