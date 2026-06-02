import { SearchUseCase } from '../application/search/search.usecase.js';
import type { MultiQueryGenerator } from '../domain/retrieval/service/multi-query-generator.js';
import type { HydeGenerator } from '../domain/retrieval/service/hyde-generator.js';
import { InterpretUseCase } from '../application/search/interpret.usecase.js';
import { ResolveUseCase } from '../application/search/resolve.usecase.js';
import { EntityLookupV2UseCase } from '../application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import { CurationUseCase } from '../application/curation/curation.usecase.js';
import { PgCurationStore } from '../infrastructure/curation/pg-curation-store.js';
import { MultiChannelRetrievalEngine } from '../application/search/entity-lookup-v2/multi-channel-retrieval-engine.js';
import { ConceptAdmissionGate } from '../domain/resolver/v2/concept-admission-gate.js';
import { LtrRerankDecider } from '../domain/resolver/v2/ltr-rerank-decider.js';
import { AutocompleteUseCase } from '../application/search/autocomplete.usecase.js';
import { HybridUseCase } from '../application/search/hybrid.usecase.js';
import { DecomposedSearchUseCase } from '../application/search/decomposed-search.usecase.js';
import { DecomposedSearchAdapter } from '../application/search/decomposed-search-adapter.js';
import { DrinkingWindowUseCase } from '../application/drinking-window/drinking-window.usecase.js';
import { BatchSearchUseCase } from '../application/search/batch-search.usecase.js';
import { getQueryEntrySecurityMetricsCollector } from '../infrastructure/observability/query-entry-security-metrics.js';
import type {
  DrinkingWindowUseCasePort,
} from '../application/drinking-window/port/drinking-window-usecase.port.js';
import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';
import type {
  AutocompleteUseCasePort,
  BatchSearchUseCasePort,
  DecomposedSearchUseCasePort,
  EntityLookupV2UseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
  ResolveUseCasePort,
} from '../application/search/port/search-route-usecases.port.js';
import type { CoreContainerServices } from './container-core.js';
import type { Config } from './env.js';

export interface UseCaseContainerServices {
  readonly searchUseCase: SearchExecutorPort;
  readonly interpretUseCase: InterpretUseCasePort;
  readonly resolveUseCase: ResolveUseCasePort;
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  /** Operator curation plane (T-ELV2-07); present only when a PG pool is wired. */
  readonly curationUseCase?: CurationUseCase | undefined;
  readonly autocompleteUseCase: AutocompleteUseCasePort;
  readonly hybridUseCase: HybridUseCasePort;
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
  readonly drinkingWindowUseCase: DrinkingWindowUseCasePort;
  readonly batchSearchUseCase: BatchSearchUseCasePort;
}

/**
 * Optional pre-retrieval LLM enrichment ports threaded through to
 * {@link SearchUseCase}. Both fields are independently optional — the
 * generators are gated by `WINE_SEARCH_MULTI_QUERY_ENABLED` AND the
 * presence of a usable structured-LLM adapter; either condition's
 * absence yields `undefined` here and the single-query baseline runs.
 */
export interface UseCaseExtensions {
  readonly multiQueryGenerator?: MultiQueryGenerator | undefined;
  readonly hydeGenerator?: HydeGenerator | undefined;
}

