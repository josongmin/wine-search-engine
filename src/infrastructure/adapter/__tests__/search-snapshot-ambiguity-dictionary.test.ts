import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SEARCH_SNAPSHOT_SCHEMA_VERSION } from '../../../domain/shared/constants/search-snapshot.js';
import { SearchSnapshotAmbiguityDictionary } from '../search-snapshot-ambiguity-dictionary.js';
import { LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION } from '../../../domain/shared/types/search-snapshot-lookup-runtime.js';

async function writeAmbiguityArtifacts(): Promise<{
  readonly dir: string;
  readonly manifestPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-ambiguity-runtime-'));
  const artifactPath = path.join(dir, 'lookup-ambiguity-runtime.json');
  const manifestPath = path.join(dir, 'manifest.json');

  await fs.writeFile(
    artifactPath,
    `${JSON.stringify({
      schemaVersion: LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION,
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-03T00:00:00.000Z',
      entries: {
        '샤또': {
          normalizedForm: '샤또',
          types: ['producer_family_collision'],
          severity: 'high',
          entityIds: ['chateau-haut-brion', 'chateau-lafite-rothschild'],
        },
        'opus one': {
          normalizedForm: 'opus one',
          types: ['multi_vintage'],
          severity: 'medium',
          entityIds: ['opus-one-2018', 'opus-one-2019'],
        },
        '그레인지': {
          normalizedForm: '그레인지',
          types: ['short_form', 'entity'],
          severity: 'high',
          entityIds: ['w-penfolds-grange-2017', 'w-penfolds-bin-389-2018'],
        },
      },
    }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
      artifacts: { lookupAmbiguityRuntimeJson: artifactPath },
    }, null, 2)}\n`,
    'utf8',
  );

  return { dir, manifestPath };
}

describe('SearchSnapshotAmbiguityDictionary', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('loads ambiguity entries from a manifest-backed runtime artifact', async () => {
    const { dir, manifestPath } = await writeAmbiguityArtifacts();
    cleanupDirs.push(dir);

    const dictionary = await SearchSnapshotAmbiguityDictionary.loadFromManifest(manifestPath);

    await expect(dictionary.isKnownAmbiguous('샤또')).resolves.toBe(true);
    await expect(dictionary.getAmbiguityInfo('opus one')).resolves.toEqual({
      types: ['multi_vintage'],
      severity: 'medium',
      entityIds: ['opus-one-2018', 'opus-one-2019'],
    });
    await expect(dictionary.isKnownAmbiguous('  OPUS   ONE  ')).resolves.toBe(true);
    await expect(dictionary.getAmbiguityInfo('그레인지')).resolves.toEqual({
      types: ['short_form', 'entity'],
      severity: 'high',
      entityIds: ['w-penfolds-grange-2017', 'w-penfolds-bin-389-2018'],
    });
    await expect(dictionary.getAmbiguityInfoBatch(['missing', '샤또'])).resolves.toEqual(
      new Map([
        ['샤또', {
          types: ['producer_family_collision'],
          severity: 'high',
          entityIds: ['chateau-haut-brion', 'chateau-lafite-rothschild'],
        }],
      ]),
    );
    await expect(dictionary.getAmbiguityInfoBatch(['  OPUS   ONE  ', '그레인지'])).resolves.toEqual(
      new Map([
        ['  OPUS   ONE  ', {
          types: ['multi_vintage'],
          severity: 'medium',
          entityIds: ['opus-one-2018', 'opus-one-2019'],
        }],
        ['그레인지', {
          types: ['short_form', 'entity'],
          severity: 'high',
          entityIds: ['w-penfolds-grange-2017', 'w-penfolds-bin-389-2018'],
        }],
      ]),
    );
  });

  it('fails closed when the manifest omits lookupAmbiguityRuntimeJson', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-ambiguity-runtime-'));
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
      SearchSnapshotAmbiguityDictionary.loadFromManifest(manifestPath),
    ).rejects.toThrow();
  });
});
