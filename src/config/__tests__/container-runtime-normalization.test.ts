import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';

const builderCalls = vi.hoisted(() => ({
  core: vi.fn(),
  features: vi.fn(),
}));

const mockCore = {
  queryPlanner: {} as never,
  entityResolver: {} as never,
  candidatePool: {} as never,
  ranker: {} as never,
  decisionEngine: {} as never,
  responseBuilder: {} as never,
  mixedSolver: {} as never,
  entityLookup: {} as never,
  drinkingWindowPredictor: {} as never,
  calibrationStore: {} as never,
  runtimeReadiness: {} as never,
  querySanitizer: {} as never,
  chatLlm: undefined,
};

vi.mock('../container-core.js', () => ({
  buildCoreContainerServices: vi.fn(async (_config, runtime) => {
    builderCalls.core(runtime);
    return mockCore;
  }),
}));

vi.mock('../container-features.js', () => ({
  buildFeatureContainerServices: vi.fn((_config, _core, runtime) => {
    builderCalls.features(runtime);
    return {
      searchUseCase: {} as never,
      interpretUseCase: {} as never,
      resolveUseCase: {} as never,
      autocompleteUseCase: {} as never,
      hybridUseCase: {} as never,
      decomposedSearchUseCase: {} as never,
      drinkingWindowUseCase: {} as never,
      batchSearchUseCase: {} as never,
      evalRunner: null,
    };
  }),
}));

describe('createContainer runtime normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wraps a raw pg Pool-like runtime into RuntimeHandles for downstream builders', async () => {
    const { createContainer } = await import('../container.js');
    const config = parseEnv({ NODE_ENV: 'test' });
    const pool = { totalCount: 0 } as never;

    await createContainer(config, pool);

    expect(builderCalls.core).toHaveBeenCalledWith({ pool });
    expect(builderCalls.features).toHaveBeenCalledWith({ pool });
  }, 10_000);
});
