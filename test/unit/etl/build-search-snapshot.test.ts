import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachBenchmarkAnchorSuitability,
  buildSearchSnapshot,
  filterIdentityConflictingBenchmarkAnchorRecords,
  loadActiveBenchmarkCarryForwardRecords,
  loadBenchmarkAnchorSuitabilityArtifact,
  loadRepoLocalCoreIconBenchmarkTargetIds,
  loadRepoLocalGoldBenchmarkAnchorRecords,
} from '../../../scripts/etl/build-search-snapshot.js';
import { parseNdjson } from '../../../scripts/etl/ndjson.js';
import {
  hashStableJson,
  type AliasSnapshotRecord,
  type EntitySnapshotRecord,
} from '../../../scripts/etl/search-snapshot-schema.js';
import {
  buildLookupIdentityCertificatesByEntity,
  buildLookupRuntimeOverlayAliases,
  loadLookupExactSafeRegistry,
} from '../../../scripts/etl/lookup-exact-safe-registry.js';
import { buildLookupAliasRuntimeArtifact } from '../../../scripts/etl/build-lookup-runtime-pack.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import {
  SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX,
  resolveWineSnapshotEntity,
} from '../../../scripts/etl/snapshot-entity-identity.js';
import { canonicalizeAliasSnapshotRecords } from '../../../src/domain/shared/utils/search-snapshot-canonicalization.js';
import { normalizeForMatch } from '../../../src/domain/alias/service/normalize.js';
import { readLookupRuntimeBundleCache } from '../../../src/config/lookup-runtime-bundle-cache.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'build-search-snapshot-'));
}

function makeRecord(): EnrichedSilverRecord {
  return {
    sourceId: 'wine-opus-one',
    externalId: 'opus-one-ext',
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    vintageYear: 2018,
    country: 'United States',
    region: 'Napa Valley',
    appellation: 'Oakville',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.9,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.8,
    pairingTags: ['steak'],
    flavorProfiles: ['black-fruit', 'oak'],
    searchTextEn: 'Opus One 2018 Napa Valley Cabernet blend.',
    ratingAvg: 4.8,
    ratingsCount: 1200,
    priceUsd: 420,
    priceBand: 'luxury',
    popularityScore: 0.95,
    scrapedAt: '2026-04-12T00:00:00.000Z',
    alcoholPct: 14.5,
    producerPrestige: 0.98,
    isTopRated: true,
    aliases: {
      proposed: [],
      identitySafeProjection: [],
      noisyRecallProjection: [],
    },
    giftSuitabilityClassification: {
      score: 0.82,
      fingerprint: {
        modelId: 'gpt-test',
        contentHash: 'gift-hash',
        version: 'gift-v1',
        generatedAt: '2026-04-12T00:00:00.000Z',
      },
      provenance: {
        source: 'llm_gift_suitability_scorer',
        promptVersion: 'gift-prompt-v1',
        snippet: 'friendly gift wine',
        rationale: 'stable gift recommendation',
      },
    },
    beginnerSuitabilityClassification: {
      score: 0.76,
      fingerprint: {
        modelId: 'gpt-test',
        contentHash: 'beginner-hash',
        version: 'beginner-v1',
        generatedAt: '2026-04-12T00:00:00.000Z',
      },
      provenance: {
        source: 'llm_beginner_suitability_scorer',
        promptVersion: 'beginner-prompt-v1',
        snippet: 'easy for non-experts',
        rationale: 'low tannin and broad appeal',
      },
    },
  };
}

const TEST_REVIEWED_REGISTRY_OVERRIDES = {
  exactSafeRows: [],
  familyCollisionRows: [],
  familyCoreWitnessRows: [],
  carryForwardTargetEntityIds: [],
  localizedScopeSurfaceRows: [],
  semanticScopeTargetRows: [],
} as const;

async function buildHermeticSearchSnapshot(
  args: Parameters<typeof buildSearchSnapshot>[0],
): Promise<Awaited<ReturnType<typeof buildSearchSnapshot>>> {
  return buildSearchSnapshot({
    ...args,
    reviewedRegistryOverrides: TEST_REVIEWED_REGISTRY_OVERRIDES,
  });
}

