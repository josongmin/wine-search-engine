import type { SearchFacadePort } from '../../../application/cli/port/search-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type {
  PrimitiveSearchInput,
  PrimitiveSearchResult,
} from '../../../application/cli/dto/search.dto.js';
import { deepKeysToSnake } from '../../../interface/http/middleware/snake-case-hook.js';
import type { SearchRequest } from '../../../application/search/search-request.dto.js';
import { LocalContainerRuntime } from './local-container-runtime.js';

type PrimitiveKind = 'hybrid' | 'semantic' | 'lexical';

function toSearchRequest(input: PrimitiveSearchInput, kind: PrimitiveKind): SearchRequest {
  return {
    query: input.query,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.queryBudget !== undefined ? { queryBudget: input.queryBudget } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.filters !== undefined ? { filters: input.filters } : {}),
    ...(input.preferences !== undefined ? { preferences: input.preferences } : {}),
    ...(kind === 'hybrid'
      ? { retrieval_mode: 'hybrid' as const, retrievalLane: 'hybrid' as const }
      : {}),
    ...(kind === 'semantic'
      ? { retrieval_mode: 'hybrid' as const, retrievalLane: 'semantic_only' as const }
      : {}),
    ...(kind === 'lexical'
      ? { retrieval_mode: 'hybrid' as const, retrievalLane: 'lexical_only' as const }
      : {}),
  };
}

export class LocalSearchFacade implements SearchFacadePort {
  constructor(
    private readonly runtime: Pick<LocalContainerRuntime, 'withContainer'> = new LocalContainerRuntime(),
  ) {}

  private async execute(
    kind: PrimitiveKind,
    input: PrimitiveSearchInput,
    options: CliFacadeRequestOptions,
  ): Promise<PrimitiveSearchResult> {
    return await this.runtime.withContainer(async (container) => {
      return deepKeysToSnake(
        await container.searchUseCase.execute(toSearchRequest(input, kind), options.requestId, {
          requestId: options.requestId,
          abortSignal: options.abortSignal,
        }),
      );
    });
  }

  async hybrid(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult> {
    return await this.execute('hybrid', input, options);
  }

  async semantic(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult> {
    return await this.execute('semantic', input, options);
  }

  async lexical(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult> {
    return await this.execute('lexical', input, options);
  }
}
