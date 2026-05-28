import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import type {
  EntityAutocompleteInput,
  EntityAutocompleteResult,
  EntityResolveInput,
  EntityResolveResult,
} from '../../../application/cli/dto/entity.dto.js';
import type { EntityFacadePort } from '../../../application/cli/port/entity-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import { RemoteHttpClient } from './remote-http-client.js';

function toResolveBody(
  input: EntityResolveInput | EntityAutocompleteInput,
): Record<string, unknown> {
  return {
    query: input.query,
    ...(input.context !== undefined ? { context: input.context } : {}),
    ...(input.sessionContext !== undefined ? { sessionContext: input.sessionContext } : {}),
    ...(input.queryBudget !== undefined ? { queryBudget: input.queryBudget } : {}),
  };
}

export class RemoteEntityFacade implements EntityFacadePort {
  private readonly http: RemoteHttpClient;

  constructor(profile: ResolvedCliProfile, options: ConstructorParameters<typeof RemoteHttpClient>[1] = {}) {
    this.http = new RemoteHttpClient(profile, options);
  }

  async resolve(
    input: EntityResolveInput,
    options: CliFacadeRequestOptions,
  ): Promise<EntityResolveResult> {
    return await this.http.requestJson<EntityResolveResult>(
      {
        method: 'POST',
        path: '/v1/entity/resolve',
        body: toResolveBody(input),
      },
      options,
    );
  }

  async autocomplete(
    input: EntityAutocompleteInput,
    options: CliFacadeRequestOptions,
  ): Promise<EntityAutocompleteResult> {
    return await this.http.requestJson<EntityAutocompleteResult>(
      {
        method: 'POST',
        path: '/v1/entity/autocomplete',
        body: toResolveBody(input),
      },
      options,
    );
  }
}
