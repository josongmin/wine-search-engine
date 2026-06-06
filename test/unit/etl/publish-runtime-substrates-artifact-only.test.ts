import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  publishRuntimeSubstratesArtifactOnly,
  promoteRuntimeSubstrateArtifacts,
  resolveRuntimeSubstrateCutoverPaths,
} from '../../../scripts/etl/publish-runtime-substrates.js';
import {
  serializeNdjson,
  type SearchSnapshotManifest,
} from '../../../scripts/etl/search-snapshot-schema.js';
import {
  LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION,
  LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION,
  LOOKUP_CONCEPT_REDIRECT_RUNTIME_SCHEMA_VERSION,
  LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION,
  LOOKUP_EXACT_SAFE_RUNTIME_SCHEMA_VERSION,
  LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION,
  buildLookupAliasRuntimeArtifactHash,
  buildLookupAmbiguityRuntimeArtifactHash,
  buildLookupConceptRedirectRuntimeArtifactHash,
  buildLookupEntityProjectionArtifactHash,
  buildLookupExactSafeRuntimeArtifactHash,
  buildLookupResolverProjectionArtifactHash,
  type LookupAliasRuntimeArtifact,
  type LookupAmbiguityRuntimeArtifact,
  type LookupConceptRedirectRuntimeArtifact,
  type LookupEntityProjectionArtifact,
  type LookupExactSafeRuntimeArtifact,
  type LookupResolverProjectionArtifact,
} from '../../../src/domain/shared/types/search-snapshot-lookup-runtime.js';
import {
  SEARCH_SNAPSHOT_SCHEMA_VERSION,
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../../src/domain/shared/constants/search-snapshot.js';
import { hashStableJson } from '../../../src/domain/shared/utils/stable-json.js';
import {
  LOOKUP_REVIEWED_FAMILY_RECALL_RUNTIME_SCHEMA_VERSION,
  LOOKUP_SCOPE_GRAPH_RUNTIME_SCHEMA_VERSION,
  LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION,
  buildLookupReviewedFamilyRecallRuntimeArtifactHash,
  buildLookupScopeGraphRuntimeArtifactHash,
  buildLookupSemanticScopeRuntimeArtifactHash,
  type LookupReviewedFamilyRecallRuntimeArtifact,
  type LookupScopeGraphRuntimeArtifact,
  type LookupSemanticScopeRuntimeArtifact,
} from '../../../src/domain/shared/types/search-snapshot-lookup-semantic-runtime.js';

const FIELD_AVAILABILITY = {
  appellation: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
  body: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
  sweetness: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
  acidity: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
  tannin: { populatedDocCount: 1, totalDocCount: 1, populatedDocRatio: 1 },
} as const;

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'publish-runtime-substrates-artifact-only-'));
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function buildCurrentManifestFixture(dir: string): Promise<{
  readonly manifest: SearchSnapshotManifest;
  readonly manifestPath: string;
  readonly nlMappingsPayload: { readonly mappings: readonly { readonly canonical: string; readonly key: string }[] };
}> {
  const snapshotId = 'search-snapshot:v1:artifact-only';
  const generatedAt = '2026-06-05T12:00:00.000Z';

  const aliasRuntime: LookupAliasRuntimeArtifact = {
    schemaVersion: LOOKUP_ALIAS_RUNTIME_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    aliasRegistryHash: 'alias-registry-hash',
    aliases: [
      {
        aliasId: 'alias-opus-one-ko',
        entityId: 'wine-opus-one-2018',
        value: '오푸스원',
        normalizedValue: '오푸스원',
        sourceTrust: 1,
        confidencePrior: 1,
        aliasType: 'translation',
      },
    ],
    surfaceForms: ['오푸스원'],
    exactIndex: { 오푸스원: [0] },
    compactIndex: { 오푸스원: [0] },
    wholeTokenIndex: { 오푸스원: [0] },
    phoneticIndex: {},
    doubleMetaphoneIndex: {},
    doubleMetaphoneKeysByAliasId: { 'alias-opus-one-ko': [] },
    prefixCatalog: [{ candidateTerm: '오푸스원', aliasIndexes: [0] }],
    hangulCompletionRecords: [{ aliasIndex: 0, jamoKey: 'ㅇㅍㅅㅇ', syllableBoundaryOffsets: [0] }],
  };

  const exactSafeRuntime: LookupExactSafeRuntimeArtifact = {
    schemaVersion: LOOKUP_EXACT_SAFE_RUNTIME_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    exactEntries: {
      오푸스원: {
        entityId: 'wine-opus-one-2018',
        locale: 'ko',
        certificate: {
          kind: 'exact_safe',
          normalizedSurface: '오푸스원',
          sourceTier: 'curated',
          singleton: true,
          collisionFree: true,
        },
      },
    },
    compactEntries: {},
  };

  const resolverProjection: LookupResolverProjectionArtifact = {
    schemaVersion: LOOKUP_RESOLVER_PROJECTION_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    documents: [
      {
        entityId: 'wine-opus-one-2018',
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        aliasesIdentitySafe: ['오푸스원', 'Opus One 2018'],
        identitySafeKeys: ['오푸스원', 'opusone2018'],
        identityCertificates: [
          {
            kind: 'exact_safe',
            normalizedSurface: '오푸스원',
            sourceTier: 'curated',
            singleton: true,
            collisionFree: true,
          },
        ],
        producer: 'Opus One',
        attributeHints: { vintage: 2018 },
        sourceRecordRefs: [{ sourceSystem: 'fixture', sourceRecordId: 'opus-one-2018' }],
      },
    ],
  };

  const entityProjection: LookupEntityProjectionArtifact = {
    schemaVersion: LOOKUP_ENTITY_PROJECTION_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    documents: [
      {
        entityId: 'wine-opus-one-2018',
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        aliasesIdentitySafe: ['오푸스원', 'Opus One 2018'],
        aliasesNoisyRecall: ['opus one'],
        producer: 'Opus One',
        region: 'Napa Valley',
        grapes: ['Cabernet Sauvignon'],
        searchTextKo: '오푸스원 나파 밸리',
        searchTextEn: 'Opus One Napa Valley',
        semanticSummary: 'iconic napa cabernet blend',
        pairing: ['steak'],
        availability: true,
        popularityScore: 0.99,
      },
    ],
  };

  const ambiguityRuntime: LookupAmbiguityRuntimeArtifact = {
    schemaVersion: LOOKUP_AMBIGUITY_RUNTIME_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    entries: {},
  };

  const semanticScopeRuntime: LookupSemanticScopeRuntimeArtifact = {
    schemaVersion: LOOKUP_SEMANTIC_SCOPE_RUNTIME_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    entries: {
      'ko|family|opus-one|bare': {
        semanticScopeKey: 'ko|family|opus-one|bare',
        scopeAxis: 'family',
        familyKey: 'opus one',
        surfaceFormKind: 'bare',
        locale: 'ko',
        entityId: 'wine-opus-one-2018',
      },
    },
  };

  const reviewedFamilyRecallRuntime: LookupReviewedFamilyRecallRuntimeArtifact = {
    schemaVersion: LOOKUP_REVIEWED_FAMILY_RECALL_RUNTIME_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    entries: {},
  };

  const scopeGraphRuntime: LookupScopeGraphRuntimeArtifact = {
    schemaVersion: LOOKUP_SCOPE_GRAPH_RUNTIME_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    adjacency: {
      'wine-opus-one-2018': [],
    },
  };

  const conceptRedirectRuntime: LookupConceptRedirectRuntimeArtifact = {
    schemaVersion: LOOKUP_CONCEPT_REDIRECT_RUNTIME_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    entries: {},
  };

  const artifacts = {
    documentsNdjson: path.join(dir, 'documents.ndjson'),
    vespaFeedNdjson: path.join(dir, 'vespa-feed.ndjson'),
    entitiesNdjson: path.join(dir, 'entities.ndjson'),
    aliasesNdjson: path.join(dir, 'aliases.ndjson'),
    lookupAliasRuntimeJson: path.join(dir, 'lookup-alias-runtime.json'),
    lookupExactSafeRuntimeJson: path.join(dir, 'lookup-exact-safe-runtime.json'),
    lookupResolverProjectionJson: path.join(dir, 'lookup-resolver-projection.json'),
    lookupEntityProjectionJson: path.join(dir, 'lookup-entity-projection.json'),
    lookupSemanticScopeRuntimeJson: path.join(dir, 'lookup-semantic-scope-runtime.json'),
    lookupReviewedFamilyRecallRuntimeJson: path.join(dir, 'lookup-reviewed-family-recall-runtime.json'),
    lookupScopeGraphRuntimeJson: path.join(dir, 'lookup-scope-graph-runtime.json'),
    lookupAmbiguityRuntimeJson: path.join(dir, 'lookup-ambiguity-runtime.json'),
    lookupConceptRedirectRuntimeJson: path.join(dir, 'lookup-concept-redirect-runtime.json'),
    ambiguityRegistryNdjson: path.join(dir, 'ambiguity.ndjson'),
    nlMappingsJson: path.join(dir, 'nl-mappings.json'),
    metadataJson: path.join(dir, 'metadata.json'),
  } as const;

  await writeJson(artifacts.lookupAliasRuntimeJson, aliasRuntime);
  await writeJson(artifacts.lookupExactSafeRuntimeJson, exactSafeRuntime);
  await writeJson(artifacts.lookupResolverProjectionJson, resolverProjection);
  await writeJson(artifacts.lookupEntityProjectionJson, entityProjection);
  await writeJson(artifacts.lookupSemanticScopeRuntimeJson, semanticScopeRuntime);
  await writeJson(artifacts.lookupReviewedFamilyRecallRuntimeJson, reviewedFamilyRecallRuntime);
  await writeJson(artifacts.lookupScopeGraphRuntimeJson, scopeGraphRuntime);
  await writeJson(artifacts.lookupAmbiguityRuntimeJson, ambiguityRuntime);
  await writeJson(artifacts.lookupConceptRedirectRuntimeJson, conceptRedirectRuntime);

  await fs.writeFile(
    artifacts.entitiesNdjson,
    serializeNdjson([
      {
        entityId: 'wine-opus-one-2018',
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        identitySignature: 'a'.repeat(64),
        relations: {},
        attributes: {
          wineType: 'red',
          giftSuitabilityScore: 0.82,
          beginnerSuitabilityScore: 0.74,
        },
        metadata: {},
      },
    ]),
    'utf8',
  );
  await fs.writeFile(artifacts.aliasesNdjson, '', 'utf8');
  await fs.writeFile(artifacts.ambiguityRegistryNdjson, '', 'utf8');
  await fs.writeFile(artifacts.documentsNdjson, '', 'utf8');
  await fs.writeFile(artifacts.vespaFeedNdjson, '', 'utf8');
  await writeJson(artifacts.metadataJson, { snapshotId });

  const nlMappingsPayload = {
    mappings: [{ key: 'body', canonical: 'full-bodied' }],
  } as const;
  await writeJson(artifacts.nlMappingsJson, nlMappingsPayload);

  const manifest: SearchSnapshotManifest = {
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId,
    generatedAt,
    contentHash: 'content-hash',
    sourceInputPath: '/tmp/silver-trackc.ndjson',
    artifacts,
    counts: {
      documents: 1,
      vespaFeed: 1,
      entities: 1,
      aliases: 1,
      lookupAliasRuntimeAliases: aliasRuntime.aliases.length,
      lookupExactSafeRuntimeEntries:
        Object.keys(exactSafeRuntime.exactEntries).length
        + Object.keys(exactSafeRuntime.compactEntries).length,
      lookupResolverProjectionDocuments: resolverProjection.documents.length,
      lookupEntityProjectionDocuments: entityProjection.documents.length,
      lookupSemanticScopeRuntimeEntries: Object.keys(semanticScopeRuntime.entries).length,
      lookupReviewedFamilyRecallRuntimeEntries: Object.keys(reviewedFamilyRecallRuntime.entries).length,
      lookupScopeGraphRuntimeEdges: Object.values(scopeGraphRuntime.adjacency)
        .reduce((total, edges) => total + edges.length, 0),
      lookupAmbiguityRuntimeEntries: Object.keys(ambiguityRuntime.entries).length,
      lookupConceptRedirectRuntimeEntries: Object.keys(conceptRedirectRuntime.entries).length,
      ambiguityRegistry: 0,
      nlMappings: nlMappingsPayload.mappings.length,
    },
    hashes: {
      documents: 'documents-hash',
      vespaFeed: 'vespa-feed-hash',
      entities: 'entities-hash',
      aliases: 'aliases-hash',
      lookupAliasRuntime: buildLookupAliasRuntimeArtifactHash(aliasRuntime),
      lookupExactSafeRuntime: buildLookupExactSafeRuntimeArtifactHash(exactSafeRuntime),
      lookupResolverProjection: buildLookupResolverProjectionArtifactHash(resolverProjection),
      lookupEntityProjection: buildLookupEntityProjectionArtifactHash(entityProjection),
      lookupSemanticScopeRuntime: buildLookupSemanticScopeRuntimeArtifactHash(semanticScopeRuntime),
      lookupReviewedFamilyRecallRuntime: buildLookupReviewedFamilyRecallRuntimeArtifactHash(reviewedFamilyRecallRuntime),
      lookupScopeGraphRuntime: buildLookupScopeGraphRuntimeArtifactHash(scopeGraphRuntime),
      lookupAmbiguityRuntime: buildLookupAmbiguityRuntimeArtifactHash(ambiguityRuntime),
      lookupConceptRedirectRuntime: buildLookupConceptRedirectRuntimeArtifactHash(conceptRedirectRuntime),
      ambiguityRegistry: 'ambiguity-hash',
      nlMappings: 'nl-hash',
    },
    fieldAvailability: FIELD_AVAILABILITY,
    quality: {
      status: 'canonical',
      blockers: [],
      bypasses: [],
      carryForwardBenchmarkCount: 0,
      experimentalInputsPresent: false,
    },
  };

  const manifestPath = path.join(dir, 'manifest.json');
  await writeJson(manifestPath, manifest);
  return { manifest, manifestPath, nlMappingsPayload };
}

