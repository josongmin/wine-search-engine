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
  EntityLookupV2UseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
} from '../application/search/port/search-route-usecases.port.js';
import type { CurationUseCase } from '../application/curation/curation.usecase.js';
import { buildEvalRunner } from './container-aux-features.js';
import {
  buildUseCaseContainerServices,
  type UseCaseExtensions,
} from './container-usecases.js';
import type { LookupAuthorityServices } from './lookup-authority.js';

interface FeatureContainerServices {
  readonly searchUseCase: SearchExecutorPort;
  readonly interpretUseCase: InterpretUseCasePort;
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  readonly curationUseCase?: CurationUseCase | undefined;
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
  lookupAuthority: LookupAuthorityServices,
  runtime: RuntimeHandles = {},
  useCaseExtensions: UseCaseExtensions = {},
): FeatureContainerServices {
  const useCases = buildUseCaseContainerServices(core, config, useCaseExtensions, {
    entityLookupV2UseCase: lookupAuthority.entityLookupV2UseCase,
    resolverProjectionLookup: lookupAuthority.resolverProjectionLookup,
  });
  const evalRunner = buildEvalRunner(runtime.pool, useCases.searchUseCase);

  return {
    ...useCases,
    entityLookupV2UseCase: lookupAuthority.entityLookupV2UseCase,
    evalRunner,
  };
}
