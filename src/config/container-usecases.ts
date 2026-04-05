import { SearchUseCase } from '../application/search/search.usecase.js';
import { ReplayUseCase } from '../application/search/replay.usecase.js';
import { InterpretUseCase } from '../application/search/interpret.usecase.js';
import { ResolveUseCase } from '../application/search/resolve.usecase.js';
import { HybridUseCase } from '../application/search/hybrid.usecase.js';
import { DecomposedSearchUseCase } from '../application/search/decomposed-search.usecase.js';
import { DrinkingWindowUseCase } from '../application/drinking-window/drinking-window.usecase.js';
import { BatchSearchUseCase } from '../application/search/batch-search.usecase.js';
import type { CoreContainerServices } from './container-core.js';

export interface UseCaseContainerServices {
  readonly searchUseCase: SearchUseCase;
  readonly replayUseCase: ReplayUseCase;
  readonly interpretUseCase: InterpretUseCase;
  readonly resolveUseCase: ResolveUseCase;
  readonly hybridUseCase: HybridUseCase;
  readonly decomposedSearchUseCase: DecomposedSearchUseCase;
  readonly drinkingWindowUseCase: DrinkingWindowUseCase;
  readonly batchSearchUseCase: BatchSearchUseCase;
}

export function buildUseCaseContainerServices(
  core: CoreContainerServices,
): UseCaseContainerServices {
  const drinkingWindowUseCase = new DrinkingWindowUseCase(core.drinkingWindowPredictor);
  const searchUseCase = new SearchUseCase({
    queryPlanner: core.queryPlanner,
    entityResolver: core.entityResolver,
    candidatePool: core.candidatePool,
    ranker: core.ranker,
    decisionEngine: core.decisionEngine,
    responseBuilder: core.responseBuilder,
    mixedSolver: core.mixedSolver,
    snapshotVersions: core.snapshotVersions,
    querySanitizer: core.querySanitizer,
    injectionJudge: core.injectionJudge,
    drinkingWindow: drinkingWindowUseCase,
    cacheService: core.cacheService,
    ltrModels: core.ltrModels,
  });
  const decomposedSearchUseCase = new DecomposedSearchUseCase(searchUseCase);

  return {
    searchUseCase,
    replayUseCase: new ReplayUseCase({
      searchUseCase,
      snapshotVersions: core.snapshotVersions,
    }),
    interpretUseCase: new InterpretUseCase({
      queryPlanner: core.queryPlanner,
    }),
    resolveUseCase: new ResolveUseCase({
      queryPlanner: core.queryPlanner,
      entityResolver: core.entityResolver,
    }),
    hybridUseCase: new HybridUseCase({
      queryPlanner: core.queryPlanner,
      candidatePool: core.candidatePool,
      ranker: core.ranker,
      decisionEngine: core.decisionEngine,
      responseBuilder: core.responseBuilder,
      snapshotVersions: core.snapshotVersions,
    }),
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    batchSearchUseCase: new BatchSearchUseCase(searchUseCase),
  };
}