const ORIGINAL_LTR_SERVING_ENABLED = process.env['LTR_SERVING_ENABLED'];

afterEach(() => {
  if (ORIGINAL_LTR_SERVING_ENABLED === undefined) {
    delete process.env['LTR_SERVING_ENABLED'];
  } else {
    process.env['LTR_SERVING_ENABLED'] = ORIGINAL_LTR_SERVING_ENABLED;
  }
});

describe('publishRuntimeSubstratesArtifactOnly', () => {
  it('stages and promotes a current-contract runtime state without PG operator plane', async () => {
    const dir = await makeTempDir();
    const { manifest, manifestPath, nlMappingsPayload } = await buildCurrentManifestFixture(dir);
    const activeRuntimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const activeRuntimeNlMappingsPath = path.join(dir, 'nl-mappings-active.json');
    const cutoverPaths = resolveRuntimeSubstrateCutoverPaths({
      snapshotId: manifest.snapshotId,
      runtimeStatePath: activeRuntimeStatePath,
      runtimeNlMappingsPath: activeRuntimeNlMappingsPath,
    });

    const stagedState = await publishRuntimeSubstratesArtifactOnly({
      manifestPath,
      runtimeStatePath: cutoverPaths.stagedRuntimeStatePath,
      runtimeNlMappingsPath: cutoverPaths.stagedRuntimeNlMappingsPath,
    });

    expect(stagedState.schemaVersion).toBe(SEARCH_SNAPSHOT_STATE_VERSION);
    expect(stagedState.snapshotId).toBe(manifest.snapshotId);
    expect(stagedState.counts.activeLtrModels).toBe(0);
    expect(stagedState.hashes.activeLtrModels).toBe(hashStableJson([]));
    expect(stagedState.nlMappingsRuntimePath).toBe(cutoverPaths.stagedRuntimeNlMappingsPath);

    const promotedState = await promoteRuntimeSubstrateArtifacts(cutoverPaths);

    expect(promotedState.snapshotId).toBe(manifest.snapshotId);
    expect(promotedState.nlMappingsRuntimePath).toBe(activeRuntimeNlMappingsPath);
    expect(promotedState.lookupAliasRuntimePath).toBe(manifest.artifacts.lookupAliasRuntimeJson);
    expect(promotedState.lookupExactSafeRuntimePath).toBe(manifest.artifacts.lookupExactSafeRuntimeJson);
    expect(promotedState.lookupResolverProjectionPath).toBe(manifest.artifacts.lookupResolverProjectionJson);
    expect(promotedState.lookupEntityProjectionPath).toBe(manifest.artifacts.lookupEntityProjectionJson);
    expect(promotedState.lookupAmbiguityRuntimePath).toBe(manifest.artifacts.lookupAmbiguityRuntimeJson);
    expect(promotedState.lookupConceptRedirectRuntimePath).toBe(manifest.artifacts.lookupConceptRedirectRuntimeJson);

    const writtenRuntimeState = JSON.parse(await fs.readFile(activeRuntimeStatePath, 'utf8'));
    expect(writtenRuntimeState.snapshotId).toBe(manifest.snapshotId);
    expect(writtenRuntimeState.schemaVersion).toBe(SEARCH_SNAPSHOT_STATE_VERSION);
    expect(writtenRuntimeState.nlMappingsRuntimePath).toBe(activeRuntimeNlMappingsPath);
    expect(writtenRuntimeState.counts.lookupConceptRedirectRuntimeEntries).toBe(0);

    const writtenNlMappings = JSON.parse(await fs.readFile(activeRuntimeNlMappingsPath, 'utf8'));
    expect(writtenNlMappings).toEqual(nlMappingsPayload);
  });

  it('fails closed when LTR serving mode is enabled', async () => {
    process.env['LTR_SERVING_ENABLED'] = 'true';
    const dir = await makeTempDir();
    const { manifestPath } = await buildCurrentManifestFixture(dir);

    await expect(
      publishRuntimeSubstratesArtifactOnly({
        manifestPath,
        runtimeStatePath: path.join(dir, 'runtime-search-snapshot.staging.json'),
        runtimeNlMappingsPath: path.join(dir, 'nl-mappings.staging.json'),
      }),
    ).rejects.toThrow(/LTR_SERVING_ENABLED=false/);
  });
});
