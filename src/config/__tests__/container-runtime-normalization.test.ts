import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';

const builderCalls = vi.hoisted(() => ({
  core: vi.fn(),
  features: vi.fn(),
  bind: vi.fn(),
  authority: vi.fn(),
}));

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
  buildFeatureContainerServices: vi.fn((_config, _core, _authority, runtime) => {
    builderCalls.features(runtime);
    return {
      entityLookupV2UseCase: {} as never,
      searchUseCase: {} as never,
      evalRunner: null,
    };
  }),
}));

vi.mock('../lookup-authority.js', () => ({
  createLookupAuthorityServices: vi.fn(async (_config, runtime, prebuilt) => {
    builderCalls.authority(runtime, prebuilt);
    return {
      entityLookupV2UseCase: {} as never,
      bootstrapProfile: {} as never,
      metadata: {} as never,
    };
  }),
}));

vi.mock('../runtime-handles.js', () => ({
  bindLiveSearchSnapshotRuntimeHandles: vi.fn(async (runtime) => {
    builderCalls.bind(runtime);
    return {
      ...runtime,
      searchSnapshotId: 'search-snapshot:v1:active',
      searchSnapshotManifestPath: '/tmp/search-snapshot:v1:active/manifest.json',
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

    expect(builderCalls.bind).toHaveBeenCalledWith({ pool });
    expect(builderCalls.core).toHaveBeenCalledWith({
      pool,
      searchSnapshotId: 'search-snapshot:v1:active',
      searchSnapshotManifestPath: '/tmp/search-snapshot:v1:active/manifest.json',
    });
    expect(builderCalls.authority).toHaveBeenCalledWith(
      {
        pool,
        searchSnapshotId: 'search-snapshot:v1:active',
        searchSnapshotManifestPath: '/tmp/search-snapshot:v1:active/manifest.json',
      },
      {
        calibrationStore: mockCore.calibrationStore,
        entityResolver: mockCore.entityResolver,
      },
    );
    expect(builderCalls.features).toHaveBeenCalledWith({
      pool,
      searchSnapshotId: 'search-snapshot:v1:active',
      searchSnapshotManifestPath: '/tmp/search-snapshot:v1:active/manifest.json',
    });
  }, 10_000);
});
