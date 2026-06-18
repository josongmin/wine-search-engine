import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../scripts/etl/index-to-vespa.js', async () => {
  const actual = await vi.importActual<typeof import('../../../scripts/etl/index-to-vespa.js')>(
    '../../../scripts/etl/index-to-vespa.js',
  );
  return {
    ...actual,
    materializePreparedVespaFeedArtifact: vi.fn(async (args: {
      readonly outputPath: string;
      readonly snapshotId: string;
    }) => {
      const serialized = actual.serializePreparedVespaFeedDocuments([
        {
          id: 'legacy-1',
          fields: {
            entity_id: 'legacy-1',
            canonical_label: 'Legacy Sparkling Wine',
            wine_type: 'sparkling',
            search_snapshot_id: args.snapshotId,
          },
        },
      ]);
      await fs.writeFile(args.outputPath, serialized, 'utf8');
      return {
        count: 1,
        hash: 'mock-vespa-feed-hash',
      };
    }),
  };
});
import {
  assertSnapshotArtifactCriticalWineTypeCoverage,
  assertPreparedRollbackFeedAvailable,
  collectCriticalWineTypeAliasCoverage,
  ensurePreparedRollbackFeedAvailable,
  collectCriticalWineTypeCoverageFromEntities,
  collectCriticalWineTypeCoverageFromPreparedFeed,
  diffSnapshotVespaDocIds,
  loadPublishedRuntimeState,
  resolvePublishFixtureRepoRoot,
  FIXTURE_REPO_REQUIRED_ERROR,
  uniqueSnapshotDocIds,
} from '../../../scripts/etl/publish-search-snapshot.js';
import {
  promoteRuntimeSubstrateArtifacts,
  restoreRuntimeSubstrateArtifacts,
} from '../../../scripts/etl/publish-runtime-substrates.js';
import {
  serializePreparedVespaFeedDocuments,
} from '../../../scripts/etl/index-to-vespa.js';
import { serializeNdjson, type SearchSnapshotManifest } from '../../../scripts/etl/search-snapshot-schema.js';
import {
  SEARCH_SNAPSHOT_SCHEMA_VERSION,
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../../src/domain/shared/constants/search-snapshot.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'publish-search-snapshot-'));
}

const FIELD_AVAILABILITY = {
  appellation: {
    populatedDocCount: 1,
    totalDocCount: 1,
    populatedDocRatio: 1,
  },
  body: {
    populatedDocCount: 1,
    totalDocCount: 1,
    populatedDocRatio: 1,
  },
  sweetness: {
    populatedDocCount: 1,
    totalDocCount: 1,
    populatedDocRatio: 1,
  },
  acidity: {
    populatedDocCount: 1,
    totalDocCount: 1,
    populatedDocRatio: 1,
  },
  tannin: {
    populatedDocCount: 1,
    totalDocCount: 1,
    populatedDocRatio: 1,
  },
} as const;

