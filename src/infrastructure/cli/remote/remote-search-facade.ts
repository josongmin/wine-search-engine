import type { SearchFacadePort } from '../../../application/cli/port/search-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type {
  PrimitiveSearchInput,
  PrimitiveSearchResult,
} from '../../../application/cli/dto/search.dto.js';
import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import { RemoteHttpClient } from './remote-http-client.js';

type PrimitivePath =
  | '/v1/search/hybrid'
  | '/v1/search/semantic'
  | '/v1/search/lexical'
  | '/v1/lookup/wine';

function toSearchBody(input: PrimitiveSearchInput): Record<string, unknown> {
  return {
    query: input.query,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.queryBudget !== undefined ? { queryBudget: input.queryBudget } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.filters !== undefined ? { filters: input.filters } : {}),
    ...(input.preferences !== undefined ? { preferences: input.preferences } : {}),
  };
}

export class RemoteSearchFacade implements SearchFacadePort {
  private readonly http: RemoteHttpClient;

  constructor(profile: ResolvedCliProfile, options: ConstructorParameters<typeof RemoteHttpClient>[1] = {}) {
    this.http = new RemoteHttpClient(profile, options);
  }

  private async execute(
    path: PrimitivePath,
    input: PrimitiveSearchInput,
    options: CliFacadeRequestOptions,
  ): Promise<PrimitiveSearchResult> {
    return await this.http.requestJson<PrimitiveSearchResult>(
      {
        method: 'POST',
        path,
        body: toSearchBody(input),
      },
      options,
    );
  }

  async hybrid(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult> {
    return await this.execute('/v1/search/hybrid', input, options);
  }

  async semantic(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult> {
    return await this.execute('/v1/search/semantic', input, options);
  }

  async lexical(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult> {
    return await this.execute('/v1/search/lexical', input, options);
  }

  async lookupWine(input: PrimitiveSearchInput, options: CliFacadeRequestOptions): Promise<PrimitiveSearchResult> {
    return await this.execute('/v1/lookup/wine', input, options);
  }
}
