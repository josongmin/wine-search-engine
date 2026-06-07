import { describe, expect, it } from 'vitest';
import { SearchSnapshotAliasMatcher } from '../search-snapshot-alias-matcher.js';
import { LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION } from '../../../domain/shared/types/search-snapshot-lookup-runtime.js';
import { createStageTimer } from '../../../domain/shared/stage-timer.js';

function buildLookupAliasRuntimeArtifact(overrides?: {
  readonly value?: string;
  readonly normalizedValue?: string;
  readonly aliasType?: string;
}) {
  const artifact = {
    schemaVersion: LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION,
    snapshotId: 'search-snapshot:v1:test',
    generatedAt: '2026-04-16T00:00:00.000Z',
    aliasRegistryHash: 'alias-registry-hash',
    aliases: [{
      aliasId: 'a1',
      entityId: 'wine:opus-one',
      value: overrides?.value ?? 'Opus One',
      normalizedValue: overrides?.normalizedValue ?? 'opus one',
      sourceTrust: 1,
      confidencePrior: 0.97,
      ...(overrides?.aliasType !== undefined ? { aliasType: overrides.aliasType } : {}),
    }],
    surfaceForms: [overrides?.value ?? 'Opus One'],
    exactIndex: {
      [overrides?.normalizedValue ?? 'opus one']: [0],
    },
    compactIndex: {
      [overrides?.normalizedValue?.replace(/\s+/g, '') ?? 'opusone']: [0],
    },
    wholeTokenIndex: {
      opus: [0],
      one: [0],
    },
    phoneticIndex: {
      psn: [0],
    },
    doubleMetaphoneIndex: {
      APSN: [0],
    },
    doubleMetaphoneKeysByAliasId: {
      a1: ['APSN'],
    },
    prefixCatalog: [
      { candidateTerm: 'op', aliasIndexes: [0] },
      { candidateTerm: 'opu', aliasIndexes: [0] },
      { candidateTerm: 'opus', aliasIndexes: [0] },
    ],
    hangulCompletionRecords: [],
  } as const;
  return artifact;
}

function buildLookupAliasRuntimeCoreArtifact(overrides?: {
  readonly value?: string;
  readonly normalizedValue?: string;
  readonly aliasType?: string;
}) {
  const legacy = buildLookupAliasRuntimeArtifact(overrides);
  return {
    schemaVersion: 'lookup_alias_runtime_core.v1',
    snapshotId: legacy.snapshotId,
    generatedAt: legacy.generatedAt,
    aliasRegistryHash: legacy.aliasRegistryHash,
    aliases: legacy.aliases,
    exactIndex: legacy.exactIndex,
    compactIndex: legacy.compactIndex,
  } as const;
}

function buildLookupAliasBroadRecallRuntimeArtifact(overrides?: {
  readonly value?: string;
  readonly normalizedValue?: string;
  readonly aliasType?: string;
}) {
  const legacy = buildLookupAliasRuntimeArtifact(overrides);
  return {
    schemaVersion: 'lookup_alias_broad_recall_runtime.v1',
    snapshotId: legacy.snapshotId,
    generatedAt: legacy.generatedAt,
    aliasRegistryHash: legacy.aliasRegistryHash,
    wholeTokenIndex: legacy.wholeTokenIndex,
    phoneticIndex: legacy.phoneticIndex,
    doubleMetaphoneIndex: legacy.doubleMetaphoneIndex,
    prefixCatalog: legacy.prefixCatalog,
  } as const;
}

describe('SearchSnapshotAliasMatcher', () => {
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

  it('keeps runtime-artifact matchers fully hydrated and emits staged lookup timings', async () => {
    const matcher = SearchSnapshotAliasMatcher.fromRuntimeArtifact(
      buildLookupAliasRuntimeArtifact(),
    );
    const before = matcher.getBuildStateSnapshot();
    const stageTimer = createStageTimer();

    await expect(matcher.findMatches('opu', {
      scope: 'span',
      stageTimer,
    })).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'Opus One',
      }),
    ]);

    expect(matcher.isFullyHydratedRuntimeArtifact()).toBe(true);
    expect(matcher.getBuildStateSnapshot()).toEqual(before);
    expect(Object.keys(stageTimer.snapshot())).toEqual(expect.arrayContaining([
      expect.stringMatching(/^exact#/),
      expect.stringMatching(/^compact#/),
      expect.stringMatching(/^broad_recall#/),
    ]));
  });

  it('defers broad-recall sidecar hydration for core runtime artifacts until broad recall is needed', async () => {
    const matcher = SearchSnapshotAliasMatcher.fromRuntimeArtifact(
      buildLookupAliasRuntimeCoreArtifact(),
      undefined,
      {
        raw: JSON.stringify(buildLookupAliasBroadRecallRuntimeArtifact()),
        filePath: '/tmp/lookup-alias-broad-recall-runtime.json',
      },
    );

    expect(matcher.getBuildStateSnapshot()).toMatchObject({
      artifactHydrated: true,
      compactIndexBuilt: true,
      broadRecallIndexesBuilt: false,
    });

    await expect(matcher.findMatches('opus one')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'Opus One',
        lookupStrategy: 'exact',
      }),
    ]);
    expect(matcher.getBuildStateSnapshot().broadRecallIndexesBuilt).toBe(false);

    await expect(matcher.findMatches('opus')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'Opus One',
      }),
    ]);
    await expect(matcher.findMatches('오푸')).resolves.toMatchObject([
      expect.objectContaining({
        surfaceForm: 'Opus One',
      }),
    ]);
    expect(matcher.getSurfaceForms()).toEqual(['Opus One']);
  });
});
