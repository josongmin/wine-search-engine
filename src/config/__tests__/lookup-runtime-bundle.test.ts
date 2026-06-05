import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearLookupRuntimeBundleCacheForTests, loadLookupRuntimeBundle } from '../lookup-runtime-bundle.js';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../domain/shared/constants/search-snapshot.js';

function buildManifest(manifestPath: string): string {
  const base = manifestPath.replace(/\/manifest\.json$/, '');
  return JSON.stringify({
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'search-snapshot:v1:test',
    hashes: {
      aliases: 'alias-hash',
    },
    artifacts: {
      lookupAliasRuntimeJson: `${base}/lookup-alias-runtime.json`,
      lookupExactSafeRuntimeJson: `${base}/lookup-exact-safe-runtime.json`,
      lookupResolverProjectionJson: `${base}/lookup-resolver-projection.json`,
      lookupEntityProjectionJson: `${base}/lookup-entity-projection.json`,
      lookupAmbiguityRuntimeJson: `${base}/lookup-ambiguity-runtime.json`,
      lookupConceptRedirectRuntimeJson: `${base}/lookup-concept-redirect-runtime.json`,
    },
  });
}

function buildArtifactMap(manifestPath: string): ReadonlyMap<string, string> {
  const base = manifestPath.replace(/\/manifest\.json$/, '');
  return new Map<string, string>([
    [manifestPath, buildManifest(manifestPath)],
    [`${base}/lookup-alias-runtime.json`, JSON.stringify({
      schemaVersion: 'lookup_alias_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-05T00:00:00.000Z',
      aliasRegistryHash: 'alias-hash',
      aliases: [
        {
          aliasId: 'alias-1',
          entityId: 'entity-1',
          value: 'Opus One',
          normalizedValue: 'opus one',
          sourceTrust: 1,
          confidencePrior: 0.99,
          aliasType: 'canonical',
        },
      ],
      surfaceForms: ['Opus One'],
      exactIndex: { 'opus one': [0] },
      compactIndex: { opusone: [0] },
      wholeTokenIndex: { opus: [0], one: [0] },
      phoneticIndex: {},
      doubleMetaphoneIndex: {},
      doubleMetaphoneKeysByAliasId: { 'alias-1': [] },
      prefixCatalog: [],
      hangulCompletionRecords: [],
    })],
    [`${base}/lookup-exact-safe-runtime.json`, JSON.stringify({
      schemaVersion: 'lookup_exact_safe_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-05T00:00:00.000Z',
      exactEntries: {
        'opus one': {
          entityId: 'entity-1',
          locale: 'global',
          certificate: {
            kind: 'exact_safe',
            normalizedSurface: 'opus one',
            sourceTier: 'curated',
            singleton: true,
            collisionFree: true,
          },
        },
      },
      compactEntries: {},
    })],
    [`${base}/lookup-resolver-projection.json`, JSON.stringify({
      schemaVersion: 'lookup_resolver_projection.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-05T00:00:00.000Z',
      documents: [
        {
          entityId: 'entity-1',
          entityType: 'wine',
          canonicalLabel: 'Opus One',
          aliasesIdentitySafe: ['Opus One'],
          identitySafeKeys: ['opus one'],
        },
      ],
    })],
    [`${base}/lookup-entity-projection.json`, JSON.stringify({
      schemaVersion: 'lookup_entity_projection.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-05T00:00:00.000Z',
      documents: [
        {
          entityId: 'entity-1',
          entityType: 'wine',
          canonicalLabel: 'Opus One',
          aliasesIdentitySafe: ['Opus One'],
          identitySafeKeys: ['opus one'],
          aliasesNoisyRecall: [],
          producer: 'Opus One Winery',
          region: 'Napa Valley',
          grapes: [],
          searchTextKo: '',
          searchTextEn: 'Opus One',
          semanticSummary: '',
          pairing: [],
          availability: true,
          popularityScore: 1,
        },
      ],
    })],
    [`${base}/lookup-ambiguity-runtime.json`, JSON.stringify({
      schemaVersion: 'lookup_ambiguity_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-05T00:00:00.000Z',
      entries: {},
    })],
    [`${base}/lookup-concept-redirect-runtime.json`, JSON.stringify({
      schemaVersion: 'lookup_concept_redirect_runtime.v1',
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-05T00:00:00.000Z',
      entries: {},
    })],
  ]);
}