function makeManifest(feedPath: string): SearchSnapshotManifest {
  const dir = path.dirname(feedPath);
  return {
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'search-snapshot:v1:test',
    generatedAt: '2026-04-14T00:00:00.000Z',
    contentHash: 'content-hash',
    sourceInputPath: '/tmp/silver-trackc.ndjson',
    artifacts: {
      documentsNdjson: path.join(dir, 'documents.ndjson'),
      vespaFeedNdjson: feedPath,
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
    },
    counts: {
      documents: 1,
      vespaFeed: 1,
      entities: 1,
      aliases: 1,
      lookupAliasRuntimeAliases: 1,
      lookupExactSafeRuntimeEntries: 0,
      lookupResolverProjectionDocuments: 1,
      lookupEntityProjectionDocuments: 1,
      lookupSemanticScopeRuntimeEntries: 0,
      lookupReviewedFamilyRecallRuntimeEntries: 0,
      lookupScopeGraphRuntimeEdges: 0,
      lookupAmbiguityRuntimeEntries: 0,
      lookupConceptRedirectRuntimeEntries: 0,
      ambiguityRegistry: 0,
      nlMappings: 1,
    },
    hashes: {
      documents: 'documents-hash',
      vespaFeed: 'vespa-feed-hash',
      entities: 'entities-hash',
      aliases: 'aliases-hash',
      lookupAliasRuntime: 'lookup-alias-runtime-hash',
      lookupExactSafeRuntime: 'lookup-exact-safe-runtime-hash',
      lookupResolverProjection: 'lookup-resolver-projection-hash',
      lookupEntityProjection: 'lookup-entity-projection-hash',
      lookupSemanticScopeRuntime: 'lookup-semantic-scope-runtime-hash',
      lookupReviewedFamilyRecallRuntime: 'lookup-reviewed-family-recall-runtime-hash',
      lookupScopeGraphRuntime: 'lookup-scope-graph-runtime-hash',
      lookupAmbiguityRuntime: 'lookup-ambiguity-runtime-hash',
      lookupConceptRedirectRuntime: 'lookup-concept-redirect-runtime-hash',
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
}

function makeCoverageManifest(dir: string): SearchSnapshotManifest {
  return {
    schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
    snapshotId: 'search-snapshot:v1:coverage',
    generatedAt: '2026-04-16T00:00:00.000Z',
    contentHash: 'coverage-hash',
    sourceInputPath: '/tmp/silver-trackc.ndjson',
    artifacts: {
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
    },
    counts: {
      documents: 3,
      vespaFeed: 3,
      entities: 3,
      aliases: 1,
      lookupAliasRuntimeAliases: 1,
      lookupExactSafeRuntimeEntries: 0,
      lookupResolverProjectionDocuments: 3,
      lookupEntityProjectionDocuments: 3,
      lookupSemanticScopeRuntimeEntries: 0,
      lookupReviewedFamilyRecallRuntimeEntries: 0,
      lookupScopeGraphRuntimeEdges: 0,
      lookupAmbiguityRuntimeEntries: 0,
      lookupConceptRedirectRuntimeEntries: 0,
      ambiguityRegistry: 0,
      nlMappings: 1,
    },
    hashes: {
      documents: 'documents-hash',
      vespaFeed: 'vespa-feed-hash',
      entities: 'entities-hash',
      aliases: 'aliases-hash',
      lookupAliasRuntime: 'lookup-alias-runtime-hash',
      lookupExactSafeRuntime: 'lookup-exact-safe-runtime-hash',
      lookupResolverProjection: 'lookup-resolver-projection-hash',
      lookupEntityProjection: 'lookup-entity-projection-hash',
      lookupSemanticScopeRuntime: 'lookup-semantic-scope-runtime-hash',
      lookupReviewedFamilyRecallRuntime: 'lookup-reviewed-family-recall-runtime-hash',
      lookupScopeGraphRuntime: 'lookup-scope-graph-runtime-hash',
      lookupAmbiguityRuntime: 'lookup-ambiguity-runtime-hash',
      lookupConceptRedirectRuntime: 'lookup-concept-redirect-runtime-hash',
      ambiguityRegistry: 'ambiguity-hash',
      nlMappings: 'nl-hash',
    },
    fieldAvailability: {
      appellation: {
        populatedDocCount: 3,
        totalDocCount: 3,
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
  };
}

describe('assertPreparedRollbackFeedAvailable', () => {
  it('accepts exact prepared Vespa feed artifacts', async () => {
    const dir = await makeTempDir();
    const feedPath = path.join(dir, 'vespa-feed.ndjson');
    await fs.writeFile(feedPath, serializePreparedVespaFeedDocuments([
      {
        id: 'wine-1',
        fields: {
          entity_id: 'wine-1',
          entity_type: 'wine',
          canonical_label: 'Wine 1',
        },
      },
    ]));

    await expect(assertPreparedRollbackFeedAvailable(makeManifest(feedPath))).resolves.toBeUndefined();
  });

  it('rejects legacy non-prepared feed artifacts before publish starts', async () => {
    const dir = await makeTempDir();
    const feedPath = path.join(dir, 'vespa-feed.ndjson');
    await fs.writeFile(feedPath, `${JSON.stringify({ canonicalLabel: 'legacy silver row' })}\n`);

    await expect(assertPreparedRollbackFeedAvailable(makeManifest(feedPath))).rejects.toThrow(
      /exact rollback artifact/i,
    );
  });

  it('materializes an exact rollback artifact from a legacy manifest when missing', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'manifest.json');
    const documentsPath = path.join(dir, 'documents.ndjson');
    const feedPath = path.join(dir, 'vespa-feed.ndjson');
    const manifest = makeManifest(feedPath);
    await fs.writeFile(
      documentsPath,
      `${JSON.stringify({
        canonicalLabel: 'Legacy Sparkling Wine',
        producer: 'Legacy House',
        wineType: 'sparkling',
        sourceId: 'legacy-1',
        sourceSystem: 'vivino',
      })}\n`,
    );
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          documentsNdjson: documentsPath,
        },
      }, null, 2)}\n`,
    );

    const preparedManifest = await ensurePreparedRollbackFeedAvailable({
      manifest: {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          documentsNdjson: documentsPath,
        },
      },
      manifestPath,
    });

    await expect(assertPreparedRollbackFeedAvailable(preparedManifest)).resolves.toBeUndefined();
    const preparedRaw = await fs.readFile(feedPath, 'utf8');
    expect(preparedRaw).toContain('"fields"');
    expect(preparedRaw).toContain('"wine_type":"sparkling"');
  });
});

describe('publish flow does NOT shell out to `vespa` CLI', () => {
  // 2026-05-25 regression — schema deploy via `vespa` CLI was removed
  // because the CLI defaults to the Vespa Cloud target on developer
  // machines, causing publish to silently hit cloud even when the data
  // plane points at self-hosted EC2. Self-hosted is the only supported
  // topology now; schema deploy is a separate operator step against
  // the config server (`POST :19071/application/v2/tenant/default/
  // prepareandactivate`).
  it('publish source file has no `vespa deploy` CLI invocation', async () => {
    const scriptPath = fileURLToPath(
      new URL('../../../scripts/etl/publish-search-snapshot.ts', import.meta.url),
    );
    const source = await fs.readFile(scriptPath, 'utf8');
    // Allow the historical reference in the block comment that explains
    // why the function was removed; reject any actual execution path
    // (await + function call, spawn-style arg array).
    expect(source).not.toMatch(/await\s+deployVespaApplicationPackage\s*\(/);
    expect(source).not.toMatch(/['"]vespa['"]\s*,\s*\[\s*['"]deploy['"]/);
    expect(source).not.toMatch(/['"]vespa['"]\s*,\s*\[\s*['"]status['"]/);
  });

  it('reconciles target-snapshot stale Vespa docs before readiness', async () => {
    const scriptPath = fileURLToPath(
      new URL('../../../scripts/etl/publish-search-snapshot.ts', import.meta.url),
    );
    const source = await fs.readFile(scriptPath, 'utf8');
    const reconcileIndex = source.indexOf('await reconcileTargetSnapshotVespaDocuments(');
    const readinessIndex = source.indexOf("console.log('✅ Verifying search snapshot readiness');");

    expect(reconcileIndex).toBeGreaterThanOrEqual(0);
    expect(readinessIndex).toBeGreaterThan(reconcileIndex);
  });

  it('uses the lease table instead of a session-bound advisory lock', async () => {
    const scriptPath = fileURLToPath(
      new URL('../../../scripts/etl/publish-search-snapshot.ts', import.meta.url),
    );
    const source = await fs.readFile(scriptPath, 'utf8');

    expect(source).toContain('search_snapshot_publish_lock');
    expect(source).not.toContain('pg_advisory_lock');
  });
});

describe('diffSnapshotVespaDocIds', () => {
  it('separates missing vs stale doc ids exactly', () => {
    expect(diffSnapshotVespaDocIds({
      expectedDocIds: ['wine-1', 'wine-2', 'wine-3'],
      liveDocIds: ['wine-2', 'wine-3', 'wine-legacy'],
    })).toEqual({
      missingDocIds: ['wine-1'],
      staleDocIds: ['wine-legacy'],
    });
  });

  it('deduplicates expected doc ids before visibility diffing', () => {
    expect(uniqueSnapshotDocIds(['wine-1', 'wine-1', 'wine-2'])).toEqual(['wine-1', 'wine-2']);
    expect(diffSnapshotVespaDocIds({
      expectedDocIds: ['wine-1', 'wine-1', 'wine-2'],
      liveDocIds: ['wine-1', 'wine-2'],
    })).toEqual({
      missingDocIds: [],
      staleDocIds: [],
    });
  });
});

describe('snapshot artifact critical wine_type coverage', () => {
  it('counts critical wine types from entity and prepared-feed artifacts', async () => {
    const dir = await makeTempDir();
    const manifest = makeCoverageManifest(dir);
    await fs.writeFile(
      manifest.artifacts.entitiesNdjson,
      serializeNdjson([
        {
          entityId: 'wine-red',
          entityType: 'wine',
          canonicalLabel: 'Red Wine',
          identitySignature: 'sig-red',
          relations: {},
          attributes: { wineType: 'red' },
          metadata: {},
        },
        {
          entityId: 'wine-white',
          entityType: 'wine',
          canonicalLabel: 'White Wine',
          identitySignature: 'sig-white',
          relations: {},
          attributes: { wineType: 'white' },
          metadata: {},
        },
        {
          entityId: 'wine-sparkling',
          entityType: 'wine',
          canonicalLabel: 'Sparkling Wine',
          identitySignature: 'sig-sparkling',
          relations: {},
          attributes: { wineType: 'sparkling' },
          metadata: {},
        },
      ]),
    );
    await fs.writeFile(
      manifest.artifacts.aliasesNdjson,
      serializeNdjson([
        {
          aliasId: 'alias-red',
          entityId: 'wine-red',
          value: 'Red Wine Alias',
          normalizedValue: 'red wine alias',
          type: 'canonical_label',
          scope: 'global',
          source: 'test',
          sourceTrust: 1,
          confidencePrior: 1,
        },
        {
          aliasId: 'alias-white',
          entityId: 'wine-white',
          value: 'White Wine Alias',
          normalizedValue: 'white wine alias',
          type: 'canonical_label',
          scope: 'global',
          source: 'test',
          sourceTrust: 1,
          confidencePrior: 1,
        },
        {
          aliasId: 'alias-sparkling',
          entityId: 'wine-sparkling',
          value: 'Sparkling Wine Alias',
          normalizedValue: 'sparkling wine alias',
          type: 'canonical_label',
          scope: 'global',
          source: 'test',
          sourceTrust: 1,
          confidencePrior: 1,
        },
      ]),
    );
    await fs.writeFile(
      manifest.artifacts.vespaFeedNdjson,
      serializePreparedVespaFeedDocuments([
        { id: 'wine-red', fields: { entity_id: 'wine-red', wine_type: 'red' } },
        { id: 'wine-white', fields: { entity_id: 'wine-white', wine_type: 'white' } },
        { id: 'wine-sparkling', fields: { entity_id: 'wine-sparkling', wine_type: 'sparkling' } },
      ]),
    );

    await expect(assertSnapshotArtifactCriticalWineTypeCoverage(manifest)).resolves.toEqual({
      entityCoverage: { red: 1, white: 1, sparkling: 1 },
      vespaCoverage: { red: 1, white: 1, sparkling: 1 },
      aliasCoverage: {
        red: { entityCount: 1, entitiesWithAliases: 1, aliasCount: 1 },
        white: { entityCount: 1, entitiesWithAliases: 1, aliasCount: 1 },
        sparkling: { entityCount: 1, entitiesWithAliases: 1, aliasCount: 1 },
      },
    });
  });

  it('fails fast when critical wine types are missing from snapshot artifacts', async () => {
    const dir = await makeTempDir();
    const manifest = makeCoverageManifest(dir);
    await fs.writeFile(
      manifest.artifacts.entitiesNdjson,
      serializeNdjson([
        {
          entityId: 'wine-red',
          entityType: 'wine',
          canonicalLabel: 'Red Wine',
          identitySignature: 'sig-red',
          relations: {},
          attributes: { wineType: 'red' },
          metadata: {},
        },
      ]),
    );
    await fs.writeFile(manifest.artifacts.aliasesNdjson, serializeNdjson([]));
    await fs.writeFile(
      manifest.artifacts.vespaFeedNdjson,
      serializePreparedVespaFeedDocuments([
        { id: 'wine-red', fields: { entity_id: 'wine-red', wine_type: 'red' } },
      ]),
    );

    await expect(assertSnapshotArtifactCriticalWineTypeCoverage(manifest)).rejects.toThrow(
      /missing critical wine_type coverage in entities artifact: white, sparkling/i,
    );
  });

  it('counts only canonical critical wine types', () => {
    expect(
      collectCriticalWineTypeCoverageFromEntities([
        {
          entityId: 'wine-1',
          entityType: 'wine',
          canonicalLabel: 'Wine 1',
          identitySignature: 'sig-1',
          relations: {},
          attributes: { wineType: 'rosé' },
          metadata: {},
        },
      ]),
    ).toEqual({ red: 0, white: 0, sparkling: 0 });

    expect(
      collectCriticalWineTypeCoverageFromPreparedFeed([
        { id: 'wine-1', fields: { wine_type: 'dessert' } },
      ]),
    ).toEqual({ red: 0, white: 0, sparkling: 0 });
  });

  it('counts critical wine types from style-only entities', () => {
    expect(
      collectCriticalWineTypeCoverageFromEntities([
        {
          entityId: 'wine-1',
          entityType: 'wine',
          canonicalLabel: 'Wine 1',
          identitySignature: 'sig-1',
          relations: {},
          attributes: { style: 'white' },
          metadata: {},
        },
      ]),
    ).toEqual({ red: 0, white: 1, sparkling: 0 });
  });

  it('counts alias coverage per critical wine type without inventing missing aliases', () => {
    expect(
      collectCriticalWineTypeAliasCoverage(
        [
          {
            entityId: 'wine-red',
            entityType: 'wine',
            canonicalLabel: 'Red Wine',
            identitySignature: 'sig-red',
            relations: {},
            attributes: { wineType: 'red' },
            metadata: {},
          },
          {
            entityId: 'wine-white',
            entityType: 'wine',
            canonicalLabel: 'White Wine',
            identitySignature: 'sig-white',
            relations: {},
            attributes: { wineType: 'white' },
            metadata: {},
          },
        ],
        [
          {
            aliasId: 'alias-red-1',
            entityId: 'wine-red',
            value: 'Red Wine',
            normalizedValue: 'red wine',
            type: 'canonical_label',
            scope: 'global',
            source: 'test',
            sourceTrust: 1,
            confidencePrior: 1,
          },
          {
            aliasId: 'alias-red-2',
            entityId: 'wine-red',
            value: '레드 와인',
            normalizedValue: '레드 와인',
            type: 'ko_alias',
            scope: 'global',
            source: 'test',
            sourceTrust: 1,
            confidencePrior: 1,
          },
          {
            aliasId: 'alias-non-critical',
            entityId: 'wine-dessert',
            value: 'Dessert Wine',
            normalizedValue: 'dessert wine',
            type: 'canonical_label',
            scope: 'global',
            source: 'test',
            sourceTrust: 1,
            confidencePrior: 1,
          },
        ],
      ),
    ).toEqual({
      red: { entityCount: 1, entitiesWithAliases: 1, aliasCount: 2 },
      white: { entityCount: 1, entitiesWithAliases: 0, aliasCount: 0 },
      sparkling: { entityCount: 0, entitiesWithAliases: 0, aliasCount: 0 },
    });
  });
});

describe('loadPublishedRuntimeState', () => {
  it('returns undefined only when the runtime state file is missing', async () => {
    const dir = await makeTempDir();
    const runtimeStatePath = path.join(dir, 'missing-runtime-state.json');

    await expect(loadPublishedRuntimeState(runtimeStatePath)).resolves.toBeUndefined();
  });

  it('throws malformed runtime state instead of swallowing it as missing', async () => {
    const dir = await makeTempDir();
    const runtimeStatePath = path.join(dir, 'runtime-state.json');
    await fs.writeFile(runtimeStatePath, '{');

    await expect(loadPublishedRuntimeState(runtimeStatePath)).rejects.toThrow(
      /Unexpected end of JSON input|Expected property name or '}' in JSON|Malformed runtime search snapshot state/,
    );
  });

  it('rejects a legacy v6 runtime state instead of dual-reading it', async () => {
    const dir = await makeTempDir();
    const runtimeStatePath = path.join(dir, 'runtime-state.json');
    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        schemaVersion: 'search_snapshot_runtime_state.v6',
        snapshotId: 'search-snapshot:v1:legacy',
        manifestPath: '/tmp/legacy-manifest.json',
      })}\n`,
    );

    await expect(loadPublishedRuntimeState(runtimeStatePath)).rejects.toThrow(
      /Malformed runtime search snapshot state/,
    );
  });
});

describe('runtime substrate promotion state machine', () => {
  it('rewrites the staged runtime state to the active nl mappings path before promotion', async () => {
    const dir = await makeTempDir();
    const stagedStatePath = path.join(dir, 'runtime-search-snapshot.snapshot.staging.json');
    const activeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const stagedNlMappingsPath = path.join(dir, 'nl-mappings.snapshot.staging.json');
    const activeNlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(
      stagedStatePath,
      `${JSON.stringify({
        schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
        snapshotId: 'search-snapshot:v1:test',
        contentHash: 'content-hash',
        publishedAt: '2026-04-14T00:00:00.000Z',
        manifestPath: '/tmp/manifest.json',
        nlMappingsRuntimePath: stagedNlMappingsPath,
        lookupAliasRuntimePath: path.join(dir, 'lookup-alias-runtime.json'),
        lookupExactSafeRuntimePath: path.join(dir, 'lookup-exact-safe-runtime.json'),
        lookupResolverProjectionPath: path.join(dir, 'lookup-resolver-projection.json'),
        lookupEntityProjectionPath: path.join(dir, 'lookup-entity-projection.json'),
        lookupSemanticScopeRuntimePath: path.join(dir, 'lookup-semantic-scope-runtime.json'),
        lookupReviewedFamilyRecallRuntimePath: path.join(dir, 'lookup-reviewed-family-recall-runtime.json'),
        lookupScopeGraphRuntimePath: path.join(dir, 'lookup-scope-graph-runtime.json'),
        lookupAmbiguityRuntimePath: path.join(dir, 'lookup-ambiguity-runtime.json'),
        lookupConceptRedirectRuntimePath: path.join(dir, 'lookup-concept-redirect-runtime.json'),
        counts: {
          entities: 1,
          aliases: 1,
          lookupAliasRuntimeAliases: 1,
          lookupExactSafeRuntimeEntries: 0,
          lookupResolverProjectionDocuments: 1,
          lookupEntityProjectionDocuments: 1,
          lookupSemanticScopeRuntimeEntries: 0,
          lookupReviewedFamilyRecallRuntimeEntries: 0,
          lookupScopeGraphRuntimeEdges: 0,
          lookupAmbiguityRuntimeEntries: 0,
          lookupConceptRedirectRuntimeEntries: 0,
          ambiguityRegistry: 0,
          nlMappings: 1,
          activeLtrModels: 1,
        },
        hashes: {
          entities: 'entities-hash',
          aliases: 'aliases-hash',
          lookupAliasRuntime: 'lookup-alias-runtime-hash',
          lookupExactSafeRuntime: 'lookup-exact-safe-runtime-hash',
          lookupResolverProjection: 'lookup-resolver-projection-hash',
          lookupEntityProjection: 'lookup-entity-projection-hash',
          lookupSemanticScopeRuntime: 'lookup-semantic-scope-runtime-hash',
          lookupReviewedFamilyRecallRuntime: 'lookup-reviewed-family-recall-runtime-hash',
          lookupScopeGraphRuntime: 'lookup-scope-graph-runtime-hash',
          lookupAmbiguityRuntime: 'lookup-ambiguity-runtime-hash',
          lookupConceptRedirectRuntime: 'lookup-concept-redirect-runtime-hash',
          ambiguityRegistry: 'ambiguity-hash',
          nlMappings: 'nl-hash',
          activeLtrModels: 'ltr-hash',
        },
        fieldAvailability: FIELD_AVAILABILITY,
        quality: {
          status: 'canonical',
          blockers: [],
          bypasses: [],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      }, null, 2)}\n`,
    );
    await fs.writeFile(stagedNlMappingsPath, `${JSON.stringify({ mappings: [{ key: 'full-bodied' }] })}\n`);
    await fs.writeFile(activeNlMappingsPath, `${JSON.stringify({ mappings: [{ key: 'legacy' }] })}\n`);

    const promotedState = await promoteRuntimeSubstrateArtifacts({
      stagedRuntimeStatePath: stagedStatePath,
      activeRuntimeStatePath: activeStatePath,
      stagedRuntimeNlMappingsPath: stagedNlMappingsPath,
      activeRuntimeNlMappingsPath: activeNlMappingsPath,
    });

    expect(promotedState.nlMappingsRuntimePath).toBe(activeNlMappingsPath);
    await expect(fs.readFile(activeStatePath, 'utf8')).resolves.toContain(activeNlMappingsPath);
    await expect(fs.readFile(activeNlMappingsPath, 'utf8')).resolves.toContain('full-bodied');
    await expect(fs.stat(stagedStatePath)).rejects.toThrow();
    await expect(fs.stat(stagedNlMappingsPath)).rejects.toThrow();
  });

  it('restores active runtime substrate files exactly on rollback', async () => {
    const dir = await makeTempDir();
    const activeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const activeNlMappingsPath = path.join(dir, 'nl-mappings.json');
    const previousState = `${JSON.stringify({ snapshotId: 'previous-state' }, null, 2)}\n`;
    const previousNlMappings = `${JSON.stringify({ mappings: [{ key: 'previous' }] })}\n`;
    await fs.writeFile(activeStatePath, previousState);
    await fs.writeFile(activeNlMappingsPath, previousNlMappings);

    await restoreRuntimeSubstrateArtifacts({
      activeRuntimeStatePath: activeStatePath,
      previousRuntimeStateContents: previousState,
      activeRuntimeNlMappingsPath: activeNlMappingsPath,
      previousRuntimeNlMappingsContents: previousNlMappings,
    });

    await expect(fs.readFile(activeStatePath, 'utf8')).resolves.toBe(previousState);
    await expect(fs.readFile(activeNlMappingsPath, 'utf8')).resolves.toBe(previousNlMappings);
  });
});

describe('resolvePublishFixtureRepoRoot', () => {
  it('throws when no fixture repo can be resolved', () => {
    expect(() => resolvePublishFixtureRepoRoot(undefined, '')).toThrow(
      FIXTURE_REPO_REQUIRED_ERROR,
    );
  });

  it('prefers an explicit fixture repo path', () => {
    expect(resolvePublishFixtureRepoRoot('/tmp/fixture-repo', undefined)).toBe(
      '/tmp/fixture-repo',
    );
  });
});
