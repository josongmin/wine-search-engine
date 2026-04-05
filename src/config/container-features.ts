import type { Pool } from 'pg';
import type { EvalRunner } from '../domain/evaluation/service/eval-runner.js';
import type { Config } from './env.js';
import type { CoreContainerServices } from './container-core.js';
import type {
  AdaptiveToolExecutorContract,
  BatchSearchUseCaseContract,
  DecomposedSearchUseCaseContract,
  DrinkingWindowUseCaseContract,
  HybridUseCaseContract,
  InterpretUseCaseContract,
  ReplayUseCaseContract,
  ResolveUseCaseContract,
  SearchUseCaseContract,
} from './container-contracts.js';
import { buildAdaptiveToolExecutor, buildEvalRunner } from './container-aux-features.js';
import { buildUseCaseContainerServices } from './container-usecases.js';

export interface FeatureContainerServices {
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

export function buildFeatureContainerServices(
  _config: Config,
  core: CoreContainerServices,
  pool?: Pool,
): FeatureContainerServices {
  const useCases = buildUseCaseContainerServices(core);
  const adaptiveToolExecutor = buildAdaptiveToolExecutor(useCases);
  const evalRunner = buildEvalRunner(pool, useCases.searchUseCase);

  return {
    ...useCases,
    adaptiveToolExecutor,
    evalRunner,
  };
}
