import { SearchUseCase } from '../application/search/search.usecase.js';
import { ReplayUseCase } from '../application/search/replay.usecase.js';
import { InterpretUseCase } from '../application/search/interpret.usecase.js';
import { ResolveUseCase } from '../application/search/resolve.usecase.js';
import { HybridUseCase } from '../application/search/hybrid.usecase.js';
import { DecomposedSearchUseCase } from '../application/search/decomposed-search.usecase.js';
import { DrinkingWindowUseCase } from '../application/drinking-window/drinking-window.usecase.js';
import { BatchSearchUseCase } from '../application/search/batch-search.usecase.js';
import type {
  DrinkingWindowUseCaseContract,
} from './container-contracts.js';
import type {
  BatchSearchUseCaseContract,
  DecomposedSearchUseCaseContract,
  HybridUseCaseContract,
  InterpretUseCaseContract,
  ReplayUseCaseContract,
  ResolveUseCaseContract,
  SearchUseCaseContract,
} from './container-search-contracts.js';
import type { CoreContainerServices } from './container-core.js';

export interface UseCaseContainerServices {
  readonly searchUseCase: SearchUseCaseContract;
  readonly replayUseCase: ReplayUseCaseContract;
  readonly interpretUseCase: InterpretUseCaseContract;
  readonly resolveUseCase: ResolveUseCaseContract;
  readonly hybridUseCase: HybridUseCaseContract;
  readonly decomposedSearchUseCase: DecomposedSearchUseCaseContract;
  readonly drinkingWindowUseCase: DrinkingWindowUseCaseContract;
  readonly batchSearchUseCase: BatchSearchUseCaseContract;
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
      querySanitizer: core.querySanitizer,
    }),
    resolveUseCase: new ResolveUseCase({
      queryPlanner: core.queryPlanner,
      entityResolver: core.entityResolver,
      querySanitizer: core.querySanitizer,
    }),
    hybridUseCase: new HybridUseCase({
      queryPlanner: core.queryPlanner,
      candidatePool: core.candidatePool,
      ranker: core.ranker,
      decisionEngine: core.decisionEngine,
      responseBuilder: core.responseBuilder,
      snapshotVersions: core.snapshotVersions,
      querySanitizer: core.querySanitizer,
    }),
    decomposedSearchUseCase,
    drinkingWindowUseCase,
    batchSearchUseCase: new BatchSearchUseCase(searchUseCase),
  };
}
