import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import { SearchSnapshotEntityLookup } from '../search-snapshot-entity-lookup.js';

function makeDocumentFields(entityId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity_id: entityId,
    entity_type: 'wine',
    canonical_label: `Label for ${entityId}`,
    aliases_identity_safe: [`Label for ${entityId}`],
    aliases_noisy_recall: [`Alias for ${entityId}`],
    producer: 'Producer',
    region: 'Region',
    grapes: ['Cabernet Sauvignon'],
    search_text_ko: '와인 검색어',
    search_text_en: 'Wine search text',
    semantic_summary: 'Wine semantic summary',
    style: 'red',
    price_band: 'premium',
    pairing: ['steak'],
    availability: true,
    popularity_score: 0.8,
    country: 'United States',
    drinking_window_start: 2024,
    drinking_window_end: 2038,
    ...overrides,
  };
}

async function writeSnapshotArtifacts(): Promise<{
  readonly dir: string;
  readonly manifestPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-entity-lookup-'));
  const vespaFeedPath = path.join(dir, 'vespa-feed.ndjson');
  const manifestPath = path.join(dir, 'manifest.json');
  const docA = {
    id: 'wine-a',
    fields: makeDocumentFields('wine-a', { wine_type: 'red' }),
  };
  const docB = {
    id: 'wine-b',
    fields: makeDocumentFields('wine-b', { wine_type: 'white' }),
  };
  await fs.writeFile(vespaFeedPath, `${JSON.stringify(docA)}\n${JSON.stringify(docB)}\n`, 'utf8');
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ artifacts: { vespaFeedNdjson: vespaFeedPath } }, null, 2)}\n`,
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
    const vespaFeedPath = path.join(dir, 'vespa-feed.ndjson');
    const manifestPath = path.join(dir, 'manifest.json');
    const validDoc = {
      id: 'wine-a',
      fields: makeDocumentFields('wine-a'),
    };
    const malformedDoc = {
      id: 'wine-b',
      fields: {
        entity_id: 'wine-b',
        entity_type: 'wine',
        producer: 'Producer',
      },
    };
    await fs.writeFile(
      vespaFeedPath,
      `${JSON.stringify(validDoc)}\n${JSON.stringify(malformedDoc)}\n`,
      'utf8',
    );
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ artifacts: { vespaFeedNdjson: vespaFeedPath } }, null, 2)}\n`,
      'utf8',
    );

    const lookup = await SearchSnapshotEntityLookup.loadFromManifest(manifestPath);
    const docs = await lookup.getDocuments([
      createEntityId('wine-a'),
      createEntityId('wine-b'),
    ]);

    expect(docs.has(createEntityId('wine-a'))).toBe(true);
    expect(docs.has(createEntityId('wine-b'))).toBe(false);
  });
});
