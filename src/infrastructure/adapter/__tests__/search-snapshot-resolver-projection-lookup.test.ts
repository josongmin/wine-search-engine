import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../../domain/shared/constants/search-snapshot.js';
import { createEntityId } from '../../../domain/shared/types/index.js';
import { SearchSnapshotResolverProjectionLookup } from '../search-snapshot-resolver-projection-lookup.js';
import { LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION } from '../../../domain/shared/types/search-snapshot-lookup-runtime.js';

async function writeResolverProjectionArtifacts(): Promise<{
  readonly dir: string;
  readonly manifestPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-resolver-projection-'));
  const projectionPath = path.join(dir, 'lookup-resolver-projection.json');
  const manifestPath = path.join(dir, 'manifest.json');

  await fs.writeFile(
    projectionPath,
    `${JSON.stringify({
      schemaVersion: LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION,
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-03T00:00:00.000Z',
      documents: [
        {
          entityId: 'opus-one-2018',
          entityType: 'wine',
          canonicalLabel: 'Opus One 2018',
          aliasesIdentitySafe: ['Opus One', '오푸스원'],
          identitySafeKeys: ['opus one', '오푸스원'],
          producer: 'Opus One',
          attributeHints: { wineType: 'red' },
        },
      ],
    }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
      artifacts: { lookupResolverProjectionJson: projectionPath },
    }, null, 2)}\n`,
    'utf8',
  );

  return { dir, manifestPath };
}

describe('SearchSnapshotResolverProjectionLookup', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('loads resolver projections from a manifest-backed runtime artifact', async () => {
    const { dir, manifestPath } = await writeResolverProjectionArtifacts();
    cleanupDirs.push(dir);

    const lookup = await SearchSnapshotResolverProjectionLookup.loadFromManifest(manifestPath);
    const docs = await lookup.getResolverProjections([
      createEntityId('missing'),
      createEntityId('opus-one-2018'),
    ]);

    expect([...docs.keys()]).toEqual([createEntityId('opus-one-2018')]);
    expect(docs.get(createEntityId('opus-one-2018'))).toEqual(
      expect.objectContaining({
        entityId: createEntityId('opus-one-2018'),
        canonicalLabel: 'Opus One 2018',
        identitySafeKeys: ['opus one', '오푸스원'],
        producer: 'Opus One',
      }),
    );
  });

  it('fails closed when the manifest omits lookupResolverProjectionJson', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-resolver-projection-'));
    cleanupDirs.push(dir);
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
        artifacts: {},
      }, null, 2)}\n`,
      'utf8',
    );

    await expect(
      SearchSnapshotResolverProjectionLookup.loadFromManifest(manifestPath),
    ).rejects.toThrow();
  });
});
