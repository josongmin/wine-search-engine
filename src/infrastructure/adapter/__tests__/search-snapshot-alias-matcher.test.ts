import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SearchSnapshotAliasMatcher } from '../search-snapshot-alias-matcher.js';

const TMP_DIRS: string[] = [];

afterEach(async () => {
  await Promise.all(TMP_DIRS.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('SearchSnapshotAliasMatcher', () => {
  it('loads exact alias substrate from PostgreSQL snapshot rows', async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
        queries.push(sql);
        if (sql.includes('FROM active_search_snapshot')) {
          return {
            rows: [{
              active_snapshot_id: 'snapshot-001',
              previous_snapshot_id: null,
              content_hash: 'hash-001',
              promoted_at: new Date('2026-04-16T00:00:00.000Z'),
            }],
          };
        }
        if (sql.includes('FROM aliases')) {
          return {
            rows: [
              {
                alias_id: 'alias-001',
                entity_id: 'entity-opus-one',
                surface_form: 'Opus One',
                normalized_value: 'opus one',
                source_trust: 1,
                confidence: 0.98,
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as never;

    const matcher = await SearchSnapshotAliasMatcher.loadFromPostgres(pool);
    expect(matcher).toBeDefined();

    const matches = await matcher?.findMatches('opus one');
    expect(matches?.[0]).toMatchObject({
      surfaceForm: 'Opus One',
      entityIds: ['entity-opus-one'],
    });
    expect(queries.some((query) => query.includes('FROM active_search_snapshot'))).toBe(true);
    expect(queries.some((query) => query.includes('FROM aliases'))).toBe(true);
  });

  it('resolves exact, compact, and transliterated alias matches from memory', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:opus-one',
        value: 'Opus One',
        normalizedValue: 'opus one',
        sourceTrust: 1,
        confidencePrior: 0.97,
      },
      {
        aliasId: 'a2',
        entityId: 'wine:chateau-margaux',
        value: 'Chateau Margaux',
        normalizedValue: 'chateau margaux',
        sourceTrust: 1,
        confidencePrior: 0.96,
      },
    ]);

    const exact = await matcher.findMatches('opus one');
    const compact = await matcher.findMatches('opusone');
    const transliterated = await matcher.findMatches('오푸스 원');

    expect(exact[0]?.lookupStrategy).toBe('compact_exact');
    expect(exact[0]?.surfaceForm).toBe('Opus One');
    expect(compact[0]?.lookupStrategy).toBe('compact_exact');
    expect(compact[0]?.surfaceForm).toBe('Opus One');
    expect(transliterated[0]?.lookupStrategy).toContain('transliterated_exact');
    expect(transliterated[0]?.surfaceForm).toBe('Opus One');
  });

  it('supports request-scoped batch lookups without downstream I/O', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:opus-one',
        value: 'Opus One',
        normalizedValue: 'opus one',
        sourceTrust: 1,
        confidencePrior: 0.97,
      },
      {
        aliasId: 'a2',
        entityId: 'wine:margaux',
        value: 'Chateau Margaux',
        normalizedValue: 'chateau margaux',
        sourceTrust: 1,
        confidencePrior: 0.96,
      },
    ]);

    const batch = await matcher.findMatchesBatch(['opusone', '오푸스 원', 'chateau margaux']);

    expect(batch.get('opusone')?.[0]?.surfaceForm).toBe('Opus One');
    expect(batch.get('오푸스 원')?.[0]?.surfaceForm).toBe('Opus One');
    expect(batch.get('chateau margaux')?.[0]?.surfaceForm).toBe('Chateau Margaux');
  });

  it('loads alias substrate from runtime search snapshot state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-alias-matcher-'));
    TMP_DIRS.push(dir);
    const aliasesPath = path.join(dir, 'aliases.ndjson');
    const manifestPath = path.join(dir, 'manifest.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');

    await fs.writeFile(
      aliasesPath,
      `${JSON.stringify({
        aliasId: 'a1',
        entityId: 'wine:opus-one',
        value: 'Opus One',
        normalizedValue: 'opus one',
        sourceTrust: 1,
        confidencePrior: 0.97,
      })}\n`,
      'utf8',
    );
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot.v1',
        snapshotId: 'search-snapshot:v1:test1234',
        generatedAt: '2026-04-16T00:00:00.000Z',
        contentHash: 'hash1234',
        sourceInputPath: '/tmp/input.ndjson',
        artifacts: {
          documentsNdjson: '/tmp/documents.ndjson',
          vespaFeedNdjson: '/tmp/vespa-feed.ndjson',
          entitiesNdjson: '/tmp/entities.ndjson',
          aliasesNdjson: aliasesPath,
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
          nlMappings: 0,
        },
        hashes: {
          documents: 'h1',
          vespaFeed: 'h2',
          entities: 'h3',
          aliases: 'h4',
          ambiguityRegistry: 'h5',
          nlMappings: 'h6',
        },
      })}\n`,
      'utf8',
    );
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot_runtime_state.v3',
        snapshotId: 'search-snapshot:v1:test1234',
        contentHash: 'hash1234',
        publishedAt: '2026-04-16T00:00:00.000Z',
        manifestPath,
        nlMappingsRuntimePath: '/tmp/nl-mappings.runtime.json',
        allowMissingLtr: true,
        counts: {
          entities: 1,
          aliases: 1,
          ambiguityRegistry: 0,
          nlMappings: 0,
          activeLtrModels: 0,
        },
        hashes: {
          entities: 'h3',
          aliases: 'h4',
          ambiguityRegistry: 'h5',
          nlMappings: 'h6',
          activeLtrModels: 'h7',
        },
      })}\n`,
      'utf8',
    );

    const matcher = await SearchSnapshotAliasMatcher.loadFromRuntimeState(runtimeStatePath);

    expect(matcher).toBeDefined();
    await expect(matcher!.findMatches('opus one')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'Opus One',
      }),
    ]);
  });

  it('loads alias substrate when alias rows contain legacy keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-alias-matcher-legacy-'));
    TMP_DIRS.push(dir);
    const aliasesPath = path.join(dir, 'aliases.ndjson');
    const manifestPath = path.join(dir, 'manifest.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');

    await fs.writeFile(
      aliasesPath,
      `${JSON.stringify({
        aliasId: 'a1',
        entityId: 'wine:opus-one',
        value: '오푸스 원',
        normalizedValue: '오푸스 원',
        sourceTrust: 1,
        confidencePrior: 0.97,
        type: 'translation',
        scope: 'global',
        source: 'legacy',
      })}\n`,
      'utf8',
    );
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot.v1',
        snapshotId: 'search-snapshot:v1:test5678',
        generatedAt: '2026-04-16T00:00:00.000Z',
        contentHash: 'hash5678',
        sourceInputPath: '/tmp/input.ndjson',
        artifacts: {
          documentsNdjson: '/tmp/documents.ndjson',
          vespaFeedNdjson: '/tmp/vespa-feed.ndjson',
          entitiesNdjson: '/tmp/entities.ndjson',
          aliasesNdjson: aliasesPath,
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
          nlMappings: 0,
        },
        hashes: {
          documents: 'h1',
          vespaFeed: 'h2',
          entities: 'h3',
          aliases: 'h4',
          ambiguityRegistry: 'h5',
          nlMappings: 'h6',
        },
      })}\n`,
      'utf8',
    );
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot_runtime_state.v3',
        snapshotId: 'search-snapshot:v1:test5678',
        contentHash: 'hash5678',
        publishedAt: '2026-04-16T00:00:00.000Z',
        manifestPath,
        nlMappingsRuntimePath: '/tmp/nl-mappings.runtime.json',
        allowMissingLtr: true,
        counts: {
          entities: 1,
          aliases: 1,
          ambiguityRegistry: 0,
          nlMappings: 0,
          activeLtrModels: 0,
        },
        hashes: {
          entities: 'h3',
          aliases: 'h4',
          ambiguityRegistry: 'h5',
          nlMappings: 'h6',
          activeLtrModels: 'h7',
        },
      })}\n`,
      'utf8',
    );

    const matcher = await SearchSnapshotAliasMatcher.loadFromRuntimeState(runtimeStatePath);

    expect(matcher).toBeDefined();
    await expect(matcher!.findMatches('오푸스 원')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: '오푸스 원',
      }),
    ]);
  });
});
