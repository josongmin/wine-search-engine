import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import { SearchSnapshotEntityLookup } from '../search-snapshot-entity-lookup.js';
import { LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION } from '../../../domain/shared/types/search-snapshot-lookup-runtime.js';

async function writeSnapshotArtifacts(): Promise<{
  readonly dir: string;
  readonly manifestPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-entity-lookup-'));
  const projectionPath = path.join(dir, 'lookup-entity-projection.json');
  const manifestPath = path.join(dir, 'manifest.json');
  const docA = {
    entityId: 'wine-a',
    entityType: 'wine',
    canonicalLabel: 'Label for wine-a',
    aliasesIdentitySafe: ['Label for wine-a'],
    aliasesNoisyRecall: ['Alias for wine-a'],
    producer: 'Producer',
    region: 'Region',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '와인 검색어',
    searchTextEn: 'Wine search text',
    semanticSummary: 'Wine semantic summary',
    pairing: ['steak'],
    availability: true,
    popularityScore: 0.8,
    wineType: 'red',
    drinkingWindowStart: 2024,
    drinkingWindowEnd: 2038,
  };
  const docB = {
    ...docA,
    entityId: 'wine-b',
    canonicalLabel: 'Label for wine-b',
    aliasesIdentitySafe: ['Label for wine-b'],
    aliasesNoisyRecall: ['Alias for wine-b'],
    wineType: 'white',
  };
  await fs.writeFile(
    projectionPath,
    `${JSON.stringify({
      schemaVersion: LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION,
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-03T00:00:00.000Z',
      documents: [docA, docB],
    }, null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 'search_snapshot.v3',
      artifacts: { lookupEntityProjectionJson: projectionPath },
    }, null, 2)}\n`,
    'utf8',
  );
  return { dir, manifestPath };
}

describe('SearchSnapshotEntityLookup', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('loads retrieval documents from manifest-backed Vespa feed', async () => {
    const { dir, manifestPath } = await writeSnapshotArtifacts();
    cleanupDirs.push(dir);

    const lookup = await SearchSnapshotEntityLookup.loadFromManifest(manifestPath);
    const docs = await lookup.getDocuments([
      createEntityId('wine-b'),
      createEntityId('wine-a'),
      createEntityId('wine-missing'),
    ]);

    expect([...docs.keys()]).toEqual([
      createEntityId('wine-b'),
      createEntityId('wine-a'),
    ]);
    expect(docs.get(createEntityId('wine-b'))?.canonicalLabel).toBe('Label for wine-b');
    expect(docs.get(createEntityId('wine-a'))?.wineType).toBe('red');
  });

  it('projects drinking-window lookups from the same in-memory snapshot docs', async () => {
    const { dir, manifestPath } = await writeSnapshotArtifacts();
    cleanupDirs.push(dir);

    const lookup = await SearchSnapshotEntityLookup.loadFromManifest(manifestPath);
    const docs = await lookup.getDrinkingWindowDocuments([
      createEntityId('wine-a'),
      createEntityId('wine-missing'),
    ]);

    expect(docs.get(createEntityId('wine-a'))).toEqual({
      entityId: createEntityId('wine-a'),
      canonicalLabel: 'Label for wine-a',
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2038,
    });
    expect(docs.has(createEntityId('wine-missing'))).toBe(false);
  });

  it('skips malformed feed rows and preserves valid documents', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-entity-lookup-'));
    cleanupDirs.push(dir);
    const projectionPath = path.join(dir, 'lookup-entity-projection.json');
    const manifestPath = path.join(dir, 'manifest.json');
    const validDoc = {
      entityId: 'wine-a',
      entityType: 'wine',
      canonicalLabel: 'Label for wine-a',
      aliasesIdentitySafe: ['Label for wine-a'],
      aliasesNoisyRecall: ['Alias for wine-a'],
      producer: 'Producer',
      region: 'Region',
      grapes: ['Cabernet Sauvignon'],
      searchTextKo: '와인 검색어',
      searchTextEn: 'Wine search text',
      semanticSummary: 'Wine semantic summary',
      pairing: ['steak'],
      availability: true,
      popularityScore: 0.8,
    };
    const malformedDoc = {
      entityId: 'wine-b',
      entityType: 'wine',
      producer: 'Producer',
    };
    await fs.writeFile(
      projectionPath,
      `${JSON.stringify({
        schemaVersion: LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION,
        snapshotId: 'search-snapshot:v1:test',
        generatedAt: '2026-06-03T00:00:00.000Z',
        documents: [validDoc, malformedDoc],
      }, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot.v3',
        artifacts: { lookupEntityProjectionJson: projectionPath },
      }, null, 2)}\n`,
      'utf8',
    );

    await expect(SearchSnapshotEntityLookup.loadFromManifest(manifestPath)).rejects.toThrow(
      /Malformed lookup entity projection artifact/,
    );
  });
});
