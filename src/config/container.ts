import type { Pool } from 'pg';
import type { EvalRunner } from '../domain/evaluation/service/eval-runner.js';
import type { Config } from './env.js';
import { buildCoreContainerServices } from './container-core.js';
import { buildFeatureContainerServices } from './container-features.js';
import type {
  AdaptiveToolExecutorContract,
  BatchSearchUseCaseContract,
  CandidatePoolContract,
  DecisionEngineContract,
  DecomposedSearchUseCaseContract,
  DrinkingWindowUseCaseContract,
  EntityResolverContract,
  HybridUseCaseContract,
  InterpretUseCaseContract,
  MixedSolverContract,
  QueryPlannerContract,
  RankerContract,
  ReplayUseCaseContract,
  ResolveUseCaseContract,
  ResponseBuilderContract,
  SearchUseCaseContract,
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
  readonly evalRunner: EvalRunner | null;
}

export async function createContainer(config: Config, pool?: Pool): Promise<Container> {
  const core = await buildCoreContainerServices(config, pool);
  const features = buildFeatureContainerServices(config, core, pool);

  return {
    queryPlanner: core.queryPlanner,
    entityResolver: core.entityResolver,
    candidatePool: core.candidatePool,
    ranker: core.ranker,
    decisionEngine: core.decisionEngine,
    responseBuilder: core.responseBuilder,
    mixedSolver: core.mixedSolver,
    ...features,
  };
}
