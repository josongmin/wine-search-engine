import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPreparedRollbackFeedAvailable,
  loadPublishedRuntimeState,
  resolvePublishFixtureRepoRoot,
  FIXTURE_REPO_REQUIRED_ERROR,
} from '../../../scripts/etl/publish-search-snapshot.js';
import {
  promoteRuntimeSubstrateArtifacts,
  restoreRuntimeSubstrateArtifacts,
} from '../../../scripts/etl/publish-runtime-substrates.js';
import {
  serializePreparedVespaFeedDocuments,
} from '../../../scripts/etl/index-to-vespa.js';
import type { SearchSnapshotManifest } from '../../../scripts/etl/search-snapshot-schema.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'publish-search-snapshot-'));
}

function makeManifest(feedPath: string): SearchSnapshotManifest {
  return {
    schemaVersion: 'search_snapshot_manifest.v1',
    snapshotId: 'search-snapshot:v1:test',
    generatedAt: '2026-04-14T00:00:00.000Z',
    contentHash: 'content-hash',
    sourceInputPath: '/tmp/silver-trackc.ndjson',
    artifacts: {
      documentsNdjson: '/tmp/documents.ndjson',
      vespaFeedNdjson: feedPath,
      entitiesNdjson: '/tmp/entities.ndjson',
      aliasesNdjson: '/tmp/aliases.ndjson',
      ambiguityRegistryNdjson: '/tmp/ambiguity.ndjson',
      nlMappingsJson: '/tmp/nl-mappings.json',
      metadataJson: '/tmp/metadata.json',
    },
    counts: {
      documents: 1,
      vespaFeed: 1,
      entities: 1,
      aliases: 1,
      ambiguityRegistry: 0,
      nlMappings: 1,
    },
    hashes: {
      documents: 'documents-hash',
      vespaFeed: 'vespa-feed-hash',
      entities: 'entities-hash',
      aliases: 'aliases-hash',
      ambiguityRegistry: 'ambiguity-hash',
      nlMappings: 'nl-hash',
    },
  };
}

describe('assertPreparedRollbackFeedAvailable', () => {
  it('accepts exact prepared Vespa feed artifacts', async () => {
    const dir = await makeTempDir();
    const feedPath = path.join(dir, 'vespa-feed.ndjson');
    await fs.writeFile(feedPath, serializePreparedVespaFeedDocuments([
      {
        id: 'wine-1',
        fields: {
          entity_id: 'wine-1',
          entity_type: 'wine',
          canonical_label: 'Wine 1',
        },
      },
    ]));

    await expect(assertPreparedRollbackFeedAvailable(makeManifest(feedPath))).resolves.toBeUndefined();
  });

  it('rejects legacy non-prepared feed artifacts before publish starts', async () => {
    const dir = await makeTempDir();
    const feedPath = path.join(dir, 'vespa-feed.ndjson');
    await fs.writeFile(feedPath, `${JSON.stringify({ canonicalLabel: 'legacy silver row' })}\n`);

    await expect(assertPreparedRollbackFeedAvailable(makeManifest(feedPath))).rejects.toThrow(
      /exact rollback artifact/i,
    );
  });
});

describe('loadPublishedRuntimeState', () => {
  it('returns undefined only when the runtime state file is missing', async () => {
    const dir = await makeTempDir();
    const runtimeStatePath = path.join(dir, 'missing-runtime-state.json');

    await expect(loadPublishedRuntimeState(runtimeStatePath)).resolves.toBeUndefined();
  });

  it('throws malformed runtime state instead of swallowing it as missing', async () => {
    const dir = await makeTempDir();
    const runtimeStatePath = path.join(dir, 'runtime-state.json');
    await fs.writeFile(runtimeStatePath, '{');

    await expect(loadPublishedRuntimeState(runtimeStatePath)).rejects.toThrow(
      /Unexpected end of JSON input|Expected property name or '}' in JSON|Malformed runtime search snapshot state/,
    );
  });
});

