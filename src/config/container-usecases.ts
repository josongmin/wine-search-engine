import { SearchUseCase } from '../application/search/search.usecase.js';
import { ReplayUseCase } from '../application/search/replay.usecase.js';
import { InterpretUseCase } from '../application/search/interpret.usecase.js';
import { ResolveUseCase } from '../application/search/resolve.usecase.js';
import { HybridUseCase } from '../application/search/hybrid.usecase.js';
import { DecomposedSearchUseCase } from '../application/search/decomposed-search.usecase.js';
import { DrinkingWindowUseCase } from '../application/drinking-window/drinking-window.usecase.js';
import { BatchSearchUseCase } from '../application/search/batch-search.usecase.js';
import { getQueryEntrySecurityMetricsCollector } from '../infrastructure/observability/query-entry-security-metrics.js';
import type {
  DrinkingWindowUseCasePort,
} from '../application/drinking-window/port/drinking-window-usecase.port.js';
import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';
import type {
  BatchSearchUseCasePort,
  DecomposedSearchParentContext,
  DecomposedSearchUseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
  ReplayUseCasePort,
  ResolveUseCasePort,
} from '../application/search/port/search-route-usecases.port.js';
import type { CoreContainerServices } from './container-core.js';
import type { Config } from './env.js';

export interface UseCaseContainerServices {
  readonly searchUseCase: SearchExecutorPort;
  readonly replayUseCase: ReplayUseCasePort;
  readonly interpretUseCase: InterpretUseCasePort;
  readonly resolveUseCase: ResolveUseCasePort;
  readonly hybridUseCase: HybridUseCasePort;
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
  readonly drinkingWindowUseCase: DrinkingWindowUseCasePort;
  readonly batchSearchUseCase: BatchSearchUseCasePort;
}

export function buildUseCaseContainerServices(
  core: CoreContainerServices,
  config: Config,
): UseCaseContainerServices {
  const drinkingWindowUseCase = new DrinkingWindowUseCase(core.drinkingWindowPredictor);
  const queryEntrySecurityObserver = getQueryEntrySecurityMetricsCollector();

  // Use a deferred reference to break the circular dependency:
  // SearchUseCase needs decomposedSearch, but DecomposedSearchUseCase needs SearchUseCase.
  const deferredDecomposed: { ref?: DecomposedSearchUseCasePort } = {};

  const searchUseCase = new SearchUseCase({
    queryPlanner: core.queryPlanner,
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
    queryEntrySecurityObserver,
    drinkingWindow: drinkingWindowUseCase,
    cacheService: core.cacheService,
    ltrModels: core.ltrModels,
    decomposedSearch: {
      execute: (
        subQueries: [string, string],
        comparisonIntent: 'compare' | 'recommend_one' | 'list_both',
        originalQuery: string,
        requestId: string,
        startTime: number,
        parentContext: DecomposedSearchParentContext | undefined,
      ) => deferredDecomposed.ref!.execute(
        subQueries,
        comparisonIntent,
        originalQuery,
        requestId,
        startTime,
        parentContext,
      ),
    },
  });

  const decomposedSearchUseCase = new DecomposedSearchUseCase(searchUseCase);
  deferredDecomposed.ref = decomposedSearchUseCase;

  return {
    searchUseCase,
    replayUseCase: new ReplayUseCase({
      searchUseCase,
      snapshotVersions: core.snapshotVersions,
    }),
    interpretUseCase: new InterpretUseCase({
      queryPlanner: core.queryPlanner,
      querySanitizer: core.querySanitizer,
      injectionJudge: core.injectionJudge,
      judgeFailureMode: config.queryEntrySecurity.judgeFailureMode,
      queryEntrySecurityObserver,
    }),
    resolveUseCase: new ResolveUseCase({
      queryPlanner: core.queryPlanner,
      entityResolver: core.entityResolver,
      entityLookup: core.entityLookup,
      querySanitizer: core.querySanitizer,
      injectionJudge: core.injectionJudge,
      judgeFailureMode: config.queryEntrySecurity.judgeFailureMode,
      queryEntrySecurityObserver,
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
      ltrModels: core.ltrModels,
      querySanitizer: core.querySanitizer,
      injectionJudge: core.injectionJudge,
      judgeFailureMode: config.queryEntrySecurity.judgeFailureMode,
      queryEntrySecurityObserver,
      cacheService: core.cacheService,
    }),
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    batchSearchUseCase: new BatchSearchUseCase(searchUseCase),
  };
}
