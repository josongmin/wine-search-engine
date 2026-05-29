import type { CoreContainerServices } from './container-core.js';
import type { EvalRunnerContract } from './container-eval-contracts.js';
import type { RuntimeHandles } from './runtime-handles.js';
import type { Config } from './env.js';
import type {
  DrinkingWindowUseCasePort,
} from '../application/drinking-window/port/drinking-window-usecase.port.js';
import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';
import type {
  AutocompleteUseCasePort,
  BatchSearchUseCasePort,
  DecomposedSearchUseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
  ResolveUseCasePort,
} from '../application/search/port/search-route-usecases.port.js';
import { buildEvalRunner } from './container-aux-features.js';
import {
  buildUseCaseContainerServices,
  type UseCaseExtensions,
} from './container-usecases.js';

interface FeatureContainerServices {
  readonly searchUseCase: SearchExecutorPort;
  readonly interpretUseCase: InterpretUseCasePort;
  readonly resolveUseCase: ResolveUseCasePort;
  readonly autocompleteUseCase: AutocompleteUseCasePort;
  readonly hybridUseCase: HybridUseCasePort;
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
  readonly drinkingWindowUseCase: DrinkingWindowUseCasePort;
  readonly batchSearchUseCase: BatchSearchUseCasePort;
  readonly evalRunner: EvalRunnerContract | null;
}

export function buildFeatureContainerServices(
  config: Config,
  core: CoreContainerServices,
  runtime: RuntimeHandles = {},
  useCaseExtensions: UseCaseExtensions = {},
): FeatureContainerServices {
  const useCases = buildUseCaseContainerServices(core, config, useCaseExtensions);
  const evalRunner = buildEvalRunner(runtime.pool, useCases.searchUseCase);

  return {
    ...useCases,
    evalRunner,
  };
}