describe('runtime substrate promotion state machine', () => {
  it('rewrites the staged runtime state to the active nl mappings path before promotion', async () => {
    const dir = await makeTempDir();
    const stagedStatePath = path.join(dir, 'runtime-search-snapshot.snapshot.staging.json');
    const activeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const stagedNlMappingsPath = path.join(dir, 'nl-mappings.snapshot.staging.json');
    const activeNlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(
      stagedStatePath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot_runtime_state.v3',
        snapshotId: 'search-snapshot:v1:test',
        contentHash: 'content-hash',
        publishedAt: '2026-04-14T00:00:00.000Z',
        manifestPath: '/tmp/manifest.json',
        nlMappingsRuntimePath: stagedNlMappingsPath,
        allowMissingLtr: false,
        counts: {
          entities: 1,
          aliases: 1,
          ambiguityRegistry: 0,
          nlMappings: 1,
          activeLtrModels: 1,
        },
        hashes: {
          entities: 'entities-hash',
          aliases: 'aliases-hash',
          ambiguityRegistry: 'ambiguity-hash',
          nlMappings: 'nl-hash',
          activeLtrModels: 'ltr-hash',
        },
      }, null, 2)}\n`,
    );
    await fs.writeFile(stagedNlMappingsPath, `${JSON.stringify({ mappings: [{ key: 'full-bodied' }] })}\n`);
    await fs.writeFile(activeNlMappingsPath, `${JSON.stringify({ mappings: [{ key: 'legacy' }] })}\n`);

    const promotedState = await promoteRuntimeSubstrateArtifacts({
      stagedRuntimeStatePath: stagedStatePath,
      activeRuntimeStatePath: activeStatePath,
      stagedRuntimeNlMappingsPath: stagedNlMappingsPath,
      activeRuntimeNlMappingsPath: activeNlMappingsPath,
    });

    expect(promotedState.nlMappingsRuntimePath).toBe(activeNlMappingsPath);
    await expect(fs.readFile(activeStatePath, 'utf8')).resolves.toContain(activeNlMappingsPath);
    await expect(fs.readFile(activeNlMappingsPath, 'utf8')).resolves.toContain('full-bodied');
    await expect(fs.stat(stagedStatePath)).rejects.toThrow();
    await expect(fs.stat(stagedNlMappingsPath)).rejects.toThrow();
  });

  it('restores active runtime substrate files exactly on rollback', async () => {
    const dir = await makeTempDir();
    const activeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const activeNlMappingsPath = path.join(dir, 'nl-mappings.json');
    const previousState = `${JSON.stringify({ snapshotId: 'previous-state' }, null, 2)}\n`;
    const previousNlMappings = `${JSON.stringify({ mappings: [{ key: 'previous' }] })}\n`;
    await fs.writeFile(activeStatePath, previousState);
    await fs.writeFile(activeNlMappingsPath, previousNlMappings);

    await restoreRuntimeSubstrateArtifacts({
      activeRuntimeStatePath: activeStatePath,
      previousRuntimeStateContents: previousState,
      activeRuntimeNlMappingsPath: activeNlMappingsPath,
      previousRuntimeNlMappingsContents: previousNlMappings,
    });

    await expect(fs.readFile(activeStatePath, 'utf8')).resolves.toBe(previousState);
    await expect(fs.readFile(activeNlMappingsPath, 'utf8')).resolves.toBe(previousNlMappings);
  });
});

describe('resolvePublishFixtureRepoRoot', () => {
  it('throws when no fixture repo can be resolved', () => {
    expect(() => resolvePublishFixtureRepoRoot(undefined, '')).toThrow(
      FIXTURE_REPO_REQUIRED_ERROR,
    );
  });

  it('prefers an explicit fixture repo path', () => {
    expect(resolvePublishFixtureRepoRoot('/tmp/fixture-repo', undefined)).toBe(
      '/tmp/fixture-repo',
    );
  });
});