export function buildUseCaseContainerServices(
  core: CoreContainerServices,
  config: Config,
  extensions: UseCaseExtensions = {},
): UseCaseContainerServices {
  const drinkingWindowUseCase = new DrinkingWindowUseCase(core.drinkingWindowPredictor);
  const queryEntrySecurityObserver = getQueryEntrySecurityMetricsCollector();

  // T1.3b: Use DecomposedSearchAdapter to break the circular dependency.
  // SearchUseCase needs decomposedSearch; DecomposedSearchUseCase needs SearchUseCase.
  const decomposedRef: { impl?: DecomposedSearchUseCase } = {};
  const decomposedAdapter = new DecomposedSearchAdapter(() => {
    const impl = decomposedRef.impl;
    if (impl === undefined) {
      throw new Error('[DecomposedSearchAdapter] wiring incomplete — impl not set');
    }
    return impl;
  });

  const searchUseCase = new SearchUseCase({
    queryPlanner: core.queryPlanner,
    entityLookupAnchorRefresh: core.entityLookupAnchorRefresh,
    blocker: core.blocker,
    entityResolver: core.entityResolver,
    entityLookup: core.entityLookup,
    candidatePool: core.candidatePool,
    browseRetriever: core.browseRetriever,
    compareRetriever: core.compareRetriever,
    ranker: core.ranker,
    decisionEngine: core.decisionEngine,
    responseBuilder: core.responseBuilder,
    mixedSolver: core.mixedSolver,
    snapshotVersions: core.snapshotVersions,
    querySanitizer: core.querySanitizer,
    injectionJudge: core.injectionJudge,
    judgeFailureMode: config.queryEntrySecurity.judgeFailureMode,
    judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
    queryEntrySecurityObserver,
    drinkingWindow: drinkingWindowUseCase,
    fieldAvailability: core.fieldAvailability,
    cacheService: core.cacheService,
    cacheLookupRuntimeState: core.cacheLookupRuntimeState,
    cacheLookupRuntimeStateProvider: core.cacheLookupRuntimeStateProvider,
    ltrModels: core.ltrModels,
    decomposedSearch: decomposedAdapter,
    ...(extensions.multiQueryGenerator !== undefined
      ? { multiQueryGenerator: extensions.multiQueryGenerator }
      : {}),
    ...(extensions.hydeGenerator !== undefined
      ? { hydeGenerator: extensions.hydeGenerator }
      : {}),
  });

  decomposedRef.impl = new DecomposedSearchUseCase(searchUseCase);
  const decomposedSearchUseCase = decomposedRef.impl;
  const resolveUseCase = new ResolveUseCase({
    queryPlanner: core.queryPlanner,
    blocker: core.blocker,
    entityResolver: core.entityResolver,
    entityLookup: core.entityLookup,
    snapshotVersions: core.snapshotVersions,
    querySanitizer: core.querySanitizer,
    injectionJudge: core.injectionJudge,
    judgeFailureMode: config.queryEntrySecurity.judgeFailureMode,
    judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
    queryEntrySecurityObserver,
  });

  // T-ELV2-01: dedicated `/v2/entity-lookup` use case. Sibling stack to the
  // discovery primitives — reuses the resolver primitives as substrate, owns
  // the admission gate + 4-state calibrated decision.
  const entityLookupV2UseCase = new EntityLookupV2UseCase({
    admissionGate: new ConceptAdmissionGate(),
    queryPlanner: core.queryPlanner,
    blocker: core.blocker,
    entityResolver: core.entityResolver,
    entityLookup: core.entityLookup,
    // T-ELV2-04: real independent timed multi-channel retrieval over the live
    // alias substrate (per-channel latency/score; replaces the latencyMs:0 reproj).
    candidateRetrieval: new MultiChannelRetrievalEngine({
      aliasMatcher: core.aliasMatcher,
      entityLookup: core.entityLookup,
    }),
    // T-ELV2-05: learned reranker — wired ONLY when LTR serving is on AND a model
    // is loaded (core.ltrModels present). When absent we OMIT the reranker entirely
    // so the calibrated-abstain decision stands alone: otherwise the decider's
    // lexicalFallback would apply its (self-admitted UNVALIDATED) 0.5/0.1 thresholds
    // to calibratedScore on every live request and downgrade-only combine could flip
    // a calibrated resolve — the exact threshold-tweak the ticket forbids. The
    // learned branch is reached only with a real loaded model (or in tests via an
    // injected model).
    ...(core.ltrModels !== undefined
      ? { reranker: new LtrRerankDecider({ ltrModels: core.ltrModels }) }
      : {}),
    // T-ELV2-06: persisted ambiguity substrate (registry-backed) enriches the
    // clarification contract with authoritative types + severity.
    ambiguityDictionary: core.ambiguityDictionary,
    // T-ELV2-03: dedicated alias-registry version identity read from the live
    // alias substrate (delegated through the CachedAliasMatcher chain), surfaced
    // on the V2 response meta. undefined when the matcher carries no version.
    ...(core.aliasMatcher.getRegistryVersion?.() !== undefined
      ? { aliasRegistryVersion: core.aliasMatcher.getRegistryVersion() }
      : {}),
    querySanitizer: core.querySanitizer,
    injectionJudge: core.injectionJudge,
    judgeFailureMode: config.queryEntrySecurity.judgeFailureMode,
    judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
    queryEntrySecurityObserver,
  });

  // T-ELV2-07: operator curation plane. DB-only — wired solely when a PG pool
  // exists (snapshot/in-memory modes leave it undefined and the ops routes are
  // not registered).
  const curationUseCase = core.pool !== undefined
    ? new CurationUseCase(new PgCurationStore(core.pool))
    : undefined;

  return {
    searchUseCase,
    entityLookupV2UseCase,
    ...(curationUseCase !== undefined ? { curationUseCase } : {}),
    interpretUseCase: new InterpretUseCase({
      queryPlanner: core.queryPlanner,
      querySanitizer: core.querySanitizer,
      injectionJudge: core.injectionJudge,
      judgeFailureMode: config.queryEntrySecurity.judgeFailureMode,
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
    }),
    resolveUseCase,
    autocompleteUseCase: new AutocompleteUseCase({
      resolveUseCase,
      entityLookup: core.entityLookup,
    }),
    hybridUseCase: new HybridUseCase({
      queryPlanner: core.queryPlanner,
      candidatePool: core.candidatePool,
      browseRetriever: core.browseRetriever,
      compareRetriever: core.compareRetriever,
      entityResolver: core.entityResolver,
      entityLookup: core.entityLookup,
      ranker: core.ranker,
      decisionEngine: core.decisionEngine,
      responseBuilder: core.responseBuilder,
      snapshotVersions: core.snapshotVersions,
      drinkingWindow: drinkingWindowUseCase,
      querySanitizer: core.querySanitizer,
      injectionJudge: core.injectionJudge,
      judgeFailureMode: config.queryEntrySecurity.judgeFailureMode,
      judgeTimeoutMs: config.queryEntrySecurity.judgeTimeoutMs,
      queryEntrySecurityObserver,
      fieldAvailability: core.fieldAvailability,
      cacheService: core.cacheService,
      cacheLookupRuntimeState: core.cacheLookupRuntimeState,
      cacheLookupRuntimeStateProvider: core.cacheLookupRuntimeStateProvider,
      decomposedSearch: decomposedAdapter,
    }),
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    batchSearchUseCase: new BatchSearchUseCase(searchUseCase),
  };
}