describe('buildSearchSnapshot', () => {
  it('exposes repo-local core-icon benchmark target ids for default snapshot backfill', async () => {
    await expect(loadRepoLocalCoreIconBenchmarkTargetIds()).resolves.toEqual(
      expect.arrayContaining([
        'w-dom-perignon-2013',
        'w-krug-grande-cuvee-170eme-nv',
        'w-louis-roederer-cristal-2014',
        'w-giacomo-conterno-monfortino-2015',
      ]),
    );
  });

  it('filters synthetic benchmark anchors that collide with an existing identity signature', () => {
    const record = makeRecord();
    const resolved = resolveWineSnapshotEntity(
      record,
      new Map(),
      new Map(),
    );
    const existingEntity: EntitySnapshotRecord = {
      entityId: 'opus-one-2018',
      entityType: 'wine',
      canonicalLabel: record.canonicalLabel,
      identitySignature: resolved.identitySignature,
      relations: {},
      attributes: {
        grapes: record.grapes,
        wineType: record.wineType,
        style: record.wineType,
        region: record.region,
        pairing: record.pairingTags,
      },
      metadata: {
        source: 'snapshot:silver_trackc_v1',
        trustTier: 'high',
        externalId: record.externalId,
        producer: record.producer,
        country: record.country,
        region: record.region,
        identityResolution: resolved.resolution,
        sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: record.sourceId }],
      },
    };
    const benchmarkAnchor = {
      ...record,
      sourceId: 'benchmark-anchor-w-opus-one-2018',
      externalId: 'w-opus-one-2018',
      benchmarkAnchorEntityId: 'w-opus-one-2018',
    };

    const filtered = filterIdentityConflictingBenchmarkAnchorRecords({
      existingEntities: [existingEntity],
      candidateRecords: [benchmarkAnchor as never],
      goldLookup: new Map(),
      sourceContinuityLookup: new Map(),
    });

    expect(filtered).toHaveLength(0);
  });

  it('emits entity artifact and manifest counts for runtime entity plane', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(inputPath, `${JSON.stringify(makeRecord())}\n`);
    await fs.writeFile(nlMappingsPath, JSON.stringify({
      mappings: [{ key: 'full-bodied', canonical: 'full_bodied' }],
    }));

    const fixtureRoot = path.join(dir, 'wine-engine-fixture');
    await fs.mkdir(path.join(fixtureRoot, 'goldens'), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, 'goldens', 'canonical-entities.json'),
      `${JSON.stringify({
        _type: 'goldens',
        entities: [
          {
            entity_id: 'opus-one-2018',
            canonical_label: 'Opus One 2018',
            vintage: 2018,
          },
        ],
      })}\n`,
    );

    const result = await buildHermeticSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
      fixtureRepoRoot: fixtureRoot,
    });

    expect(result.manifest.counts.documents).toBe(1);
    expect(result.manifest.counts.vespaFeed).toBe(0);
    expect(result.manifest.counts.entities).toBe(1);
    expect(result.manifest.fieldAvailability.appellation).toEqual({
      populatedDocCount: 1,
      totalDocCount: 1,
      populatedDocRatio: 1,
    });
    expect(result.manifest.fieldAvailability.body).toEqual({
      populatedDocCount: 1,
      totalDocCount: 1,
      populatedDocRatio: 1,
    });
    expect(result.manifest.fieldAvailability.sweetness).toEqual({
      populatedDocCount: 1,
      totalDocCount: 1,
      populatedDocRatio: 1,
    });
    expect(result.manifest.fieldAvailability.acidity).toEqual({
      populatedDocCount: 1,
      totalDocCount: 1,
      populatedDocRatio: 1,
    });
    expect(result.manifest.fieldAvailability.tannin).toEqual({
      populatedDocCount: 1,
      totalDocCount: 1,
      populatedDocRatio: 1,
    });
    expect(result.manifest.hashes.entities).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.artifacts.vespaFeedNdjson).toMatch(/vespa-feed\.ndjson$/);
    await expect(fs.access(result.manifest.artifacts.vespaFeedNdjson)).rejects.toThrow();

    const entitiesRaw = await fs.readFile(result.manifest.artifacts.entitiesNdjson, 'utf8');
    const entityRows = parseNdjson<EntitySnapshotRecord>(
      entitiesRaw,
      result.manifest.artifacts.entitiesNdjson,
    ).records;
    const aliasesRaw = await fs.readFile(result.manifest.artifacts.aliasesNdjson, 'utf8');
    const aliasRows = parseNdjson<AliasSnapshotRecord>(
      aliasesRaw,
      result.manifest.artifacts.aliasesNdjson,
    ).records;

    expect(entityRows).toHaveLength(1);
    expect(aliasRows.length).toBeGreaterThan(0);
    expect(result.manifest.hashes.aliases).toBe(
      hashStableJson(canonicalizeAliasSnapshotRecords(aliasRows)),
    );
    expect(entityRows[0]?.entityId.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(entityRows[0]).toMatchObject({
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
    });
    expect(entityRows[0]?.identitySignature).toMatch(/^[a-f0-9]{64}$/);
    expect(entityRows[0]?.metadata).toMatchObject({
      identityResolution: 'gold_overlay',
      benchmarkEntityId: 'opus-one-2018',
      region: 'Napa Valley',
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'wine-opus-one' }],
    });
    expect(entityRows[0]?.attributes).toMatchObject({
      grapePrimary: 'Cabernet Sauvignon',
      grapes: ['Cabernet Sauvignon', 'Merlot'],
      wineType: 'red',
      style: 'red',
      body: 0.9,
      sweetness: 0.1,
      acidity: 0.5,
      tannin: 0.8,
      vintage: 2018,
      region: 'Napa Valley',
      priceBand: 'luxury',
      giftSuitabilityScore: 0.82,
      beginnerSuitabilityScore: 0.76,
    });
  });

  it('fails closed when Track C suitability coverage is missing', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const record = makeRecord();
    const { giftSuitabilityClassification: _gift, ...withoutGift } = record;

    await fs.writeFile(inputPath, `${JSON.stringify(withoutGift)}\n`);
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));

    await expect(buildHermeticSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
    })).rejects.toThrow(/giftSuitabilityClassification coverage/);
  });

  it('fails closed when beginner suitability coverage is missing', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const record = makeRecord();
    const { beginnerSuitabilityClassification: _beginner, ...withoutBeginner } = record;

    await fs.writeFile(inputPath, `${JSON.stringify(withoutBeginner)}\n`);
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));

    await expect(buildHermeticSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
    })).rejects.toThrow(/beginnerSuitabilityClassification coverage/);
  });

  it('materializes registry-backed ambiguity and concept redirect overlays into lookup runtime artifacts', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(inputPath, `${JSON.stringify(makeRecord())}\n`);
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));

    const result = await buildHermeticSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
    });

    const ambiguityRuntimeRaw = await fs.readFile(
      result.manifest.artifacts.lookupAmbiguityRuntimeJson,
      'utf8',
    );
    const ambiguityRuntime = JSON.parse(ambiguityRuntimeRaw) as {
      entries: Record<string, { types: string[]; severity: string }>;
    };
    const conceptRedirectRuntimeRaw = await fs.readFile(
      result.manifest.artifacts.lookupConceptRedirectRuntimeJson,
      'utf8',
    );
    const conceptRedirectRuntime = JSON.parse(conceptRedirectRuntimeRaw) as {
      entries: Record<string, { conceptClass: string; redirectReason: string }>;
    };
    const key = normalizeForMatch('샤또');
    const recommendationKey = normalizeForMatch('샴페인 추천');

    expect(ambiguityRuntime.entries[key]).toMatchObject({
      types: ['broad_icon'],
      severity: 'high',
    });
    expect(ambiguityRuntime.entries[normalizeForMatch('오푸스투')]).toBeUndefined();
    expect(conceptRedirectRuntime.entries[recommendationKey]).toMatchObject({
      conceptClass: 'recommendation',
      redirectReason: 'concept_query',
    });
  }, 30_000);

  it('writes reviewed semantic-scope component surfaces into the runtime-bundle cache payload', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(inputPath, `${JSON.stringify(makeRecord())}\n`);
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));

    const result = await buildSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
      reviewedRegistryOverrides: {
        ...TEST_REVIEWED_REGISTRY_OVERRIDES,
        localizedScopeSurfaceRows: [
          {
            componentKind: 'family',
            componentKey: 'solaia',
            localSurface: '솔라이아',
            normalizedLocalSurface: normalizeForMatch('솔라이아'),
            locale: 'ko',
            decisionStatus: 'approved',
            reviewedBy: 'test',
            reviewedAt: '2026-06-08T00:00:00.000Z',
            decisionReason: 'cache parity test',
            evidenceClass: 'localized_scope_surface_review',
          },
        ],
      },
    });

    const semanticScopeRuntime = JSON.parse(
      await fs.readFile(result.manifest.artifacts.lookupSemanticScopeRuntimeJson, 'utf8'),
    ) as { componentSurfaces?: Record<string, readonly string[]> };
    const cachePayload = await readLookupRuntimeBundleCache({
      manifestPath: result.manifestPath,
      snapshotId: result.manifest.snapshotId,
      aliasContentHash: result.manifest.hashes.aliases,
      artifactPaths: {
        lookupAliasRuntimeJson: result.manifest.artifacts.lookupAliasRuntimeJson,
        lookupAliasBroadRecallRuntimeJson: result.manifest.artifacts.lookupAliasBroadRecallRuntimeJson,
        lookupExactSafeRuntimeJson: result.manifest.artifacts.lookupExactSafeRuntimeJson,
        lookupResolverProjectionJson: result.manifest.artifacts.lookupResolverProjectionJson,
        lookupSemanticScopeRuntimeJson: result.manifest.artifacts.lookupSemanticScopeRuntimeJson,
        lookupReviewedFamilyRecallRuntimeJson: result.manifest.artifacts.lookupReviewedFamilyRecallRuntimeJson,
        lookupScopeGraphRuntimeJson: result.manifest.artifacts.lookupScopeGraphRuntimeJson,
        lookupAmbiguityRuntimeJson: result.manifest.artifacts.lookupAmbiguityRuntimeJson,
        lookupConceptRedirectRuntimeJson: result.manifest.artifacts.lookupConceptRedirectRuntimeJson,
      },
    });

    expect(semanticScopeRuntime.componentSurfaces).toEqual({
      'family::solaia::ko': [normalizeForMatch('솔라이아')],
    });
    expect(cachePayload?.semanticScopeComponentSurfaces).toEqual(
      semanticScopeRuntime.componentSurfaces,
    );
  }, 30_000);

  it('treats repo-local benchmark ids as covered when the equivalent public fixture entity already exists', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const margauxRecord: EnrichedSilverRecord = {
      ...makeRecord(),
      sourceId: 'wine-margaux',
      externalId: 'margaux-ext',
      canonicalLabel: 'Château Margaux 2015',
      producer: 'Château Margaux',
      vintageYear: 2015,
      country: 'France',
      region: 'Bordeaux',
      appellation: 'Margaux',
      grapePrimary: 'Cabernet Sauvignon',
      grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc', 'Petit Verdot'],
      searchTextEn: 'Château Margaux 2015 Bordeaux first growth cabernet blend.',
      priceUsd: 850,
      popularityScore: 0.99,
      producerPrestige: 0.99,
    };

    await fs.writeFile(inputPath, `${JSON.stringify(margauxRecord)}\n`);
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));

    const result = await buildHermeticSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
    });

    const entitiesRaw = await fs.readFile(result.manifest.artifacts.entitiesNdjson, 'utf8');
    const entityRows = parseNdjson<EntitySnapshotRecord>(
      entitiesRaw,
      result.manifest.artifacts.entitiesNdjson,
    ).records;

    expect(
      entityRows.some((row) =>
        (row.metadata as { benchmarkEntityId?: unknown }).benchmarkEntityId === 'chateau-margaux-2015'
        && row.canonicalLabel === 'Château Margaux 2015'),
    ).toBe(true);
    expect(entityRows.some((row) => row.entityId === 'w-chateau-margaux-2015')).toBe(false);
  }, 20_000);

  it('does not synthesize repo-local w-* duplicates when the public benchmark seed already covers the same wine', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(inputPath, '');
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));

    const result = await buildHermeticSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
    });

    const entitiesRaw = await fs.readFile(result.manifest.artifacts.entitiesNdjson, 'utf8');
    const entityRows = parseNdjson<EntitySnapshotRecord>(
      entitiesRaw,
      result.manifest.artifacts.entitiesNdjson,
    ).records;

    expect(entityRows.some((row) => row.entityId === 'chateau-margaux-2015')).toBe(true);
    expect(entityRows.some((row) => row.entityId === 'w-chateau-margaux-2015')).toBe(false);
    expect(entityRows.some((row) => row.entityId === 'yquem-2015')).toBe(true);
    expect(entityRows.some((row) => row.entityId === 'w-chateau-dyquem-2015')).toBe(false);
    expect(entityRows.some((row) => row.entityId === 'w-dom-perignon-2013')).toBe(true);
  }, 30_000);

  it('compiles the curated exact-safe registry into lookup runtime aliases and resolver certificates', async () => {
    const registryRows = await loadLookupExactSafeRegistry();
    const snapshotEntityIds = new Set(['opus-one-2018' as const, 'sassicaia-2018' as const]);
    const overlayAliases = buildLookupRuntimeOverlayAliases(registryRows, snapshotEntityIds);
    const identityCertificates = buildLookupIdentityCertificatesByEntity(registryRows, snapshotEntityIds);
    const aliasRuntimeRaw = buildLookupAliasRuntimeArtifact({
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-04T00:00:00.000Z',
      aliasRegistryHash: 'hash',
      aliases: [],
      runtimeOverlayAliases: overlayAliases,
    });

    const exactSafeAlias = aliasRuntimeRaw.aliases.find((alias) => alias.value === '오푸스원');
    expect(exactSafeAlias).toBeDefined();
    expect(aliasRuntimeRaw.exactIndex[normalizeForMatch('오푸스원')]).toBeDefined();
    expect(aliasRuntimeRaw.compactIndex[normalizeForMatch('오푸스원').replace(/\s+/gu, '')]).toBeUndefined();
    expect(identityCertificates.get('opus-one-2018' as const)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedSurface: normalizeForMatch('오푸스원'),
          kind: 'exact_safe',
        }),
      ]),
    );

    const sassicaiaHotsetAlias = aliasRuntimeRaw.aliases.find((alias) => alias.value === '사시카이아');
    expect(sassicaiaHotsetAlias).toBeDefined();
    expect(aliasRuntimeRaw.exactIndex[normalizeForMatch('사시카이아')]).toBeDefined();
    expect(identityCertificates.get('sassicaia-2018' as const)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          normalizedSurface: normalizeForMatch('사시까야'),
          kind: 'exact_safe',
        }),
        expect.objectContaining({
          normalizedSurface: normalizeForMatch('사시까이아'),
          kind: 'exact_safe',
        }),
        expect.objectContaining({
          normalizedSurface: normalizeForMatch('사시카이아'),
          kind: 'exact_safe',
        }),
        expect.objectContaining({
          normalizedSurface: normalizeForMatch('사씨까이아'),
          kind: 'exact_safe',
        }),
        expect.objectContaining({
          normalizedSurface: normalizeForMatch('사씨카이아'),
          kind: 'exact_safe',
        }),
      ]),
    );
  }, 20_000);

  it('fails closed when a vintage-bearing exact-safe row points at a different snapshot vintage', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(inputPath, `${JSON.stringify(makeRecord())}\n`);
    await fs.writeFile(nlMappingsPath, JSON.stringify({
      mappings: [{ key: 'full-bodied', canonical: 'full_bodied' }],
    }));

    const fixtureRoot = path.join(dir, 'wine-engine-fixture');
    await fs.mkdir(path.join(fixtureRoot, 'goldens'), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, 'goldens', 'canonical-entities.json'),
      `${JSON.stringify({
        _type: 'goldens',
        entities: [
          {
            entity_id: 'opus-one-2018',
            canonical_label: 'Opus One 2018',
            vintage: 2018,
          },
        ],
      })}\n`,
    );

    const baseline = await buildHermeticSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
      fixtureRepoRoot: fixtureRoot,
    });
    const baselineEntities = parseNdjson<EntitySnapshotRecord>(
      await fs.readFile(baseline.manifest.artifacts.entitiesNdjson, 'utf8'),
      baseline.manifest.artifacts.entitiesNdjson,
    ).records;
    const baselineEntityId = baselineEntities[0]?.entityId;
    expect(baselineEntityId).toBeDefined();

    await expect(buildSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
      fixtureRepoRoot: fixtureRoot,
      reviewedRegistryOverrides: {
        ...TEST_REVIEWED_REGISTRY_OVERRIDES,
        exactSafeRows: [{
          surface: 'Opus 원 2019',
          entityId: baselineEntityId!,
          promotionClass: 'exact_safe',
          locale: 'ko',
          sourceEvidence: 'test mismatch row',
          reviewedAt: '2026-06-08T00:00:00.000Z',
        }],
      },
    })).rejects.toThrow(/lookup exact-safe registry vintage mismatch.*Opus 원 2019/u);
  });

  it('lets curated exact-safe overlays suppress conflicting base exact hits from other entities', () => {
    const aliasRuntimeRaw = buildLookupAliasRuntimeArtifact({
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-04T00:00:00.000Z',
      aliasRegistryHash: 'hash',
      aliases: [
        {
          aliasId: 'base-a',
          entityId: 'wine-a',
          value: '무통 로칠드',
          normalizedValue: normalizeForMatch('무통 로칠드'),
          sourceTrust: 1,
          confidencePrior: 0.75,
          aliasType: 'translation',
        },
        {
          aliasId: 'base-b',
          entityId: 'wine-b',
          value: '무통 로칠드',
          normalizedValue: normalizeForMatch('무통 로칠드'),
          sourceTrust: 1,
          confidencePrior: 0.75,
          aliasType: 'translation',
        },
      ],
      runtimeOverlayAliases: [
        {
          entityId: 'wine-a',
          value: '무통 로칠드',
          normalizedValue: normalizeForMatch('무통 로칠드'),
          promotionClass: 'exact_safe',
          aliasType: 'observed_query_alias',
          source: 'registry:lookup_exact_safe_v1',
          sourceTrust: 1,
          confidencePrior: 0.98,
        },
      ],
    });

    const exactHitRows = aliasRuntimeRaw.exactIndex[normalizeForMatch('무통 로칠드')]
      .map((index) => aliasRuntimeRaw.aliases[index]);
    expect(exactHitRows.map((row) => row.entityId)).toEqual(['wine-a', 'wine-a']);
    expect(exactHitRows.map((row) => row.aliasType)).toEqual(['translation', 'observed_query_alias']);
  });

  it('carries forward required benchmark anchors from the active snapshot when current input dropped them', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const fixtureRoot = path.join(dir, 'wine-engine-fixture');
    const previousSnapshotRoot = path.join(dir, 'previous-snapshot');
    const previousManifestPath = path.join(previousSnapshotRoot, 'manifest.json');
    const previousDocumentsPath = path.join(previousSnapshotRoot, 'documents.ndjson');
    const previousEntitiesPath = path.join(previousSnapshotRoot, 'entities.ndjson');

    await fs.mkdir(previousSnapshotRoot, { recursive: true });
    await fs.writeFile(inputPath, '');
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));

    await fs.mkdir(path.join(fixtureRoot, 'goldens'), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, 'goldens', 'canonical-entities.json'),
      `${JSON.stringify({
        _type: 'goldens',
        entities: [
          {
            entity_id: 'opus-one-2018',
            canonical_label: 'Opus One 2018',
            vintage: 2018,
          },
        ],
      })}\n`,
    );
    await fs.writeFile(
      path.join(fixtureRoot, 'goldens', 'target-entity-map.json'),
      `${JSON.stringify({
        map: {
          'benchmark-case-001': 'opus-one-2018',
        },
      })}\n`,
    );

    const previousRecord = makeRecord();
    await fs.writeFile(previousDocumentsPath, `${JSON.stringify(previousRecord)}\n`);
    await fs.writeFile(
      previousEntitiesPath,
      `${JSON.stringify({
        entityId: 'wine-ce-previous-opus',
        entityType: 'wine',
        canonicalLabel: previousRecord.canonicalLabel,
        identitySignature: 'identity-opus',
        relations: {},
        attributes: {
          grapes: previousRecord.grapes,
          wineType: previousRecord.wineType,
          style: previousRecord.wineType,
          region: previousRecord.region,
        },
        metadata: {
          benchmarkEntityId: 'opus-one-2018',
          sourceRecordRefs: [
            {
              sourceSystem: 'vivino-silver',
              sourceRecordId: previousRecord.sourceId,
            },
          ],
        },
      })}\n`,
    );
    await fs.writeFile(
      previousManifestPath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot.v1',
        snapshotId: 'search-snapshot:v1:previous',
        generatedAt: '2026-04-17T00:00:00.000Z',
        contentHash: 'previous-content-hash',
        sourceInputPath: previousDocumentsPath,
        artifacts: {
          documentsNdjson: previousDocumentsPath,
          vespaFeedNdjson: path.join(previousSnapshotRoot, 'vespa-feed.ndjson'),
          entitiesNdjson: previousEntitiesPath,
          aliasesNdjson: path.join(previousSnapshotRoot, 'aliases.ndjson'),
          ambiguityRegistryNdjson: path.join(previousSnapshotRoot, 'ambiguity-registry.ndjson'),
          nlMappingsJson: path.join(previousSnapshotRoot, 'nl-mappings.json'),
          metadataJson: path.join(previousSnapshotRoot, 'metadata.json'),
        },
        counts: {
          documents: 1,
          vespaFeed: 0,
          entities: 1,
          aliases: 0,
          ambiguityRegistry: 0,
          nlMappings: 0,
        },
        hashes: {
          documents: 'documents-hash',
          vespaFeed: 'vespa-hash',
          entities: 'entities-hash',
          aliases: 'aliases-hash',
          ambiguityRegistry: 'ambiguity-hash',
          nlMappings: 'nl-hash',
        },
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
        },
        quality: {
          status: 'degraded',
          blockers: [],
          bypasses: ['legacy_carry_forward_fixture'],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      })}\n`,
    );
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot_runtime_state.v4',
        snapshotId: 'search-snapshot:v1:previous',
        contentHash: 'previous-content-hash',
        publishedAt: '2026-04-17T00:00:00.000Z',
        manifestPath: previousManifestPath,
        nlMappingsRuntimePath: path.join(dir, 'nl-mappings.json'),
        lookupAliasRuntimePath: path.join(previousSnapshotRoot, 'lookup-alias-runtime.json'),
        lookupEntityProjectionPath: path.join(previousSnapshotRoot, 'lookup-entity-projection.json'),
        counts: {
          entities: 1,
          aliases: 0,
          lookupAliasRuntimeAliases: 0,
          lookupEntityProjectionDocuments: 1,
          ambiguityRegistry: 0,
          nlMappings: 0,
          activeLtrModels: 0,
        },
        hashes: {
          entities: 'entities-hash',
          aliases: 'aliases-hash',
          lookupAliasRuntime: 'lookup-alias-runtime-hash',
          lookupEntityProjection: 'lookup-entity-projection-hash',
          ambiguityRegistry: 'ambiguity-hash',
          nlMappings: 'nl-hash',
          activeLtrModels: 'ltr-hash',
        },
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
        },
        quality: {
          status: 'degraded',
          blockers: [],
          bypasses: ['legacy_carry_forward_fixture'],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      })}\n`,
    );

    const result = await buildHermeticSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
      fixtureRepoRoot: fixtureRoot,
      runtimeStatePath,
    });

    const documentsRaw = await fs.readFile(result.manifest.artifacts.documentsNdjson, 'utf8');
    const documentRows = parseNdjson<EnrichedSilverRecord>(
      documentsRaw,
      result.manifest.artifacts.documentsNdjson,
    ).records;
    expect(documentRows.map((row) => row.sourceId)).toContain(previousRecord.sourceId);

    const entitiesRaw = await fs.readFile(result.manifest.artifacts.entitiesNdjson, 'utf8');
    const entityRows = parseNdjson<EntitySnapshotRecord>(
      entitiesRaw,
      result.manifest.artifacts.entitiesNdjson,
    ).records;
    expect(entityRows).toHaveLength(1);
    expect(entityRows[0]?.entityId).toBe('wine-ce-previous-opus');
    expect(entityRows[0]?.metadata).toMatchObject({
      benchmarkEntityId: 'opus-one-2018',
    });
  });

  it('does not carry forward stale benchmark-anchor catalog records from the active snapshot', async () => {
    const dir = await makeTempDir();
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const previousSnapshotRoot = path.join(dir, 'previous-snapshot');
    const previousManifestPath = path.join(previousSnapshotRoot, 'manifest.json');
    const previousDocumentsPath = path.join(previousSnapshotRoot, 'documents.ndjson');
    const previousEntitiesPath = path.join(previousSnapshotRoot, 'entities.ndjson');

    await fs.mkdir(previousSnapshotRoot, { recursive: true });

    const previousRecord: EnrichedSilverRecord = {
      ...makeRecord(),
      sourceId: 'benchmark-anchor-w-sassicaia-2018',
      externalId: 'w-sassicaia-2018',
      canonicalLabel: 'Tenuta San Guido Sassicaia 2018',
      aliases: {
        proposed: [
          {
            value: '사시카야',
            type: 'translation',
            source: 'benchmark-anchor:repo_gold_core_icon_v1',
            confidencePrior: 0.95,
            needsReview: false,
          },
        ],
        identitySafeProjection: ['Tenuta San Guido Sassicaia 2018', '사시카야'],
        noisyRecallProjection: ['사시카야'],
      },
    };

    await fs.writeFile(previousDocumentsPath, `${JSON.stringify(previousRecord)}\n`);
    await fs.writeFile(
      previousEntitiesPath,
      `${JSON.stringify({
        entityId: 'wine-ce-previous-sassicaia',
        entityType: 'wine',
        canonicalLabel: previousRecord.canonicalLabel,
        identitySignature: 'identity-sassicaia',
        relations: {},
        attributes: {
          grapes: previousRecord.grapes,
          wineType: previousRecord.wineType,
          style: previousRecord.wineType,
          region: previousRecord.region,
        },
        metadata: {
          benchmarkEntityId: 'w-sassicaia-2018',
          sourceRecordRefs: [
            {
              sourceSystem: 'benchmark-anchor-catalog',
              sourceRecordId: previousRecord.sourceId,
            },
          ],
        },
      })}\n`,
    );
    await fs.writeFile(
      previousManifestPath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot.v1',
        snapshotId: 'search-snapshot:v1:previous',
        generatedAt: '2026-04-17T00:00:00.000Z',
        contentHash: 'previous-content-hash',
        sourceInputPath: previousDocumentsPath,
        artifacts: {
          documentsNdjson: previousDocumentsPath,
          vespaFeedNdjson: path.join(previousSnapshotRoot, 'vespa-feed.ndjson'),
          entitiesNdjson: previousEntitiesPath,
          aliasesNdjson: path.join(previousSnapshotRoot, 'aliases.ndjson'),
          ambiguityRegistryNdjson: path.join(previousSnapshotRoot, 'ambiguity-registry.ndjson'),
          nlMappingsJson: path.join(previousSnapshotRoot, 'nl-mappings.json'),
          metadataJson: path.join(previousSnapshotRoot, 'metadata.json'),
        },
        counts: {
          documents: 1,
          vespaFeed: 0,
          entities: 1,
          aliases: 0,
          ambiguityRegistry: 0,
          nlMappings: 0,
        },
        hashes: {
          documents: 'documents-hash',
          vespaFeed: 'vespa-hash',
          entities: 'entities-hash',
          aliases: 'aliases-hash',
          ambiguityRegistry: 'ambiguity-hash',
          nlMappings: 'nl-hash',
        },
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
        },
        quality: {
          status: 'degraded',
          blockers: [],
          bypasses: ['legacy_carry_forward_fixture'],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      })}\n`,
    );
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot_runtime_state.v7',
        snapshotId: 'search-snapshot:v1:previous',
        contentHash: 'previous-content-hash',
        publishedAt: '2026-04-17T00:00:00.000Z',
        manifestPath: previousManifestPath,
      })}\n`,
    );

    const carryForward = await loadActiveBenchmarkCarryForwardRecords({
      currentRecords: [],
      runtimeStatePath,
    });

    expect(carryForward).toEqual([]);
  });

  it('carries forward active reviewed-authority owner entities from the active snapshot when current input dropped them', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const fixtureRoot = path.join(dir, 'wine-engine-fixture');
    const previousSnapshotRoot = path.join(dir, 'previous-snapshot');
    const previousManifestPath = path.join(previousSnapshotRoot, 'manifest.json');
    const previousDocumentsPath = path.join(previousSnapshotRoot, 'documents.ndjson');
    const previousEntitiesPath = path.join(previousSnapshotRoot, 'entities.ndjson');

    await fs.mkdir(previousSnapshotRoot, { recursive: true });
    await fs.mkdir(path.join(fixtureRoot, 'goldens'), { recursive: true });
    await fs.writeFile(inputPath, '');
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));
    await fs.writeFile(
      path.join(fixtureRoot, 'goldens', 'canonical-entities.json'),
      `${JSON.stringify({ _type: 'goldens', entities: [] })}\n`,
    );

    const previousRecord = makeRecord();
    await fs.writeFile(previousDocumentsPath, `${JSON.stringify(previousRecord)}\n`);
    await fs.writeFile(
      previousEntitiesPath,
      `${JSON.stringify({
        entityId: 'wine-ce-reviewed-authority-owner',
        entityType: 'wine',
        canonicalLabel: previousRecord.canonicalLabel,
        identitySignature: 'identity-reviewed-authority-owner',
        relations: {},
        attributes: {
          grapes: previousRecord.grapes,
          wineType: previousRecord.wineType,
          style: previousRecord.wineType,
          region: previousRecord.region,
        },
        metadata: {
          sourceRecordRefs: [
            {
              sourceSystem: 'benchmark-anchor-catalog',
              sourceRecordId: previousRecord.sourceId,
            },
          ],
        },
      })}\n`,
    );
    await fs.writeFile(
      previousManifestPath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot.v1',
        snapshotId: 'search-snapshot:v1:previous',
        generatedAt: '2026-04-17T00:00:00.000Z',
        contentHash: 'previous-content-hash',
        sourceInputPath: previousDocumentsPath,
        artifacts: {
          documentsNdjson: previousDocumentsPath,
          vespaFeedNdjson: path.join(previousSnapshotRoot, 'vespa-feed.ndjson'),
          entitiesNdjson: previousEntitiesPath,
          aliasesNdjson: path.join(previousSnapshotRoot, 'aliases.ndjson'),
          ambiguityRegistryNdjson: path.join(previousSnapshotRoot, 'ambiguity-registry.ndjson'),
          nlMappingsJson: path.join(previousSnapshotRoot, 'nl-mappings.json'),
          metadataJson: path.join(previousSnapshotRoot, 'metadata.json'),
        },
        counts: {
          documents: 1,
          vespaFeed: 0,
          entities: 1,
          aliases: 0,
          ambiguityRegistry: 0,
          nlMappings: 0,
        },
        hashes: {
          documents: 'documents-hash',
          vespaFeed: 'vespa-hash',
          entities: 'entities-hash',
          aliases: 'aliases-hash',
          ambiguityRegistry: 'ambiguity-hash',
          nlMappings: 'nl-hash',
        },
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
        },
        quality: {
          status: 'degraded',
          blockers: [],
          bypasses: ['legacy_carry_forward_fixture'],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      })}\n`,
    );
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot_runtime_state.v4',
        snapshotId: 'search-snapshot:v1:previous',
        contentHash: 'previous-content-hash',
        publishedAt: '2026-04-17T00:00:00.000Z',
        manifestPath: previousManifestPath,
        nlMappingsRuntimePath: path.join(dir, 'nl-mappings.json'),
        lookupAliasRuntimePath: path.join(previousSnapshotRoot, 'lookup-alias-runtime.json'),
        lookupEntityProjectionPath: path.join(previousSnapshotRoot, 'lookup-entity-projection.json'),
        counts: {
          entities: 1,
          aliases: 0,
          lookupAliasRuntimeAliases: 0,
          lookupEntityProjectionDocuments: 1,
          ambiguityRegistry: 0,
          nlMappings: 0,
          activeLtrModels: 0,
        },
        hashes: {
          entities: 'entities-hash',
          aliases: 'aliases-hash',
          lookupAliasRuntime: 'lookup-alias-runtime-hash',
          lookupEntityProjection: 'lookup-entity-projection-hash',
          ambiguityRegistry: 'ambiguity-hash',
          nlMappings: 'nl-hash',
          activeLtrModels: 'ltr-hash',
        },
        fieldAvailability: {
          appellation: {
            populatedDocCount: 1,
            totalDocCount: 1,
            populatedDocRatio: 1,
          },
        },
        quality: {
          status: 'degraded',
          blockers: [],
          bypasses: ['legacy_carry_forward_fixture'],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      })}\n`,
    );

    const result = await buildSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
      fixtureRepoRoot: fixtureRoot,
      runtimeStatePath,
      reviewedRegistryOverrides: {
        ...TEST_REVIEWED_REGISTRY_OVERRIDES,
        carryForwardTargetEntityIds: ['wine-ce-reviewed-authority-owner'],
      },
    });

    const documentsRaw = await fs.readFile(result.manifest.artifacts.documentsNdjson, 'utf8');
    const documentRows = parseNdjson<EnrichedSilverRecord>(
      documentsRaw,
      result.manifest.artifacts.documentsNdjson,
    ).records;
    expect(documentRows.map((row) => row.sourceId)).toContain(previousRecord.sourceId);

    const entitiesRaw = await fs.readFile(result.manifest.artifacts.entitiesNdjson, 'utf8');
    const entityRows = parseNdjson<EntitySnapshotRecord>(
      entitiesRaw,
      result.manifest.artifacts.entitiesNdjson,
    ).records;
    expect(entityRows).toHaveLength(1);
    expect(entityRows[0]?.canonicalLabel).toBe(previousRecord.canonicalLabel);
    expect(entityRows[0]?.metadata).toMatchObject({
      sourceRecordRefs: [
        {
          sourceRecordId: previousRecord.sourceId,
        },
      ],
    });
  });

  it('backfills missing benchmark anchors from the repo-local gold catalog with core-icon query surfaces', async () => {
    const artifact = await loadBenchmarkAnchorSuitabilityArtifact();
    const records = await loadRepoLocalGoldBenchmarkAnchorRecords([
      'w-calon-segur-2009',
      'w-calon-segur-2012',
      'w-calon-segur-2020',
      'w-cheval-blanc-2010',
      'w-cheval-blanc-2017',
      'w-dom-perignon-2013',
      'w-krug-grande-cuvee-170eme-nv',
      'w-louis-roederer-cristal-2014',
      'w-pavie-2014',
      'w-pavie-2017',
      'w-giacomo-conterno-monfortino-2015',
      'w-petrus-2016',
      'w-sassicaia-2018',
    ]);

    const byId = new Map(records.map((record) => [record.benchmarkAnchorEntityId, record] as const));
    expect(byId.get('w-calon-segur-2009')?.giftSuitabilityClassification?.score).toBe(
      artifact.entities['w-calon-segur-2009']?.gift.score,
    );
    expect(byId.get('w-calon-segur-2009')?.beginnerSuitabilityClassification?.score).toBe(
      artifact.entities['w-calon-segur-2009']?.beginner.score,
    );
    expect(byId.get('w-calon-segur-2012')?.giftSuitabilityClassification?.score).toBe(
      artifact.entities['w-calon-segur-2012']?.gift.score,
    );
    expect(byId.get('w-calon-segur-2012')?.beginnerSuitabilityClassification?.score).toBe(
      artifact.entities['w-calon-segur-2012']?.beginner.score,
    );
    expect(byId.get('w-calon-segur-2020')?.giftSuitabilityClassification?.score).toBe(
      artifact.entities['w-calon-segur-2020']?.gift.score,
    );
    expect(byId.get('w-calon-segur-2020')?.beginnerSuitabilityClassification?.score).toBe(
      artifact.entities['w-calon-segur-2020']?.beginner.score,
    );
    expect(byId.get('w-cheval-blanc-2010')?.giftSuitabilityClassification?.score).toBe(
      artifact.entities['w-cheval-blanc-2010']?.gift.score,
    );
    expect(byId.get('w-cheval-blanc-2010')?.beginnerSuitabilityClassification?.score).toBe(
      artifact.entities['w-cheval-blanc-2010']?.beginner.score,
    );
    expect(byId.get('w-cheval-blanc-2017')?.giftSuitabilityClassification?.score).toBe(
      artifact.entities['w-cheval-blanc-2017']?.gift.score,
    );
    expect(byId.get('w-cheval-blanc-2017')?.beginnerSuitabilityClassification?.score).toBe(
      artifact.entities['w-cheval-blanc-2017']?.beginner.score,
    );
    expect(byId.get('w-dom-perignon-2013')?.aliases.identitySafeProjection).toContain('돔 페리뇽 모엣');
    expect(byId.get('w-krug-grande-cuvee-170eme-nv')?.aliases.identitySafeProjection).toContain('크루그 그랑 뀌베');
    expect(byId.get('w-louis-roederer-cristal-2014')?.aliases.identitySafeProjection).toContain('루이로드레 크리스탈');
    expect(byId.get('w-pavie-2014')?.giftSuitabilityClassification?.score).toBe(
      artifact.entities['w-pavie-2014']?.gift.score,
    );
    expect(byId.get('w-pavie-2014')?.beginnerSuitabilityClassification?.score).toBe(
      artifact.entities['w-pavie-2014']?.beginner.score,
    );
    expect(byId.get('w-pavie-2017')?.giftSuitabilityClassification?.score).toBe(
      artifact.entities['w-pavie-2017']?.gift.score,
    );
    expect(byId.get('w-pavie-2017')?.beginnerSuitabilityClassification?.score).toBe(
      artifact.entities['w-pavie-2017']?.beginner.score,
    );
    expect(byId.get('w-giacomo-conterno-monfortino-2015')?.aliases.identitySafeProjection).toContain('자코모콘테르노');
    expect(byId.get('w-petrus-2016')?.aliases.identitySafeProjection).not.toContain('페트루스');
    expect(byId.get('w-petrus-2016')?.aliases.noisyRecallProjection).toContain('페트루스');
    expect(byId.get('w-sassicaia-2018')?.aliases.identitySafeProjection).not.toContain('사시카야');
    expect(byId.get('w-sassicaia-2018')?.aliases.identitySafeProjection).not.toContain('사씨카이야');
    expect(byId.get('w-sassicaia-2018')?.aliases.noisyRecallProjection).toContain('사시카야');
    expect(byId.get('w-sassicaia-2018')?.aliases.noisyRecallProjection).toContain('사씨카이야');
  });

  it('leaves benchmark-anchor suitability unset when the artifact is missing an entity seed', () => {
    const record = makeRecord();
    const {
      giftSuitabilityClassification: _gift,
      beginnerSuitabilityClassification: _beginner,
      ...withoutSuitability
    } = record;
    const seeded = attachBenchmarkAnchorSuitability({
      ...withoutSuitability,
      sourceId: 'benchmark-anchor-w-missing-seed',
      externalId: 'w-missing-seed',
      benchmarkAnchorEntityId: 'w-missing-seed',
    }, {
      version: 'v1',
      generatedAt: '2026-04-17T00:00:00.000Z',
      models: {
        gift: 'gpt-5.4-mini',
        beginner: 'gpt-5.4-mini',
      },
      promptVersions: {
        gift: 'gift-suitability-scorer-v2',
        beginner: 'beginner-suitability-scorer-v2',
      },
      requiredEntityIds: ['w-missing-seed'],
      entities: {},
    });

    expect(seeded.giftSuitabilityClassification).toBeUndefined();
    expect(seeded.beginnerSuitabilityClassification).toBeUndefined();
  });
});
