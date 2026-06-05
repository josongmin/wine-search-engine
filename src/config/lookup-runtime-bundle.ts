import { SearchSnapshotAliasMatcher } from '../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { SearchSnapshotAmbiguityDictionary } from '../infrastructure/adapter/search-snapshot-ambiguity-dictionary.js';
import { SearchSnapshotConceptRedirectRegistry } from '../infrastructure/adapter/search-snapshot-concept-redirect-registry.js';
import { SearchSnapshotEntityLookup } from '../infrastructure/adapter/search-snapshot-entity-lookup.js';
import { SearchSnapshotExactSafeRegistry } from '../infrastructure/adapter/search-snapshot-exact-safe-registry.js';
import { SearchSnapshotResolverProjectionLookup } from '../infrastructure/adapter/search-snapshot-resolver-projection-lookup.js';

export interface LookupRuntimeBundle {
  readonly cacheKey: string;
  readonly manifestPath: string;
  readonly aliasMatcher: SearchSnapshotAliasMatcher;
  readonly entityLookup: SearchSnapshotEntityLookup;
  readonly resolverProjectionLookup: SearchSnapshotResolverProjectionLookup;
  readonly ambiguityDictionary: SearchSnapshotAmbiguityDictionary;
  readonly conceptRedirectRegistry: SearchSnapshotConceptRedirectRegistry;
  readonly exactSafeRegistry: SearchSnapshotExactSafeRegistry;
}

const lookupRuntimeBundleCache = new Map<string, Promise<LookupRuntimeBundle>>();
const manifestPathByCacheKey = new Map<string, string>();

export async function loadLookupRuntimeBundle(
  cacheKey: string,
  manifestPath: string,
): Promise<LookupRuntimeBundle> {
  const knownManifestPath = manifestPathByCacheKey.get(cacheKey);
  if (knownManifestPath !== undefined && knownManifestPath !== manifestPath) {
    throw new Error(
      `Lookup runtime bundle cache key "${cacheKey}" reused with different manifestPath: ${knownManifestPath} vs ${manifestPath}`,
    );
  }
  const existing = lookupRuntimeBundleCache.get(cacheKey);
  if (existing !== undefined) {
    return await existing;
  }

  manifestPathByCacheKey.set(cacheKey, manifestPath);
  const pending = (async (): Promise<LookupRuntimeBundle> => {
    const [
      aliasMatcher,
      entityLookup,
      resolverProjectionLookup,
      ambiguityDictionary,
      conceptRedirectRegistry,
      exactSafeRegistry,
    ] = await Promise.all([
      SearchSnapshotAliasMatcher.loadFromManifest(manifestPath),
      SearchSnapshotEntityLookup.loadFromManifest(manifestPath),
      SearchSnapshotResolverProjectionLookup.loadFromManifest(manifestPath),
      SearchSnapshotAmbiguityDictionary.loadFromManifest(manifestPath),
      SearchSnapshotConceptRedirectRegistry.loadFromManifest(manifestPath),
      SearchSnapshotExactSafeRegistry.loadFromManifest(manifestPath),
    ]);

    if (aliasMatcher === undefined) {
      throw new Error(`Lookup runtime bundle failed to load alias runtime from ${manifestPath}`);
    }

    return {
      cacheKey,
      manifestPath,
      aliasMatcher,
      entityLookup,
      resolverProjectionLookup,
      ambiguityDictionary,
      conceptRedirectRegistry,
      exactSafeRegistry,
    };
  })();

  lookupRuntimeBundleCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    lookupRuntimeBundleCache.delete(cacheKey);
    manifestPathByCacheKey.delete(cacheKey);
    throw error;
  }
}

export function clearLookupRuntimeBundleCacheForTests(): void {
  lookupRuntimeBundleCache.clear();
  manifestPathByCacheKey.clear();
}
