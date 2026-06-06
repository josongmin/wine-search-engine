import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLookupRuntimeBundleCachePayload,
  deriveLookupRuntimeBundleCachePaths,
  readLookupRuntimeBundleCache,
  writeLookupRuntimeBundleCache,
} from '../lookup-runtime-bundle-cache.js';

describe('lookup runtime bundle cache', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('round-trips a cache payload when manifest and artifact paths match', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lookup-runtime-bundle-cache-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'manifest.json');
    writeFileSync(manifestPath, '{}\n', 'utf8');

    const payload = buildLookupRuntimeBundleCachePayload({
      snapshotId: 'search-snapshot:v1:test',
      aliasContentHash: 'alias-hash',
      manifestPath,
      artifactPaths: {
        lookupAliasRuntimeJson: path.join(dir, 'lookup-alias-runtime.json'),
        lookupAliasBroadRecallRuntimeJson: path.join(dir, 'lookup-alias-broad-recall-runtime.json'),
        lookupExactSafeRuntimeJson: path.join(dir, 'lookup-exact-safe-runtime.json'),
        lookupResolverProjectionJson: path.join(dir, 'lookup-resolver-projection.json'),
        lookupAmbiguityRuntimeJson: path.join(dir, 'lookup-ambiguity-runtime.json'),
        lookupConceptRedirectRuntimeJson: path.join(dir, 'lookup-concept-redirect-runtime.json'),
      },
      aliasRuntimeArtifact: {
        schemaVersion: 'lookup_alias_runtime_core.v1',
        snapshotId: 'search-snapshot:v1:test',
        generatedAt: '2026-06-06T00:00:00.000Z',
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
      },
      aliasBroadRecallRuntimeArtifact: {
        schemaVersion: 'lookup_alias_broad_recall_runtime.v1',
        snapshotId: 'search-snapshot:v1:test',
        generatedAt: '2026-06-06T00:00:00.000Z',
        aliasRegistryHash: 'alias-hash',
        wholeTokenIndex: { opus: [0], one: [0] },
        phoneticIndex: {},
        doubleMetaphoneIndex: {},
        doubleMetaphoneKeysByAliasId: { 'alias-1': [] },
        prefixCatalog: [],
        hangulCompletionRecords: [],
      },
      exactEntries: [[
        'opus one',
        {
          entityId: 'entity-1' as never,
          locale: 'global',
          kind: 'exact_safe',
          normalizedSurface: 'opus one',
        },
      ]],
      compactEntries: [],
      resolverProjectionDocuments: [[
        'entity-1',
        {
          entityId: 'entity-1' as never,
          entityType: 'wine',
          canonicalLabel: 'Opus One',
          aliasesIdentitySafe: ['Opus One'],
          identitySafeKeys: ['opus one'],
        },
      ]],
      ambiguityEntries: [],
      conceptRedirectEntries: [],
    });

    await writeLookupRuntimeBundleCache(payload);
    const reloaded = await readLookupRuntimeBundleCache({
      manifestPath,
      snapshotId: 'search-snapshot:v1:test',
      aliasContentHash: 'alias-hash',
      artifactPaths: payload.artifactPaths,
    });

    expect(reloaded).toEqual(payload);
  });

  it('fails closed when the expected manifest binding changes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lookup-runtime-bundle-cache-'));
    tempDirs.push(dir);
    const manifestPath = path.join(dir, 'manifest.json');
    writeFileSync(manifestPath, '{}\n', 'utf8');

    const payload = buildLookupRuntimeBundleCachePayload({
      snapshotId: 'search-snapshot:v1:test',
      aliasContentHash: 'alias-hash',
      manifestPath,
      artifactPaths: {
        lookupAliasRuntimeJson: path.join(dir, 'lookup-alias-runtime.json'),
        lookupExactSafeRuntimeJson: path.join(dir, 'lookup-exact-safe-runtime.json'),
        lookupResolverProjectionJson: path.join(dir, 'lookup-resolver-projection.json'),
        lookupAmbiguityRuntimeJson: path.join(dir, 'lookup-ambiguity-runtime.json'),
        lookupConceptRedirectRuntimeJson: path.join(dir, 'lookup-concept-redirect-runtime.json'),
      },
      aliasRuntimeArtifact: {
        schemaVersion: 'lookup_alias_runtime_core.v1',
        snapshotId: 'search-snapshot:v1:test',
        generatedAt: '2026-06-06T00:00:00.000Z',
        aliasRegistryHash: 'alias-hash',
        aliases: [],
        surfaceForms: [],
        exactIndex: {},
        compactIndex: {},
      },
      exactEntries: [],
      compactEntries: [],
      resolverProjectionDocuments: [],
      ambiguityEntries: [],
      conceptRedirectEntries: [],
    });

    await writeLookupRuntimeBundleCache(payload);
    const cachePaths = deriveLookupRuntimeBundleCachePaths(manifestPath);
    expect(cachePaths.cachePath).toContain('lookup-runtime-bundle-cache.v8');

    const mismatched = await readLookupRuntimeBundleCache({
      manifestPath,
      snapshotId: 'search-snapshot:v1:test',
      aliasContentHash: 'different-hash',
      artifactPaths: payload.artifactPaths,
    });
    expect(mismatched).toBeUndefined();
  });
});