describe('lookup runtime bundle cache', () => {
  beforeEach(() => {
    clearLookupRuntimeBundleCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearLookupRuntimeBundleCacheForTests();
  });

  it('loads the bundle from one manifest read plus one fanout read per artifact and reuses it for the same snapshot key', async () => {
    const manifestPath = '/tmp/runtime-a/manifest.json';
    const artifactMap = buildArtifactMap(manifestPath);
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (pathLike) => {
      const key = String(pathLike);
      const value = artifactMap.get(key);
      if (value === undefined) {
        throw new Error(`unexpected read: ${key}`);
      }
      return value as never;
    });

    const first = await loadLookupRuntimeBundle('search-snapshot:v1:test', manifestPath);
    const second = await loadLookupRuntimeBundle('search-snapshot:v1:test', manifestPath);

    expect(first).toBe(second);
    expect(readFileSpy).toHaveBeenCalledTimes(6);
    expect(first.aliasMatcher.getRegistryVersion()?.snapshotId).toBe('search-snapshot:v1:test');
    expect(await first.entityLookup.getDocument('entity-1' as never)).not.toBeNull();
  });

  it('fails closed when the same cache key is rebound to a different manifest path', async () => {
    const manifestPath = '/tmp/runtime-a/manifest.json';
    const artifactMap = buildArtifactMap(manifestPath);
    vi.spyOn(fs, 'readFile').mockImplementation(async (pathLike) => {
      const key = String(pathLike);
      const value = artifactMap.get(key);
      if (value === undefined) {
        throw new Error(`unexpected read: ${key}`);
      }
      return value as never;
    });

    await loadLookupRuntimeBundle('search-snapshot:v1:test', manifestPath);

    await expect(
      loadLookupRuntimeBundle('search-snapshot:v1:test', '/tmp/runtime-b/manifest.json'),
    ).rejects.toThrow(/reused with different manifestPath/);
  });

  it('derives resolver certificates and attribute hints from entity and exact-safe runtimes even when entity overlay fields are absent', async () => {
    const manifestPath = '/tmp/runtime-a/manifest.json';
    const artifactMap = new Map(buildArtifactMap(manifestPath));
    const entityProjectionPath = '/tmp/runtime-a/lookup-entity-projection.json';
    const raw = artifactMap.get(entityProjectionPath);
    if (raw === undefined) {
      throw new Error('missing test entity projection artifact');
    }
    const parsed = JSON.parse(raw) as { documents: Array<Record<string, unknown>> };
    for (const doc of parsed.documents) {
      delete doc['identitySafeKeys'];
    }
    artifactMap.set(entityProjectionPath, JSON.stringify(parsed));

    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (pathLike) => {
      const key = String(pathLike);
      const value = artifactMap.get(key);
      if (value === undefined) {
        throw new Error(`unexpected read: ${key}`);
      }
      return value as never;
    });

    const bundle = await loadLookupRuntimeBundle('search-snapshot:v1:test', manifestPath);
    const projections = await bundle.resolverProjectionLookup.getResolverProjections(['entity-1' as never]);
    const projection = projections.get('entity-1' as never);

    expect(projection).toBeDefined();
    expect(projection?.identitySafeKeys).toContain('opus one');
    expect(projection?.identityCertificates).toEqual([
      {
        kind: 'exact_safe',
        normalizedSurface: 'opus one',
        sourceTier: 'curated',
        singleton: true,
        collisionFree: true,
      },
    ]);
    expect(projection?.attributeHints).toMatchObject({
      producer: 'Opus One Winery',
      region: 'Napa Valley',
    });
    expect(readFileSpy).toHaveBeenCalledTimes(6);
  });

  it('clears the cache entry after a failed load so a retry can succeed', async () => {
    const manifestPath = '/tmp/runtime-a/manifest.json';
    const artifactMap = buildArtifactMap(manifestPath);
    let shouldFail = true;
    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (pathLike) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('synthetic manifest read failure');
      }
      const key = String(pathLike);
      const value = artifactMap.get(key);
      if (value === undefined) {
        throw new Error(`unexpected read: ${key}`);
      }
      return value as never;
    });

    await expect(
      loadLookupRuntimeBundle('search-snapshot:v1:test', manifestPath),
    ).rejects.toThrow('synthetic manifest read failure');

    const recovered = await loadLookupRuntimeBundle('search-snapshot:v1:test', manifestPath);

    expect(recovered.aliasMatcher).toBeDefined();
    expect(readFileSpy).toHaveBeenCalledTimes(7);
  });
});
