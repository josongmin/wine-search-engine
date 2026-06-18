import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../env.js';
import { StubCalibrationStore } from '../container-stubs.js';

const semanticScopeRegistry = {
  findMatches: vi.fn(() => []),
  getReviewedTargetEntityIds: vi.fn(() => []),
};
const reviewedFamilyRecallRegistry = {
  findMatches: vi.fn(() => []),
};
const entityScopeGraph = {
  getRelatedEntities: vi.fn(async () => []),
  countEdgesByRelation: vi.fn(() => 2),
};
const resolverProjectionLookup = {
  getResolverProjections: vi.fn(async () => new Map()),
};
const ambiguityDictionary = {
  getAmbiguityInfo: vi.fn(async () => null),
};
const conceptRedirectRegistry = {
  match: vi.fn(() => null),
};
const exactSafeRegistry = {
  matchExactSingleton: vi.fn(() => null),
};
const aliasMatcher = {
  getRegistryVersion: vi.fn(() => undefined),
  findMatches: vi.fn(async () => []),
};
const entityResolver = { resolve: vi.fn() };
const prebuiltEntityResolver = { resolve: vi.fn() };
const loadLookupRuntimeBundle = vi.fn(async () => ({
  aliasMatcher,
  resolverProjectionLookup,
  semanticScopeRegistry,
  reviewedFamilyRecallRegistry,
  entityScopeGraph,
  ambiguityDictionary,
  conceptRedirectRegistry,
  exactSafeRegistry,
  loadProfile: { cacheHit: true } as never,
}));
const buildEntityResolver = vi.fn(() => entityResolver);

vi.mock('../lookup-runtime-bundle.js', () => ({
  loadLookupRuntimeBundle,
}));

vi.mock('../container-core-builders.js', () => ({
  buildEntityResolver,
}));

describe('createLookupAuthorityServices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('wires semantic scope, reviewed family recall, and scope graph through the shared ELV2 authority builder', async () => {
    const { createLookupAuthorityServices } = await import('../lookup-authority.js');
    const config = parseEnv({ NODE_ENV: 'test' });

    const authority = await createLookupAuthorityServices(config, {
      searchSnapshotId: 'search-snapshot:v1:test',
      searchSnapshotManifestPath: '/tmp/search-snapshot:v1:test/manifest.json',
    });

    expect(loadLookupRuntimeBundle).toHaveBeenCalledWith(
      'search-snapshot:v1:test',
      '/tmp/search-snapshot:v1:test/manifest.json',
    );
    const deps = (authority.entityLookupV2UseCase as any).deps;
    expect(deps.semanticScopeRegistry).toBe(semanticScopeRegistry);
    expect(deps.resolverProjectionLookup).toBe(resolverProjectionLookup);
    expect(authority.resolverProjectionLookup).toBe(resolverProjectionLookup);
    expect(deps.ambiguityDictionary).toBe(ambiguityDictionary);
    expect((deps.candidateRetrieval).deps.reviewedFamilyRecall).toBe(reviewedFamilyRecallRegistry);
    expect((deps.candidateRetrieval).deps.entityScopeGraph).toBe(entityScopeGraph);
    expect(authority.metadata).toEqual({
      searchSnapshotId: 'search-snapshot:v1:test',
      searchSnapshotManifestPath: '/tmp/search-snapshot:v1:test/manifest.json',
      runtimeBundleCacheKey: 'search-snapshot:v1:test',
      familyGraphEdgeCount: 2,
    });
    expect(authority.bootstrapProfile.substrateCapabilities.ltrSupportReason).toBe('lookup_domain_model_absent');
    expect(authority.bootstrapProfile.substrateCapabilities.unwiredSubstrates).toHaveLength(2);
  });

  it('reuses prebuilt resolver and calibration store when provided by the full container path', async () => {
    const { createLookupAuthorityServices } = await import('../lookup-authority.js');
    const config = parseEnv({ NODE_ENV: 'test' });
    const calibrationStore = new StubCalibrationStore();

    const authority = await createLookupAuthorityServices(
      config,
      {
        searchSnapshotId: 'search-snapshot:v1:test',
        searchSnapshotManifestPath: '/tmp/search-snapshot:v1:test/manifest.json',
      },
      {
        calibrationStore,
        entityResolver: prebuiltEntityResolver as never,
      },
    );

    const deps = (authority.entityLookupV2UseCase as any).deps;
    expect(deps.entityResolver).toBe(prebuiltEntityResolver);
    expect(buildEntityResolver).toHaveBeenCalledTimes(0);
  });

  it('buildLookupOpsRuntimeHealthView projects metadata and substrate capabilities', async () => {
    const { createLookupAuthorityServices, buildLookupOpsRuntimeHealthView } = await import('../lookup-authority.js');
    const config = parseEnv({ NODE_ENV: 'test' });
    const authority = await createLookupAuthorityServices(config, {
      searchSnapshotId: 'search-snapshot:v1:test',
      searchSnapshotManifestPath: '/tmp/search-snapshot:v1:test/manifest.json',
    });
    const view = buildLookupOpsRuntimeHealthView(authority);
    expect(view.searchSnapshotId).toBe('search-snapshot:v1:test');
    expect(view.familyGraphEdgeCount).toBe(2);
    expect(view.unwiredSubstrateIds).toContain('lookup_ltr_rerank');
  });
});
