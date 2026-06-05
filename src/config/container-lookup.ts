import type { Pool } from 'pg';
import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { bindLiveSearchSnapshotRuntimeHandles } from './runtime-handles.js';
import { QuerySanitizer } from '../domain/security/service/query-sanitizer.js';
import { isLtrServingEnabled } from './ltr-serving-mode.js';
import { PgLtrModelRegistry } from '../infrastructure/adapter/pg-ltr-model-registry.js';
import { loadRuntimeLtrModels } from '../infrastructure/adapter/runtime-ltr-model-loader.js';
import { LTR_FEATURE_SCHEMA_HASH } from '../domain/ranking/service/lambdamart-ranker.js';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { SearchSnapshotAliasMatcher } from '../infrastructure/adapter/search-snapshot-alias-matcher.js';
import { SearchSnapshotEntityLookup } from '../infrastructure/adapter/search-snapshot-entity-lookup.js';
import { SearchSnapshotResolverProjectionLookup } from '../infrastructure/adapter/search-snapshot-resolver-projection-lookup.js';
import { SearchSnapshotAmbiguityDictionary } from '../infrastructure/adapter/search-snapshot-ambiguity-dictionary.js';
import { SearchSnapshotConceptRedirectRegistry } from '../infrastructure/adapter/search-snapshot-concept-redirect-registry.js';
import { SearchSnapshotExactSafeRegistry } from '../infrastructure/adapter/search-snapshot-exact-safe-registry.js';
import { PgBlockingAdapter } from '../infrastructure/adapter/pg-blocking-adapter.js';
import { PgCalibrationStore } from '../infrastructure/adapter/pg-calibration-store.js';
import { HttpLearnedMatcherAdapter } from '../infrastructure/adapter/http-learned-matcher.js';
import { StubBlockingPort, StubCalibrationStore } from './container-stubs.js';
import { buildEntityResolver } from './container-core-builders.js';
import { EntityLookupV2UseCase } from '../application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import { ConceptAdmissionGate } from '../domain/resolver/v2/concept-admission-gate.js';
import { MultiChannelRetrievalEngine } from '../application/search/entity-lookup-v2/multi-channel-retrieval-engine.js';
import { LtrRerankDecider } from '../domain/resolver/v2/ltr-rerank-decider.js';
import { RuntimeLookupPlanner } from '../application/search/entity-lookup-v2/runtime-lookup-planner.js';
import type { EntityLookupV2UseCasePort } from '../application/search/port/search-route-usecases.port.js';
import type { QueryClassWeights } from '../domain/ranking/index.js';

export interface LookupDirectContainer {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
}

function normalizeRuntimeHandles(
  runtime: Pool | RuntimeHandles | undefined,
): RuntimeHandles {
  if (runtime === undefined) {
    return {};
  }
  if ('totalCount' in runtime) {
    return { pool: runtime };
  }
  return runtime;
}

async function loadLookupLtrModels(
  config: Config,
  runtime: RuntimeHandles,
): Promise<ReadonlyMap<string, QueryClassWeights> | undefined> {
  if (!isLtrServingEnabled(config)) {
    return undefined;
  }

  if (runtime.pool !== undefined && runtime.searchSnapshotId !== undefined) {
    try {
      const registryModels = await new PgLtrModelRegistry(runtime.pool).getAllModels(runtime.searchSnapshotId);
      if (registryModels.size > 0) {
        for (const [queryClass, model] of registryModels.entries()) {
          if (model.featureSchemaHash !== LTR_FEATURE_SCHEMA_HASH) {
            throw new Error(
              `LTR model ${queryClass} feature schema mismatch at startup: model=${model.featureSchemaHash}, current=${LTR_FEATURE_SCHEMA_HASH}`,
            );
          }
        }
        bootstrapLogger.info(
          {
            component: 'LookupDirectContainer',
            source: 'registry',
            searchSnapshotId: runtime.searchSnapshotId,
            ltrModelCount: registryModels.size,
          },
          '[lookup-direct] loaded LTR models from registry',
        );
        return registryModels;
      }
    } catch (error) {
      bootstrapLogger.warn(
        {
          component: 'LookupDirectContainer',
          source: 'registry',
          searchSnapshotId: runtime.searchSnapshotId,
          err: error,
        },
        '[lookup-direct] registry LTR load failed; falling back to runtime artifact if configured',
      );
    }
  }

  if (config.runtimeLtrModelsPath !== undefined) {
    const runtimeModels = await loadRuntimeLtrModels(config.runtimeLtrModelsPath);
    if (runtimeModels !== undefined && runtimeModels.size > 0) {
      bootstrapLogger.info(
        {
          component: 'LookupDirectContainer',
          source: 'runtime-artifact',
          ltrModelCount: runtimeModels.size,
        },
        '[lookup-direct] loaded LTR models from runtime artifact',
      );
      return runtimeModels;
    }
  }

  return undefined;
}

