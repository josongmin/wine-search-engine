import type { CoreContainerServices } from './container-core.js';
import type { EvalRunnerContract } from './container-eval-contracts.js';
import type { AdaptiveToolExecutorContract } from './container-tool-contracts.js';
import type { RuntimeHandles } from './runtime-handles.js';
import type { Config } from './env.js';
import type {
  DrinkingWindowUseCasePort,
} from '../application/drinking-window/port/drinking-window-usecase.port.js';
import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';
import type {
  BatchSearchUseCasePort,
  DecomposedSearchUseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
  ReplayUseCasePort,
  ResolveUseCasePort,
} from '../application/search/port/search-route-usecases.port.js';
import { buildAdaptiveToolExecutor, buildEvalRunner } from './container-aux-features.js';
import { buildUseCaseContainerServices } from './container-usecases.js';

export interface FeatureContainerServices {
  readonly searchUseCase: SearchExecutorPort;
  readonly replayUseCase: ReplayUseCasePort;
  readonly interpretUseCase: InterpretUseCasePort;
  readonly resolveUseCase: ResolveUseCasePort;
  readonly hybridUseCase: HybridUseCasePort;
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
  readonly drinkingWindowUseCase: DrinkingWindowUseCasePort;
  readonly batchSearchUseCase: BatchSearchUseCasePort;
  readonly adaptiveToolExecutor: AdaptiveToolExecutorContract;
  readonly evalRunner: EvalRunnerContract | null;
}

export function buildFeatureContainerServices(
  config: Config,
  core: CoreContainerServices,
  runtime: RuntimeHandles = {},
): FeatureContainerServices {
  const useCases = buildUseCaseContainerServices(core, config);
  const adaptiveToolExecutor = buildAdaptiveToolExecutor(useCases);
  const evalRunner = buildEvalRunner(runtime.pool, useCases.searchUseCase);

  return {
    ...useCases,
    adaptiveToolExecutor,
    evalRunner,
  };
}
