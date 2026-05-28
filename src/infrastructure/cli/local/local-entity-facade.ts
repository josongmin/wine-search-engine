import type { EntityFacadePort } from '../../../application/cli/port/entity-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type {
  EntityAutocompleteInput,
  EntityAutocompleteResult,
  EntityResolveInput,
  EntityResolveResult,
} from '../../../application/cli/dto/entity.dto.js';
import type { ResolveRequest } from '../../../application/search/resolve-request.dto.js';
import { LocalContainerRuntime } from './local-container-runtime.js';

function toResolveRequest(input: EntityResolveInput | EntityAutocompleteInput, requestId: string): ResolveRequest {
  return {
    query: input.query,
    requestId,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.sessionContext !== undefined ? { sessionContext: input.sessionContext } : {}),
    ...(input.queryBudget !== undefined ? { queryBudget: input.queryBudget } : {}),
  };
}

export class LocalEntityFacade implements EntityFacadePort {
  constructor(
    private readonly runtime: Pick<LocalContainerRuntime, 'withContainer'> = new LocalContainerRuntime(),
  ) {}

  async resolve(
    input: EntityResolveInput,
    options: CliFacadeRequestOptions,
  ): Promise<EntityResolveResult> {
    return await this.runtime.withContainer(async (container) =>
      container.resolveUseCase.execute(toResolveRequest(input, options.requestId), {
        requestId: options.requestId,
        abortSignal: options.abortSignal,
      }),
    );
  }

  async autocomplete(
    input: EntityAutocompleteInput,
    options: CliFacadeRequestOptions,
  ): Promise<EntityAutocompleteResult> {
    return await this.runtime.withContainer(async (container) =>
      container.autocompleteUseCase.execute(toResolveRequest(input, options.requestId), {
        requestId: options.requestId,
        abortSignal: options.abortSignal,
      }),
    );
  }
}
