import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLookupRuntimeBundle, clearLookupRuntimeBundleCacheForTests } from '../lookup-runtime-bundle.js';
import { SearchSnapshotAliasMatcher } from '../../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { SearchSnapshotEntityLookup } from '../../infrastructure/adapter/search-snapshot-entity-lookup.js';
import { SearchSnapshotResolverProjectionLookup } from '../../infrastructure/adapter/search-snapshot-resolver-projection-lookup.js';
import { SearchSnapshotAmbiguityDictionary } from '../../infrastructure/adapter/search-snapshot-ambiguity-dictionary.js';
import { SearchSnapshotConceptRedirectRegistry } from '../../infrastructure/adapter/search-snapshot-concept-redirect-registry.js';
import { SearchSnapshotExactSafeRegistry } from '../../infrastructure/adapter/search-snapshot-exact-safe-registry.js';

describe('lookup runtime bundle cache', () => {
  beforeEach(() => {
    clearLookupRuntimeBundleCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearLookupRuntimeBundleCacheForTests();
  });

  it('reuses artifact-backed lookup substrates for the same snapshot cache key', async () => {
    const aliasMatcher = { getRegistryVersion: vi.fn().mockReturnValue(undefined) };
    const entityLookup = { getDocument: vi.fn(), getDocuments: vi.fn(), getDrinkingWindowDocuments: vi.fn() };
    const resolverProjectionLookup = { getResolverProjections: vi.fn() };
    const ambiguityDictionary = {
      isKnownAmbiguous: vi.fn(),
      getAmbiguityInfo: vi.fn(),
      getAmbiguityInfoBatch: vi.fn(),
    };
    const conceptRedirectRegistry = { get: vi.fn() };
    const exactSafeRegistry = { match: vi.fn() };

    const aliasSpy = vi.spyOn(SearchSnapshotAliasMatcher, 'loadFromManifest').mockResolvedValue(aliasMatcher as never);
    const entitySpy = vi.spyOn(SearchSnapshotEntityLookup, 'loadFromManifest').mockResolvedValue(entityLookup as never);
    const resolverSpy = vi.spyOn(SearchSnapshotResolverProjectionLookup, 'loadFromManifest').mockResolvedValue(resolverProjectionLookup as never);
    const ambiguitySpy = vi.spyOn(SearchSnapshotAmbiguityDictionary, 'loadFromManifest').mockResolvedValue(ambiguityDictionary as never);
    const conceptSpy = vi.spyOn(SearchSnapshotConceptRedirectRegistry, 'loadFromManifest').mockResolvedValue(conceptRedirectRegistry as never);
    const exactSafeSpy = vi.spyOn(SearchSnapshotExactSafeRegistry, 'loadFromManifest').mockResolvedValue(exactSafeRegistry as never);

    const first = await loadLookupRuntimeBundle('search-snapshot:v1:test', '/tmp/manifest.json');
    const second = await loadLookupRuntimeBundle('search-snapshot:v1:test', '/tmp/manifest.json');

    expect(first).toBe(second);
    expect(aliasSpy).toHaveBeenCalledTimes(1);
    expect(entitySpy).toHaveBeenCalledTimes(1);
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    expect(ambiguitySpy).toHaveBeenCalledTimes(1);
    expect(conceptSpy).toHaveBeenCalledTimes(1);
    expect(exactSafeSpy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the same cache key is rebound to a different manifest path', async () => {
    vi.spyOn(SearchSnapshotAliasMatcher, 'loadFromManifest').mockResolvedValue({ getRegistryVersion: vi.fn() } as never);
    vi.spyOn(SearchSnapshotEntityLookup, 'loadFromManifest').mockResolvedValue({ getDocument: vi.fn(), getDocuments: vi.fn(), getDrinkingWindowDocuments: vi.fn() } as never);
    vi.spyOn(SearchSnapshotResolverProjectionLookup, 'loadFromManifest').mockResolvedValue({ getResolverProjections: vi.fn() } as never);
    vi.spyOn(SearchSnapshotAmbiguityDictionary, 'loadFromManifest').mockResolvedValue({ isKnownAmbiguous: vi.fn(), getAmbiguityInfo: vi.fn(), getAmbiguityInfoBatch: vi.fn() } as never);
    vi.spyOn(SearchSnapshotConceptRedirectRegistry, 'loadFromManifest').mockResolvedValue({ get: vi.fn() } as never);
    vi.spyOn(SearchSnapshotExactSafeRegistry, 'loadFromManifest').mockResolvedValue({ match: vi.fn() } as never);

    await loadLookupRuntimeBundle('search-snapshot:v1:test', '/tmp/manifest-a.json');

    await expect(
      loadLookupRuntimeBundle('search-snapshot:v1:test', '/tmp/manifest-b.json'),
    ).rejects.toThrow(/reused with different manifestPath/);
  });

  it('clears the cache entry after a failed load so a retry can succeed', async () => {
    let shouldFail = true;
    const aliasSpy = vi.spyOn(SearchSnapshotAliasMatcher, 'loadFromManifest').mockImplementation(async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('synthetic alias load failure');
      }
      return { getRegistryVersion: vi.fn().mockReturnValue(undefined) } as never;
    });
    vi.spyOn(SearchSnapshotEntityLookup, 'loadFromManifest').mockResolvedValue({ getDocument: vi.fn(), getDocuments: vi.fn(), getDrinkingWindowDocuments: vi.fn() } as never);
    vi.spyOn(SearchSnapshotResolverProjectionLookup, 'loadFromManifest').mockResolvedValue({ getResolverProjections: vi.fn() } as never);
    vi.spyOn(SearchSnapshotAmbiguityDictionary, 'loadFromManifest').mockResolvedValue({ isKnownAmbiguous: vi.fn(), getAmbiguityInfo: vi.fn(), getAmbiguityInfoBatch: vi.fn() } as never);
    vi.spyOn(SearchSnapshotConceptRedirectRegistry, 'loadFromManifest').mockResolvedValue({ get: vi.fn() } as never);
    vi.spyOn(SearchSnapshotExactSafeRegistry, 'loadFromManifest').mockResolvedValue({ match: vi.fn() } as never);

    await expect(
      loadLookupRuntimeBundle('search-snapshot:v1:test', '/tmp/manifest.json'),
    ).rejects.toThrow('synthetic alias load failure');

    const recovered = await loadLookupRuntimeBundle('search-snapshot:v1:test', '/tmp/manifest.json');

    expect(recovered.aliasMatcher).toBeDefined();
    expect(aliasSpy).toHaveBeenCalledTimes(2);
  });
});
