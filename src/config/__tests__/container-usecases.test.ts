import { describe, expect, it, vi } from 'vitest';
import { buildUseCaseContainerServices } from '../container-usecases.js';
import { parseEnv } from '../env.js';
import { getQueryEntrySecurityMetricsCollector } from '../../infrastructure/observability/query-entry-security-metrics.js';

describe('buildUseCaseContainerServices', () => {
  it('wires the shared query-entry security policy into LLM-bearing public entry use cases only', () => {
    const config = parseEnv({
      NODE_ENV: 'test',
      INJECTION_JUDGE_FAIL_OPEN: 'true',
    });
    const injectionJudge = { judge: vi.fn() };
    const querySanitizer = {
      sanitize: vi.fn().mockReturnValue({
        safe: true,
        sanitizedQuery: 'Opus One',
      }),
    };
    const core = {
      queryPlanner: { plan: vi.fn() },
      entityResolver: { resolve: vi.fn() },
      candidatePool: { generate: vi.fn() },
      browseRetriever: { retrieve: vi.fn() },
      compareRetriever: { retrieve: vi.fn() },
      ranker: { rank: vi.fn() },
      decisionEngine: { decide: vi.fn() },
      responseBuilder: { build: vi.fn() },
      mixedSolver: { solve: vi.fn() },
      snapshotVersions: { modelVersions: {}, indexVersions: {}, featureFlags: {} },
      querySanitizer,
      injectionJudge,
      cacheService: { getSearchResponse: vi.fn(), setSearchResponse: vi.fn() },
      ltrModels: new Map(),
      drinkingWindowPredictor: {
        modelVersion: 'heuristic-test',
        predict: vi.fn().mockReturnValue({
          drinkingWindowStart: 2020,
          drinkingWindowEnd: 2030,
          confidence: 0.8,
          modelVersion: 'heuristic-test',
        }),
      },
    };

    const useCases = buildUseCaseContainerServices(core as never, config, {}, {
      entityLookupV2UseCase: { execute: vi.fn() },
      resolverProjectionLookup: { getResolverProjections: vi.fn() },
    });
    const queryEntrySecurityObserver = getQueryEntrySecurityMetricsCollector();

    expect((useCases.searchUseCase as any).deps).toEqual(expect.objectContaining({
      injectionJudge,
      judgeFailureMode: 'fail_open',
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
      entityLookupV2UseCase: { execute: expect.any(Function) },
    }));
    expect((useCases.hybridUseCase as any).deps).toEqual(expect.objectContaining({
      injectionJudge,
      judgeFailureMode: 'fail_open',
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
      entityLookupV2UseCase: { execute: expect.any(Function) },
    }));
    expect((useCases.interpretUseCase as any).deps).toEqual(expect.objectContaining({
      injectionJudge,
      judgeFailureMode: 'fail_open',
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
    }));
    expect(useCases).not.toHaveProperty('entityLookupV2UseCase');
  });
});
