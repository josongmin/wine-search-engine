import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSearchSnapshot } from '../../../scripts/etl/build-search-snapshot.js';
import { parseNdjson } from '../../../scripts/etl/ndjson.js';
import {
  hashStableJson,
  type AliasSnapshotRecord,
  type EntitySnapshotRecord,
} from '../../../scripts/etl/search-snapshot-schema.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import { SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX } from '../../../scripts/etl/snapshot-entity-identity.js';
import { canonicalizeAliasSnapshotRecords } from '../../../src/domain/shared/utils/search-snapshot-canonicalization.js';
import { normalizeForMatch } from '../../../src/domain/alias/service/normalize.js';

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

describe('buildSearchSnapshot', () => {
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

    const result = await buildSearchSnapshot({
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

    await expect(buildSearchSnapshot({
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

    await expect(buildSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
    })).rejects.toThrow(/beginnerSuitabilityClassification coverage/);
  });

  it('materializes deterministic fixture-backed ambiguity overlay into the lookup runtime artifact', async () => {
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
    });

    const ambiguityRuntimeRaw = await fs.readFile(
      result.manifest.artifacts.lookupAmbiguityRuntimeJson,
      'utf8',
    );
    const ambiguityRuntime = JSON.parse(ambiguityRuntimeRaw) as {
      entries: Record<string, { types: string[]; severity: string }>;
    };
    const key = normalizeForMatch('샤또');

    expect(ambiguityRuntime.entries[key]).toMatchObject({
      types: ['fixture_curated_ambiguity'],
      severity: 'high',
    });
  });

  it('carries forward required benchmark anchors from the active snapshot when current input dropped them', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const previousSnapshotRoot = path.join(dir, 'previous-snapshot');
    const previousManifestPath = path.join(previousSnapshotRoot, 'manifest.json');
    const previousDocumentsPath = path.join(previousSnapshotRoot, 'documents.ndjson');
    const previousEntitiesPath = path.join(previousSnapshotRoot, 'entities.ndjson');

    await fs.mkdir(previousSnapshotRoot, { recursive: true });
    await fs.writeFile(inputPath, '');
    await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [] }));

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

    const result = await buildSearchSnapshot({
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
});
