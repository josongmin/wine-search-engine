import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { QuerySanitizer } from '../domain/security/service/query-sanitizer.js';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { PgBlockingAdapter } from '../infrastructure/adapter/pg-blocking-adapter.js';
import { PgCalibrationStore } from '../infrastructure/adapter/pg-calibration-store.js';
import { MemoizedCalibrationStore } from '../infrastructure/adapter/memoized-calibration-store.js';
import { HttpLearnedMatcherAdapter } from '../infrastructure/adapter/http-learned-matcher.js';
import { StubBlockingPort, StubCalibrationStore } from './container-stubs.js';
import { buildEntityResolver } from './container-core-builders.js';
import { EntityLookupV2UseCase } from '../application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import { ConceptAdmissionGate } from '../domain/resolver/v2/concept-admission-gate.js';
import { MultiChannelRetrievalEngine } from '../application/search/entity-lookup-v2/multi-channel-retrieval-engine.js';
import { RuntimeLookupPlanner } from '../application/search/entity-lookup-v2/runtime-lookup-planner.js';
import type { EntityLookupV2UseCasePort } from '../application/search/port/search-route-usecases.port.js';
import { loadLookupRuntimeBundle, type LookupRuntimeBundleLoadProfile } from './lookup-runtime-bundle.js';
import { QUERY_CLASSES } from '../domain/shared/types/query-class.js';

export interface LookupAuthorityBootstrapProfile {
  readonly runtimeBundleMs: number;
  readonly ltrModelsMs: number;
  readonly ltrSupportStatus: 'unsupported';
  readonly ltrSupportReason: 'lookup_domain_model_absent';
  readonly calibrationPreloadKickoffMs: number;
  readonly usecaseWireMs: number;
  readonly runtimeBundleLoadProfile: LookupRuntimeBundleLoadProfile;
  readonly totalBootstrapMs: number;
}

export interface LookupAuthorityRuntimeMetadata {
  readonly searchSnapshotManifestPath: string;
  readonly runtimeBundleCacheKey: string;
  readonly searchSnapshotId?: string | undefined;
}

export interface LookupAuthorityServices {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  readonly bootstrapProfile: LookupAuthorityBootstrapProfile;
  readonly metadata: LookupAuthorityRuntimeMetadata;
}

export interface LookupV2LtrSupportState {
  readonly status: 'unsupported';
  readonly reason: 'lookup_domain_model_absent';
}

export function startCalibrationPreload(
  calibrationStore: MemoizedCalibrationStore | StubCalibrationStore,
  runtime: RuntimeHandles,
): void {
  if (!(calibrationStore instanceof MemoizedCalibrationStore)) {
    return;
  }
  void calibrationStore.preload(QUERY_CLASSES).catch((error) => {
    bootstrapLogger.warn(
      {
        component: 'LookupAuthorityServices',
        searchSnapshotId: runtime.searchSnapshotId,
        err: error,
      },
      '[lookup-authority] calibration preload failed; keeping lazy load path authoritative',
    );
  });
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}

export function resolveLookupV2LtrSupportState(
  config: Pick<Config, 'ltrServingEnabled' | 'runtimeLtrModelsPath'>,
): LookupV2LtrSupportState {
  bootstrapLogger.info(
    {
      component: 'LookupAuthorityServices',
      ltrServingEnabled: config.ltrServingEnabled,
      runtimeLtrModelsPathConfigured: config.runtimeLtrModelsPath !== undefined,
      reason: 'lookup_domain_model_absent',
    },
    '[lookup-authority] lookup-v2 LTR unsupported; skipping model discovery and reranker wiring',
  );
  return {
    status: 'unsupported',
    reason: 'lookup_domain_model_absent',
  };
}

export async function createLookupAuthorityServices(
  config: Config,
  runtime: RuntimeHandles,
): Promise<LookupAuthorityServices> {
  const bootstrapStartedAt = performance.now();
  const manifestPath = runtime.searchSnapshotManifestPath;
  if (manifestPath === undefined) {
    throw new Error(
      'Lookup authority requires searchSnapshotManifestPath for artifact-only lookup authority.',
    );
  }
  const runtimeBundleCacheKey = runtime.searchSnapshotId ?? manifestPath;

  const querySanitizer = new QuerySanitizer();
  const calibrationStore = runtime.pool !== undefined
    ? new MemoizedCalibrationStore(new PgCalibrationStore(runtime.pool))
    : new StubCalibrationStore();
  const ltrSupportStartedAt = performance.now();
  const ltrSupportState = resolveLookupV2LtrSupportState(config);
  const ltrModelsMs = roundMs(performance.now() - ltrSupportStartedAt);
  const runtimeBundlePromise = (async () => {
    const startedAt = performance.now();
    const runtimeBundle = await loadLookupRuntimeBundle(runtimeBundleCacheKey, manifestPath);
    return {
      runtimeBundle,
      elapsedMs: roundMs(performance.now() - startedAt),
    };
  })();
  const calibrationPreloadKickoffStartedAt = performance.now();
  startCalibrationPreload(calibrationStore, runtime);
  const calibrationPreloadKickoffMs = roundMs(performance.now() - calibrationPreloadKickoffStartedAt);
  const { runtimeBundle, elapsedMs: runtimeBundleMs } = await runtimeBundlePromise;
  const {
    aliasMatcher,
    resolverProjectionLookup,
    semanticScopeRegistry,
    reviewedFamilyRecallRegistry,
    entityScopeGraph,
    ambiguityDictionary,
    conceptRedirectRegistry,
    exactSafeRegistry,
  } = runtimeBundle;

  const entityResolver = buildEntityResolver(
    {
      blockingPort: runtime.pool !== undefined
        ? new PgBlockingAdapter(runtime.pool, runtime.searchSnapshotId)
        : new StubBlockingPort(),
      calibrationStore,
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
  const usecaseWireStartedAt = performance.now();
  const entityLookupV2UseCase = new EntityLookupV2UseCase({
    admissionGate: new ConceptAdmissionGate(conceptRedirectRegistry),
    lookupPlanner: new RuntimeLookupPlanner({
      aliasMatcher,
      ambiguityDictionary,
      exactSafeRegistry,
    }),
    semanticScopeRegistry,
    entityResolver,
    resolverProjectionLookup,
    candidateRetrieval: new MultiChannelRetrievalEngine({
      aliasMatcher,
      resolverProjectionLookup,
      reviewedFamilyRecall: reviewedFamilyRecallRegistry,
      entityScopeGraph,
    }),
    ambiguityDictionary,
    ...(aliasRegistryVersion !== undefined ? { aliasRegistryVersion } : {}),
    querySanitizer,
  });
  const usecaseWireMs = roundMs(performance.now() - usecaseWireStartedAt);
  const totalBootstrapMs = roundMs(performance.now() - bootstrapStartedAt);

  return {
    entityLookupV2UseCase,
    bootstrapProfile: {
      runtimeBundleMs,
      ltrModelsMs,
      ltrSupportStatus: ltrSupportState.status,
      ltrSupportReason: ltrSupportState.reason,
      calibrationPreloadKickoffMs,
      usecaseWireMs,
      runtimeBundleLoadProfile: runtimeBundle.loadProfile,
      totalBootstrapMs,
    },
    metadata: {
      searchSnapshotManifestPath: manifestPath,
      runtimeBundleCacheKey,
      ...(runtime.searchSnapshotId !== undefined ? { searchSnapshotId: runtime.searchSnapshotId } : {}),
    },
  };
}
