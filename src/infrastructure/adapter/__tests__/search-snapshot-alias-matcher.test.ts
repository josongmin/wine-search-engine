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
    const internalState = matcher as unknown as {
      broadRecallIndexesBuilt: boolean;
    };

    const matches = await matcher?.findMatches('opus one');
    expect(matches?.[0]).toMatchObject({
      surfaceForm: 'Opus One',
      entityIds: ['entity-opus-one'],
    });
    expect(internalState.broadRecallIndexesBuilt).toBe(true);
    expect(queries.some((query) => query.includes('FROM active_search_snapshot'))).toBe(true);
    expect(queries.some((query) => query.includes('FROM aliases'))).toBe(true);
  });

  it('uses the explicit snapshot override without resolving the active pointer', async () => {
    const queries: string[] = [];
    const paramsSeen: readonly unknown[][] = [];
    const pool = {
      async query(sql: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
        queries.push(sql);
        paramsSeen.push(params ?? []);
        if (sql.includes('FROM active_search_snapshot')) {
          throw new Error('active pointer should not be read when snapshot override is provided');
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

    const matcher = await SearchSnapshotAliasMatcher.loadFromPostgres(pool, 'search-snapshot:v1:target');
    expect(matcher).toBeDefined();
    expect(queries.some((query) => query.includes('FROM active_search_snapshot'))).toBe(false);
    expect(paramsSeen).toContainEqual(['search-snapshot:v1:target']);
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
    const wholeTokenExpansion = await matcher.findMatches('opus');
    const latinPrefix = await matcher.findMatches('opu');
    const compact = await matcher.findMatches('opusone');
    const koreanTypoPrefix = await matcher.findMatches('오퍼스');
    const koreanCanonicalPrefix = await matcher.findMatches('오푸스');
    const transliterated = await matcher.findMatches('오푸스 원');

    expect(exact[0]?.lookupStrategy).toBe('exact');
    expect(exact[0]?.surfaceForm).toBe('Opus One');
    expect(wholeTokenExpansion).toEqual([]);
    expect(latinPrefix[0]?.lookupStrategy).toBe('prefix_exact');
    expect(latinPrefix[0]?.surfaceForm).toBe('Opus One');
    expect(compact[0]?.lookupStrategy).toBe('compact_exact');
    expect(compact[0]?.surfaceForm).toBe('Opus One');
    expect(koreanTypoPrefix[0]?.lookupStrategy).toContain('transliterated_exact');
    expect(koreanTypoPrefix[0]?.surfaceForm).toBe('Opus One');
    expect(koreanCanonicalPrefix[0]?.lookupStrategy).toContain('transliterated_exact');
    expect(koreanCanonicalPrefix[0]?.surfaceForm).toBe('Opus One');
    expect(transliterated[0]?.lookupStrategy).toContain('transliterated_exact');
    expect(transliterated[0]?.surfaceForm).toBe('Opus One');
  });

  it('defers secondary alias index construction until the first non-exact lookup', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:opus-one',
        value: 'Opus One',
        normalizedValue: 'opus one',
        sourceTrust: 1,
        confidencePrior: 0.97,
      },
    ]);
    const internalState = matcher as unknown as {
      compactIndexBuilt: boolean;
      broadRecallIndexesBuilt: boolean;
    };

    expect(internalState.compactIndexBuilt).toBe(true);
    expect(internalState.broadRecallIndexesBuilt).toBe(false);

    await expect(matcher.findMatches('opus one')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'Opus One',
        lookupStrategy: 'exact',
      }),
    ]);
    expect(internalState.compactIndexBuilt).toBe(true);
    expect(internalState.broadRecallIndexesBuilt).toBe(false);

    await expect(matcher.findMatches('opu')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'Opus One',
      }),
    ]);
    expect(internalState.compactIndexBuilt).toBe(true);
    expect(internalState.broadRecallIndexesBuilt).toBe(true);
  });

  it('keeps whole-surface lookup strict while allowing broad recall on span scope', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:opus-one',
        value: 'Opus One',
        normalizedValue: 'opus one',
        sourceTrust: 1,
        confidencePrior: 0.97,
      },
    ]);

    await expect(matcher.findMatches('opu', { scope: 'surface' })).resolves.toEqual([]);
    await expect(matcher.findMatches('opu', { scope: 'span' })).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'Opus One',
        lookupStrategy: 'prefix_exact',
      }),
    ]);
  });

  it('can force atomic span lookups to stay surface-only without opening broad recall indexes', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:opus-one',
        value: 'Opus One',
        normalizedValue: 'opus one',
        sourceTrust: 1,
        confidencePrior: 0.97,
      },
    ]);
    const internalState = matcher as unknown as {
      broadRecallIndexesBuilt: boolean;
    };

    await expect(matcher.findMatches('opu', {
      scope: 'span',
      recallMode: 'surface_only',
    })).resolves.toEqual([]);
    expect(internalState.broadRecallIndexesBuilt).toBe(false);
  });

  it('resolves Hangul syllable prefixes against curated Korean transliteration surfaces', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:opus-one',
        value: 'Opus One',
        normalizedValue: 'opus one',
        sourceTrust: 1,
        confidencePrior: 0.97,
      },
    ]);

    const completedPrefix = await matcher.findMatches('오푸');
    const choseongPrefix = await matcher.findMatches('오푸스ㅇ');
    const medialPrefix = await matcher.findMatches('오푸스우');
    const compoundMedialPrefix = await matcher.findMatches('오푸스워');
    const completeSyllable = await matcher.findMatches('오푸스');
    const singleJamo = await matcher.findMatches('ㅇ');

    expect(completedPrefix[0]).toMatchObject({
      surfaceForm: 'Opus One',
      entityIds: ['wine:opus-one'],
    });
    expect(completedPrefix[0]?.lookupStrategy).toContain('transliterated_exact');
    expect(choseongPrefix[0]).toMatchObject({
      surfaceForm: 'Opus One',
      entityIds: ['wine:opus-one'],
    });
    expect(choseongPrefix[0]?.lookupStrategy).toContain('hangul_ime_completion');
    expect(choseongPrefix[0]?.lookupStrategy).toContain('transliterated_fuzzy');
    expect(medialPrefix[0]).toMatchObject({
      surfaceForm: 'Opus One',
      entityIds: ['wine:opus-one'],
    });
    expect(medialPrefix[0]?.lookupStrategy).toContain('hangul_ime_completion');
    expect(medialPrefix[0]?.lookupStrategy).toContain('transliterated_fuzzy');
    expect(compoundMedialPrefix[0]).toMatchObject({
      surfaceForm: 'Opus One',
      entityIds: ['wine:opus-one'],
    });
    expect(compoundMedialPrefix[0]?.lookupStrategy).toContain('hangul_ime_completion');
    expect(compoundMedialPrefix[0]?.lookupStrategy).toContain('transliterated_fuzzy');
    expect(completeSyllable[0]?.surfaceForm).toBe('Opus One');
    expect(completeSyllable[0]?.entityIds).toEqual(['wine:opus-one']);
    expect(completeSyllable[0]?.lookupStrategy).toContain('transliterated_exact');
    expect(singleJamo).toEqual([]);
  });

  it('prefers explicit Korean exact aliases and does not widen them into Chateau-family collisions', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:dyquem',
        value: '샤또 디켐',
        normalizedValue: '샤또 디켐',
        sourceTrust: 1,
        confidencePrior: 0.95,
      },
      {
        aliasId: 'a2',
        entityId: 'wine:cheval-blanc',
        value: 'Chateau Cheval Blanc',
        normalizedValue: 'chateau cheval blanc',
        sourceTrust: 1,
        confidencePrior: 1,
      },
    ]);

    const matches = await matcher.findMatches('샤또 디켐');

    expect(matches[0]).toMatchObject({
      surfaceForm: '샤또 디켐',
      entityIds: ['wine:dyquem'],
    });
    expect(matches[0]?.lookupStrategy).toContain('exact');
    expect(matches).toHaveLength(1);
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

  it('keeps single-token lexical recall but does not widen multi-token identity lookups into family collisions', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:chateau-margaux-2015',
        value: 'Chateau Margaux',
        normalizedValue: 'chateau margaux',
        sourceTrust: 1,
        confidencePrior: 0.99,
      },
      {
        aliasId: 'a2',
        entityId: 'wine:chateau-angelus-2010',
        value: 'Chateau Angelus',
        normalizedValue: 'chateau angelus',
        sourceTrust: 1,
        confidencePrior: 0.95,
      },
      {
        aliasId: 'a3',
        entityId: 'wine:opus-one-2018',
        value: 'Opus One 2018',
        normalizedValue: 'opus one 2018',
        sourceTrust: 1,
        confidencePrior: 0.99,
      },
      {
        aliasId: 'a4',
        entityId: 'wine:opus-one-overture-2019',
        value: 'Opus One Overture 2019',
        normalizedValue: 'opus one overture 2019',
        sourceTrust: 1,
        confidencePrior: 0.95,
      },
    ]);

    const singleToken = await matcher.findMatches('margaux');
    const exactMultiToken = await matcher.findMatches('chateau margaux');
    const vintageExact = await matcher.findMatches('opus one 2018');

    expect(singleToken).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surfaceForm: 'Chateau Margaux',
        lookupStrategy: 'lexical_exact',
      }),
    ]));
    expect(exactMultiToken.map((match) => match.surfaceForm)).toEqual(['Chateau Margaux']);
    expect(vintageExact.map((match) => match.surfaceForm)).toEqual(['Opus One 2018']);
  });

  it('does not collapse lexical latin queries into uppercase acronym alias collisions', async () => {
    const matcher = new SearchSnapshotAliasMatcher([
      {
        aliasId: 'a1',
        entityId: 'wine:paolo-scavino',
        value: 'PS',
        normalizedValue: 'ps',
        sourceTrust: 1,
        confidencePrior: 0.6,
      },
    ]);

    await expect(matcher.findMatches('opus')).resolves.toEqual([]);
    await expect(matcher.findMatches('ps')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'PS',
        lookupStrategy: 'exact',
      }),
    ]);
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
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
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
        counts: {
          entities: 1,
          aliases: 1,
          ambiguityRegistry: 0,
          nlMappings: 0,
          activeLtrModels: 1,
        },
        hashes: {
          entities: 'h3',
          aliases: 'h4',
          ambiguityRegistry: 'h5',
          nlMappings: 'h6',
          activeLtrModels: 'h7',
        },
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
        },
        quality: {
          status: 'canonical',
          blockers: [],
          bypasses: [],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
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
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
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
        counts: {
          entities: 1,
          aliases: 1,
          ambiguityRegistry: 0,
          nlMappings: 0,
          activeLtrModels: 1,
        },
        hashes: {
          entities: 'h3',
          aliases: 'h4',
          ambiguityRegistry: 'h5',
          nlMappings: 'h6',
          activeLtrModels: 'h7',
        },
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
        },
        quality: {
          status: 'canonical',
          blockers: [],
          bypasses: [],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      })}\n`,
      'utf8',
    );

    const matcher = await SearchSnapshotAliasMatcher.loadFromRuntimeState(runtimeStatePath);

    expect(matcher).toBeDefined();
    await expect(matcher!.findMatches('오푸스 원')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: '오푸스 원',
        aliasType: 'translation',
      }),
    ]);
  });
});
