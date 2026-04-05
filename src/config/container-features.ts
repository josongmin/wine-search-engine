import type { CoreContainerServices } from './container-core.js';
import type { DrinkingWindowUseCaseContract } from './container-contracts.js';
import type { EvalRunnerContract } from './container-eval-contracts.js';
import type { AdaptiveToolExecutorContract } from './container-tool-contracts.js';
import type { RuntimeHandles } from './runtime-handles.js';
import type {
  SearchUseCaseContract,
  ReplayUseCaseContract,
  InterpretUseCaseContract,
  ResolveUseCaseContract,
  HybridUseCaseContract,
  DecomposedSearchUseCaseContract,
  BatchSearchUseCaseContract,
} from './container-search-contracts.js';
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
  readonly evalRunner: EvalRunnerContract | null;
}

export function buildFeatureContainerServices(
  core: CoreContainerServices,
  runtime: RuntimeHandles = {},
): FeatureContainerServices {
  const useCases = buildUseCaseContainerServices(core);
  const adaptiveToolExecutor = buildAdaptiveToolExecutor(useCases);
  const evalRunner = buildEvalRunner(runtime.pool, useCases.searchUseCase);

  return {
    ...useCases,
    adaptiveToolExecutor,
    evalRunner,
  };
}
