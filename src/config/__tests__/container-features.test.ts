import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';

const buildUseCaseContainerServices = vi.fn(() => ({
  searchUseCase: { execute: vi.fn() } as never,
  interpretUseCase: {} as never,
  hybridUseCase: {} as never,
  decomposedSearchUseCase: {} as never,
  drinkingWindowUseCase: {} as never,
  batchSearchUseCase: {} as never,
}));
const buildEvalRunner = vi.fn(() => 'eval-runner');

vi.mock('../container-usecases.js', () => ({
  buildUseCaseContainerServices,
}));

vi.mock('../container-aux-features.js', () => ({
  buildEvalRunner,
}));

describe('buildFeatureContainerServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the prebuilt lookup authority instead of constructing a second ELV2 use case', async () => {
    const { buildFeatureContainerServices } = await import('../container-features.js');
    const config = parseEnv({ NODE_ENV: 'test' });
    const lookupAuthority = {
      entityLookupV2UseCase: { execute: vi.fn() },
      resolverProjectionLookup: { getResolverProjections: vi.fn() },
      bootstrapProfile: {} as never,
      metadata: {} as never,
    };

    const features = buildFeatureContainerServices(
      config,
      {} as never,
      lookupAuthority as never,
      { pool: { totalCount: 0 } as never },
    );

    expect(buildUseCaseContainerServices).toHaveBeenCalledWith(
      expect.anything(),
      config,
      {},
      {
        entityLookupV2UseCase: lookupAuthority.entityLookupV2UseCase,
        resolverProjectionLookup: lookupAuthority.resolverProjectionLookup,
      },
    );
    expect(features.entityLookupV2UseCase).toBe(lookupAuthority.entityLookupV2UseCase);
    expect(features.evalRunner).toBe('eval-runner');
  });
});
