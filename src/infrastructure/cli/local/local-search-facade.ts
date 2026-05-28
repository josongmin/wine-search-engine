import type { SearchFacadePort } from '../../../application/cli/port/search-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type {
  SearchHybridInput,
  SearchHybridResult,
  SearchRunInput,
  SearchRunResult,
} from '../../../application/cli/dto/search.dto.js';
// `deepKeysToSnake` is the SAME serializer the HTTP route hook uses, reused
// here so local target output matches the remote (wire) shape byte-for-byte.
// This is the local/remote parity guarantee (architecture decision §6.1 —
// allowed one-way projection, NOT a wire-shape roundtrip / re-parse).
import { deepKeysToSnake } from '../../../interface/http/middleware/snake-case-hook.js';
import type { SearchRequest } from '../../../application/search/search-request.dto.js';
import type { HybridSearchRequest } from '../../../application/search/hybrid-request.dto.js';
import { LocalContainerRuntime } from './local-container-runtime.js';

function toSearchRequest(input: SearchRunInput): SearchRequest {
  return {
    query: input.query,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.sessionContext !== undefined ? { sessionContext: input.sessionContext } : {}),
    ...(input.queryBudget !== undefined ? { queryBudget: input.queryBudget } : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
    ...(input.retrievalMode !== undefined ? { retrieval_mode: input.retrievalMode } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.filters !== undefined ? { filters: input.filters } : {}),
    ...(input.preferences !== undefined ? { preferences: input.preferences } : {}),
    ...(input.representativeConcept !== undefined
      ? { representativeConcept: input.representativeConcept }
      : {}),
  };
}

function toHybridRequest(input: SearchHybridInput): HybridSearchRequest {
  return {
    query: input.query,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.sessionContext !== undefined ? { sessionContext: input.sessionContext } : {}),
    ...(input.queryBudget !== undefined ? { queryBudget: input.queryBudget } : {}),
    ...(input.options !== undefined ? { options: input.options } : {}),
  };
}

export class LocalSearchFacade implements SearchFacadePort {
  constructor(
    private readonly runtime: Pick<LocalContainerRuntime, 'withContainer'> = new LocalContainerRuntime(),
  ) {}

  async run(input: SearchRunInput, options: CliFacadeRequestOptions): Promise<SearchRunResult> {
    return await this.runtime.withContainer(async (container) =>
      deepKeysToSnake(
        await container.searchUseCase.execute(toSearchRequest(input), options.requestId, {
          requestId: options.requestId,
          abortSignal: options.abortSignal,
        }),
      ),
    );
  }

  async hybrid(
    input: SearchHybridInput,
    options: CliFacadeRequestOptions,
  ): Promise<SearchHybridResult> {
    return await this.runtime.withContainer(async (container) =>
      deepKeysToSnake(
        await container.hybridUseCase.execute(toHybridRequest(input), options.requestId, {
          requestId: options.requestId,
          abortSignal: options.abortSignal,
        }),
      ),
    );
  }
}
