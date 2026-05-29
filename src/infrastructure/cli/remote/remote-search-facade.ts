import type { SearchFacadePort } from '../../../application/cli/port/search-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type {
  SearchRunInput,
  SearchRunResult,
} from '../../../application/cli/dto/search.dto.js';
import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import { RemoteHttpClient } from './remote-http-client.js';

function toSearchBody(input: SearchRunInput): Record<string, unknown> {
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

export class RemoteSearchFacade implements SearchFacadePort {
  private readonly http: RemoteHttpClient;

  constructor(profile: ResolvedCliProfile, options: ConstructorParameters<typeof RemoteHttpClient>[1] = {}) {
    this.http = new RemoteHttpClient(profile, options);
  }

  async run(input: SearchRunInput, options: CliFacadeRequestOptions): Promise<SearchRunResult> {
    return await this.http.requestJson<SearchRunResult>(
      {
        method: 'POST',
        path: '/v1/search',
        body: toSearchBody(input),
      },
      options,
    );
  }
}
