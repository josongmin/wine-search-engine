import { describe, expect, it, vi } from 'vitest';
import { InterpretUseCase } from '../../../../src/application/search/interpret.usecase.js';
import type { QueryPlannerPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

describe('InterpretUseCase', () => {
  it('reuses the shared planner context mapping for locale, session, and budget', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'Ridge Cabernet',
        normalizedQuery: 'ridge cabernet',
        intent: 'search',
        route: 'hybrid',
        retrievalMode: 'semantic_hybrid',
        queryClass: 'known_item',
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

    const previousEntity = createEntityId('prev-entity');
    const useCase = new InterpretUseCase({
      queryPlanner,
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({
          safe: true,
          sanitizedQuery: 'Ridge Cabernet',
        }),
      },
    });

    await useCase.execute({
      query: '  Ridge Cabernet  ',
      context: { locale: 'ko-KR', currency: 'KRW' },
      sessionContext: {
        sessionId: 'session-7',
        previousEntities: [previousEntity],
      },
      queryBudget: {
        maxLatencyMs: 900,
        maxCandidates: 32,
        rerankLimit: 12,
      },
    });

    expect(queryPlanner.plan).toHaveBeenCalledWith('Ridge Cabernet', {
      locale: 'ko-KR',
      session: {
        sessionId: 'session-7',
        previousEntities: [previousEntity],
      },
      budget: {
        maxLatencyMs: 900,
        maxCandidates: 32,
        rerankLimit: 12,
      },
    });
  });
});
