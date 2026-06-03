import { describe, expect, it, vi } from 'vitest';
import { buildUseCaseContainerServices } from '../container-usecases.js';
import { parseEnv } from '../env.js';
import { getQueryEntrySecurityMetricsCollector } from '../../infrastructure/observability/query-entry-security-metrics.js';

describe('buildUseCaseContainerServices', () => {
  it('wires the shared query-entry security policy into LLM-bearing public entry use cases, but keeps lookup V2 sanitizer-only', () => {
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
      // T-ELV2-03: buildUseCaseContainerServices reads the alias-registry version
      // from the matcher; provide a minimal stub so the EntityLookupV2 wiring
      // (now the sole lookup authority) constructs.
      aliasMatcher: { getRegistryVersion: vi.fn().mockReturnValue(undefined) },
      entityLookup: { getDocument: vi.fn() },
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

    const useCases = buildUseCaseContainerServices(core as never, config);
    const queryEntrySecurityObserver = getQueryEntrySecurityMetricsCollector();

    expect((useCases.searchUseCase as any).deps).toEqual(expect.objectContaining({
      injectionJudge,
      judgeFailureMode: 'fail_open',
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
    }));
    expect((useCases.hybridUseCase as any).deps).toEqual(expect.objectContaining({
      injectionJudge,
      judgeFailureMode: 'fail_open',
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
    }));
    expect((useCases.interpretUseCase as any).deps).toEqual(expect.objectContaining({
      injectionJudge,
      judgeFailureMode: 'fail_open',
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
    }));
    expect((useCases.resolveUseCase as any).deps).toEqual(expect.objectContaining({
      injectionJudge,
      judgeFailureMode: 'fail_open',
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
    }));
    expect((useCases.entityLookupV2UseCase as any).deps).toEqual(expect.objectContaining({
      querySanitizer,
    }));
    expect((useCases.entityLookupV2UseCase as any).deps).not.toHaveProperty('injectionJudge');
    expect((useCases.entityLookupV2UseCase as any).deps).not.toHaveProperty('judgeFailureMode');
    expect((useCases.entityLookupV2UseCase as any).deps).not.toHaveProperty('judgeTimeoutMs');
    expect((useCases.entityLookupV2UseCase as any).deps).not.toHaveProperty('queryEntrySecurityObserver');
  });
});