export async function createLookupDirectContainer(
  config: Config,
  runtime: Pool | RuntimeHandles = {},
): Promise<LookupDirectContainer> {
  const runtimeHandles = await bindLiveSearchSnapshotRuntimeHandles(
    normalizeRuntimeHandles(runtime),
  );
  const manifestPath = runtimeHandles.searchSnapshotManifestPath;
  if (manifestPath === undefined) {
    throw new Error(
      'Lookup direct container requires searchSnapshotManifestPath for artifact-only lookup authority.',
    );
  }

  const querySanitizer = new QuerySanitizer();
  const ltrModelsPromise = loadLookupLtrModels(config, runtimeHandles);
  const [
    aliasMatcher,
    entityLookup,
    resolverProjectionLookup,
    ambiguityDictionary,
    conceptRedirectRegistry,
    exactSafeRegistry,
    ltrModels,
  ] = await Promise.all([
    SearchSnapshotAliasMatcher.loadFromManifest(manifestPath),
    SearchSnapshotEntityLookup.loadFromManifest(manifestPath),
    SearchSnapshotResolverProjectionLookup.loadFromManifest(manifestPath),
    SearchSnapshotAmbiguityDictionary.loadFromManifest(manifestPath),
    SearchSnapshotConceptRedirectRegistry.loadFromManifest(manifestPath),
    SearchSnapshotExactSafeRegistry.loadFromManifest(manifestPath),
    ltrModelsPromise,
  ]);

  if (aliasMatcher === undefined) {
    throw new Error(`Lookup direct container failed to load alias runtime from ${manifestPath}`);
  }

  const entityResolver = buildEntityResolver(
    {
      blockingPort: runtimeHandles.pool !== undefined
        ? new PgBlockingAdapter(runtimeHandles.pool, runtimeHandles.searchSnapshotId)
        : new StubBlockingPort(),
      calibrationStore: runtimeHandles.pool !== undefined
        ? new PgCalibrationStore(runtimeHandles.pool)
        : new StubCalibrationStore(),
      learnedMatcher:
        config.learnedMatcher.url !== undefined
          ? new HttpLearnedMatcherAdapter({
              url: config.learnedMatcher.url,
              httpTimeoutMs: config.learnedMatcher.httpTimeoutMs,
            })
          : undefined,
    },
    config,
  );

  const aliasRegistryVersion = aliasMatcher.getRegistryVersion?.();
  const entityLookupV2UseCase = new EntityLookupV2UseCase({
    admissionGate: new ConceptAdmissionGate(conceptRedirectRegistry),
    lookupPlanner: new RuntimeLookupPlanner({
      aliasMatcher,
      ambiguityDictionary,
      exactSafeRegistry,
    }),
    entityResolver,
    entityLookup,
    resolverProjectionLookup,
    candidateRetrieval: new MultiChannelRetrievalEngine({
      aliasMatcher,
      entityLookup,
      resolverProjectionLookup,
    }),
    ...(ltrModels !== undefined
      ? { reranker: new LtrRerankDecider({ ltrModels }) }
      : {}),
    ambiguityDictionary,
    ...(aliasRegistryVersion !== undefined ? { aliasRegistryVersion } : {}),
    querySanitizer,
  });

  return {
    entityLookupV2UseCase,
  };
}
