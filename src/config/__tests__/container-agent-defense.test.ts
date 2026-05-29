import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';

/**
 * Defense-in-depth test for AGENT_ENABLED wiring.
 *
 * env.ts already throws at config-load time when `AGENT_ENABLED=true` and
 * `OPENAI_API_KEY` is missing. The defense-in-depth assertion in container.ts
 * (`if (config.agent.enabled && core.chatLlm === undefined) throw`) catches a
 * separate failure mode: env validation is loosened or bypassed but the
 * chatLlm construction fails. We mock buildCoreContainerServices to simulate
 * "env said yes, but chatLlm came back undefined" — this is otherwise
 * unreachable from real config and would silently 404 the agent route if the
 * defense disappears.
 */

const mockCore = {
  queryPlanner: {} as never,
  entityResolver: {} as never,
  candidatePool: {} as never,
  ranker: {} as never,
  decisionEngine: {} as never,
  responseBuilder: {} as never,
  mixedSolver: {} as never,
  drinkingWindowPredictor: {} as never,
  calibrationStore: {} as never,
  browseRetriever: {} as never,
  compareRetriever: {} as never,
  entityLookup: {} as never,
  snapshotVersions: {} as never,
  cacheLookupRuntimeState: {} as never,
  cacheLookupRuntimeStateProvider: {} as never,
  querySanitizer: {} as never,
  injectionJudge: undefined,
  cacheService: undefined,
  ltrModels: undefined,
  phraseCache: undefined,
  // Critical: chatLlm intentionally undefined despite agent.enabled=true
  chatLlm: undefined,
};

vi.mock('../container-core.js', () => ({
  buildCoreContainerServices: vi.fn(async () => mockCore),
}));

vi.mock('../container-features.js', () => ({
  buildFeatureContainerServices: vi.fn(() => ({
    searchUseCase: {} as never,
    decomposedSearchUseCase: { execute: vi.fn() } as never,
    interpretUseCase: {} as never,
    resolveUseCase: {} as never,
    hybridUseCase: {} as never,
    batchSearchUseCase: {} as never,
  })),
}));

vi.mock('../container-aux-features.js', () => ({
  buildWatchlistContainerServices: vi.fn(() => ({})),
  buildLearningContainerServices: vi.fn(() => ({
    feedbackStore: null,
    feedbackProcessor: undefined,
    feedbackIngestUseCase: undefined,
  })),
}));

describe('createContainer defense-in-depth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when AGENT_ENABLED=true but chatLlm is missing (env-validation bypass case)', async () => {
    const { createContainer } = await import('../container.js');
    // Use parseEnv to construct a valid Config that env-validates cleanly
    // (agent.enabled=true with OPENAI_API_KEY present). The mocked
    // buildCoreContainerServices then drops chatLlm to simulate the
    // unreachable-in-real-config edge case the defense-in-depth guards.
    const config = parseEnv({
      NODE_ENV: 'test',
      AGENT_ENABLED: 'true',
      OPENAI_API_KEY: 'sk-test',
    });

    await expect(createContainer(config)).rejects.toThrowError(
      /AGENT_ENABLED=true but no ChatLlm was constructed/,
    );
  });
});
