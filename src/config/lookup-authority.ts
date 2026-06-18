import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { roundElapsedMs } from './round-elapsed-ms.js';
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
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type { Resolver } from '../domain/resolver/service/resolver.js';
import type { SearchSnapshotAliasMatcher } from '../infrastructure/adapter/search-snapshot-alias-matcher.js';
import type { LookupResolverProjectionPort } from '../application/search/port/search-pipeline-deps.port.js';
import {
  buildLookupV2SubstrateCapabilitySnapshot,
  type LookupV2SubstrateCapabilitySnapshot,
  type LookupV2UnwiredRecallSubstrateId,
} from '../domain/resolver/v2/lookup-v2-substrate-capabilities.js';

export interface LookupAuthorityBootstrapProfile {
  readonly runtimeBundleMs: number;
  readonly ltrModelsMs: number;
  readonly ltrSupportStatus: 'unsupported';
  readonly ltrSupportReason: 'lookup_domain_model_absent';
  readonly substrateCapabilities: LookupV2SubstrateCapabilitySnapshot;
  readonly calibrationPreloadKickoffMs: number;
  readonly usecaseWireMs: number;
  readonly runtimeBundleLoadProfile: LookupRuntimeBundleLoadProfile;
  readonly totalBootstrapMs: number;
}

export interface LookupAuthorityRuntimeMetadata {
  readonly searchSnapshotManifestPath: string;
  readonly runtimeBundleCacheKey: string;
  readonly searchSnapshotId?: string | undefined;
  /** Snapshot-published scope graph family-edge count at bootstrap (0 = dormant family_graph). */
  readonly familyGraphEdgeCount: number;
}

export interface LookupAuthorityRuntimeProbe {
  readonly aliasMatcher: SearchSnapshotAliasMatcher;
}

export interface LookupAuthorityServices {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  readonly resolverProjectionLookup: LookupResolverProjectionPort;
  readonly bootstrapProfile: LookupAuthorityBootstrapProfile;
  readonly metadata: LookupAuthorityRuntimeMetadata;
  readonly runtimeProbe: LookupAuthorityRuntimeProbe;
}

/** Operator-plane snapshot of lookup runtime substrate health (coverage-health). */
export interface LookupOpsRuntimeHealthView {
  readonly searchSnapshotId?: string | undefined;
  readonly familyGraphEdgeCount: number;
  readonly ltrSupportStatus: 'unsupported';
  readonly ltrSupportReason: 'lookup_domain_model_absent';
  readonly unwiredSubstrateIds: readonly LookupV2UnwiredRecallSubstrateId[];
}

export function buildLookupOpsRuntimeHealthView(
  authority: Pick<LookupAuthorityServices, 'metadata' | 'bootstrapProfile'>,
): LookupOpsRuntimeHealthView {
  return {
    ...(authority.metadata.searchSnapshotId !== undefined
      ? { searchSnapshotId: authority.metadata.searchSnapshotId }
      : {}),
    familyGraphEdgeCount: authority.metadata.familyGraphEdgeCount,
    ltrSupportStatus: authority.bootstrapProfile.ltrSupportStatus,
    ltrSupportReason: authority.bootstrapProfile.ltrSupportReason,
    unwiredSubstrateIds: authority.bootstrapProfile.substrateCapabilities.unwiredSubstrates.map(
      (row) => row.id,
    ),
  };
}

export interface LookupV2LtrSupportState {
  readonly status: 'unsupported';
  readonly reason: 'lookup_domain_model_absent';
}

export interface LookupAuthorityPrebuiltDeps {
  readonly calibrationStore?: CalibrationStore | undefined;
  readonly entityResolver?: Resolver | undefined;
}

export function startCalibrationPreload(
  calibrationStore: MemoizedCalibrationStore | StubCalibrationStore,
  runtime: RuntimeHandles,
): void {
  if (!(calibrationStore instanceof MemoizedCalibrationStore)) {
    return;
  }
  void calibrationStore.preload(QUERY_CLASSES).catch((error: unknown) => {
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
  return roundElapsedMs(value);
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
  prebuilt: LookupAuthorityPrebuiltDeps = {},
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
  const calibrationStore = prebuilt.calibrationStore instanceof MemoizedCalibrationStore
    || prebuilt.calibrationStore instanceof StubCalibrationStore
    ? prebuilt.calibrationStore
    : runtime.pool !== undefined
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

  const entityResolver = prebuilt.entityResolver ?? buildEntityResolver(
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

  const aliasRegistryVersion = aliasMatcher.getRegistryVersion();
  const familyGraphEdgeCount = entityScopeGraph.countEdgesByRelation('family');
  if (familyGraphEdgeCount === 0) {
    bootstrapLogger.warn(
      {
        component: 'LookupAuthorityServices',
        searchSnapshotId: runtime.searchSnapshotId,
        familyGraphEdgeCount,
        runtimeSource: 'lookup_scope_graph_runtime',
      },
      '[lookup-authority] family_graph substrate has zero family edges; channel may fire with hitCount=0 until snapshot scope graph is populated',
    );
  } else {
    bootstrapLogger.info(
      {
        component: 'LookupAuthorityServices',
        searchSnapshotId: runtime.searchSnapshotId,
        familyGraphEdgeCount,
      },
      '[lookup-authority] family_graph substrate loaded from snapshot scope graph',
    );
  }
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
      substrateCapabilities: buildLookupV2SubstrateCapabilitySnapshot({
        ltrSupportStatus: ltrSupportState.status,
        ltrSupportReason: ltrSupportState.reason,
      }),
      calibrationPreloadKickoffMs,
      usecaseWireMs,
      runtimeBundleLoadProfile: runtimeBundle.loadProfile,
      totalBootstrapMs,
    },
    metadata: {
      searchSnapshotManifestPath: manifestPath,
      runtimeBundleCacheKey,
      familyGraphEdgeCount,
      ...(runtime.searchSnapshotId !== undefined ? { searchSnapshotId: runtime.searchSnapshotId } : {}),
    },
    resolverProjectionLookup,
    runtimeProbe: {
      aliasMatcher,
    },
  };
}
