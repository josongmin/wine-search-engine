import type { Config } from './env.js';
import { buildCoreContainerServices } from './container-core.js';
import { buildFeatureContainerServices } from './container-features.js';
import { buildWatchlistContainerServices } from './container-watchlist.js';
import type { RuntimeHandles } from './runtime-handles.js';
import type {
  CandidatePoolContract,
  DecisionEngineContract,
  DrinkingWindowUseCaseContract,
  EntityResolverContract,
  MixedSolverContract,
  QueryPlannerContract,
  RankerContract,
  ResponseBuilderContract,
} from './container-contracts.js';
import type { EvalRunnerContract } from './container-eval-contracts.js';
import type { AdaptiveToolExecutorContract } from './container-tool-contracts.js';
import type {
  BatchSearchUseCaseContract,
  DecomposedSearchUseCaseContract,
  HybridUseCaseContract,
  InterpretUseCaseContract,
  ReplayUseCaseContract,
  ResolveUseCaseContract,
  SearchUseCaseContract,
} from './container-search-contracts.js';
import type {
  WatchlistRuntimeContract,
  WatchlistServiceContract,
} from './container-contracts.js';

export interface Container {
  readonly queryPlanner: QueryPlannerContract;
  readonly entityResolver: EntityResolverContract;
  readonly candidatePool: CandidatePoolContract;
  readonly ranker: RankerContract;
  readonly decisionEngine: DecisionEngineContract;
  readonly responseBuilder: ResponseBuilderContract;
  readonly mixedSolver: MixedSolverContract;
  readonly searchUseCase: SearchUseCaseContract;
  readonly replayUseCase: ReplayUseCaseContract;
  readonly interpretUseCase: InterpretUseCaseContract;
  readonly resolveUseCase: ResolveUseCaseContract;
  readonly hybridUseCase: HybridUseCaseContract;
  readonly decomposedSearchUseCase: DecomposedSearchUseCaseContract;
  readonly drinkingWindowUseCase: DrinkingWindowUseCaseContract;
  readonly batchSearchUseCase: BatchSearchUseCaseContract;
  readonly adaptiveToolExecutor: AdaptiveToolExecutorContract;
  readonly watchlistService: WatchlistServiceContract;
  readonly watchlistRuntime: WatchlistRuntimeContract | null;
  readonly evalRunner: EvalRunnerContract | null;
}

export async function createContainer(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<Container> {
  const core = await buildCoreContainerServices(config, runtime);
  const features = buildFeatureContainerServices(core, runtime);
  const watchlist = buildWatchlistContainerServices(config);

  return {
    queryPlanner: core.queryPlanner,
    entityResolver: core.entityResolver,
    candidatePool: core.candidatePool,
    ranker: core.ranker,
    decisionEngine: core.decisionEngine,
    responseBuilder: core.responseBuilder,
    mixedSolver: core.mixedSolver,
    ...features,
    ...watchlist,
  };
}
