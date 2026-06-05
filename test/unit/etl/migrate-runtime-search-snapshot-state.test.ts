import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateRuntimeSearchSnapshotState } from '../../../scripts/etl/migrate-runtime-search-snapshot-state.js';
import {
  SEARCH_SNAPSHOT_SCHEMA_VERSION,
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../../src/domain/shared/constants/search-snapshot.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'migrate-runtime-state-'));
}

function makeCurrentManifest(dir: string) {
  return {
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'search-snapshot:v1:test',
    generatedAt: '2026-06-04T10:00:00.000Z',
    contentHash: 'content-hash',
    sourceInputPath: '/tmp/silver-trackc.ndjson',
    artifacts: {
      documentsNdjson: path.join(dir, 'documents.ndjson'),
      vespaFeedNdjson: path.join(dir, 'vespa-feed.ndjson'),
      entitiesNdjson: path.join(dir, 'entities.ndjson'),
      aliasesNdjson: path.join(dir, 'aliases.ndjson'),
      lookupAliasRuntimeJson: path.join(dir, 'lookup-alias-runtime.json'),
      lookupExactSafeRuntimeJson: path.join(dir, 'lookup-exact-safe-runtime.json'),
      lookupResolverProjectionJson: path.join(dir, 'lookup-resolver-projection.json'),
      lookupEntityProjectionJson: path.join(dir, 'lookup-entity-projection.json'),
      lookupAmbiguityRuntimeJson: path.join(dir, 'lookup-ambiguity-runtime.json'),
      lookupConceptRedirectRuntimeJson: path.join(dir, 'lookup-concept-redirect-runtime.json'),
      ambiguityRegistryNdjson: path.join(dir, 'ambiguity.ndjson'),
      nlMappingsJson: path.join(dir, 'nl-mappings.json'),
      metadataJson: path.join(dir, 'metadata.json'),
    },
    counts: {
      documents: 1,
      vespaFeed: 1,
      entities: 1,
      aliases: 1,
      lookupAliasRuntimeAliases: 1,
      lookupExactSafeRuntimeEntries: 1,
      lookupResolverProjectionDocuments: 1,
      lookupEntityProjectionDocuments: 1,
      lookupAmbiguityRuntimeEntries: 0,
      lookupConceptRedirectRuntimeEntries: 0,
      ambiguityRegistry: 0,
      nlMappings: 1,
    },
    hashes: {
      documents: 'documents-hash',
      vespaFeed: 'vespa-feed-hash',
      entities: 'entities-hash',
      aliases: 'aliases-hash',
      lookupAliasRuntime: 'lookup-alias-runtime-hash',
      lookupExactSafeRuntime: 'lookup-exact-safe-runtime-hash',
      lookupResolverProjection: 'lookup-resolver-projection-hash',
      lookupEntityProjection: 'lookup-entity-projection-hash',
      lookupAmbiguityRuntime: 'lookup-ambiguity-runtime-hash',
      lookupConceptRedirectRuntime: 'lookup-concept-redirect-runtime-hash',
      ambiguityRegistry: 'ambiguity-hash',
      nlMappings: 'nl-hash',
    },
    fieldAvailability: {
      appellation: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
      body: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
      sweetness: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
      acidity: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
      tannin: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
    },
    quality: {
      status: 'canonical',
      blockers: [],
      bypasses: [],
      carryForwardBenchmarkCount: 0,
      experimentalInputsPresent: false,
    },
  };
}

describe('migrateRuntimeSearchSnapshotState', () => {
  it('rewrites a malformed runtime state when the manifest already satisfies the current contract', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'manifest.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const activeNlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(manifestPath, `${JSON.stringify(makeCurrentManifest(dir), null, 2)}\n`, 'utf8');
    await fs.writeFile(activeNlMappingsPath, `${JSON.stringify({ mappings: [{ key: 'body', canonical: 'full' }] })}\n`, 'utf8');
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
        snapshotId: 'search-snapshot:v1:test',
        manifestPath,
      }, null, 2)}\n`,
      'utf8',
    );

    const result = await migrateRuntimeSearchSnapshotState({
      runtimeStatePath,
      activeNlMappingsPath,
    });

    expect(result.action).toBe('rewritten');
    const rewritten = JSON.parse(await fs.readFile(runtimeStatePath, 'utf8'));
    expect(rewritten.lookupExactSafeRuntimePath).toBe(path.join(dir, 'lookup-exact-safe-runtime.json'));
    expect(rewritten.counts.lookupExactSafeRuntimeEntries).toBe(1);
    expect(rewritten.hashes.lookupExactSafeRuntime).toBe('lookup-exact-safe-runtime-hash');
  });

  it('retires a malformed runtime state when the previous manifest cannot satisfy the current contract', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'manifest.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const legacyManifest = makeCurrentManifest(dir);
    const {
      lookupExactSafeRuntimeJson: _ignoredArtifact,
      ...legacyArtifacts
    } = legacyManifest.artifacts;
    const {
      lookupExactSafeRuntimeEntries: _ignoredCount,
      ...legacyCounts
    } = legacyManifest.counts;
    const {
      lookupExactSafeRuntime: _ignoredHash,
      ...legacyHashes
    } = legacyManifest.hashes;
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        ...legacyManifest,
        artifacts: legacyArtifacts,
        counts: legacyCounts,
        hashes: legacyHashes,
      }, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot_runtime_state.v6',
        snapshotId: 'search-snapshot:v1:legacy',
        manifestPath,
      }, null, 2)}\n`,
      'utf8',
    );

    const result = await migrateRuntimeSearchSnapshotState({ runtimeStatePath });

    expect(result.action).toBe('retired');
    await expect(fs.readFile(runtimeStatePath, 'utf8')).rejects.toThrow();
    await expect(fs.readFile(result.backupPath!, 'utf8')).resolves.toContain('search_snapshot_runtime_state.v6');
  });

  it('promotes an explicit current manifest even when the existing runtime pointer targets an older snapshot', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'manifest.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const activeNlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(manifestPath, `${JSON.stringify(makeCurrentManifest(dir), null, 2)}\n`, 'utf8');
    await fs.writeFile(activeNlMappingsPath, `${JSON.stringify({ mappings: [] })}\n`, 'utf8');
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
        snapshotId: 'search-snapshot:v1:older',
        manifestPath: path.join(dir, 'older-manifest.json'),
      }, null, 2)}\n`,
      'utf8',
    );

    const result = await migrateRuntimeSearchSnapshotState({
      runtimeStatePath,
      activeNlMappingsPath,
      manifestPath,
    });

    expect(result.action).toBe('rewritten');
    expect(result.reason).toBe('explicit_manifest_promote');
    expect(result.snapshotId).toBe('search-snapshot:v1:test');
    const rewritten = JSON.parse(await fs.readFile(runtimeStatePath, 'utf8'));
    expect(rewritten.snapshotId).toBe('search-snapshot:v1:test');
    expect(rewritten.manifestPath).toBe(manifestPath);
    await expect(fs.readFile(result.backupPath!, 'utf8')).resolves.toContain('search-snapshot:v1:older');
  });
});
