import type { LookupFacadePort } from '../../../application/cli/port/lookup-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type { PrimitiveSearchInput } from '../../../application/cli/dto/search.dto.js';
import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../../interface/http/constants.js';
import { RemoteHttpClient } from './remote-http-client.js';

/**
 * Remote CLI lookup facade — POSTs the V2-only public lookup surface
 * `/v2/entity-lookup` (the legacy `/v1/lookup/wine` route was removed in the
 * V2-only cutover). The response is the snake_case V2-native 4-state result.
 */
export class RemoteLookupFacade implements LookupFacadePort {
  private readonly http: RemoteHttpClient;

  constructor(profile: ResolvedCliProfile, options: ConstructorParameters<typeof RemoteHttpClient>[1] = {}) {
    this.http = new RemoteHttpClient(profile, options);
  }

  async lookupWine(
    input: PrimitiveSearchInput,
    options: CliFacadeRequestOptions,
  ): Promise<Record<string, unknown>> {
    return await this.http.requestJson<Record<string, unknown>>(
      {
        method: 'POST',
        path: '/v2/entity-lookup',
        body: {
          query: input.query,
          max_candidates: input.limit ?? LOOKUP_V2_DEFAULT_MAX_CANDIDATES,
          ...(input.context?.locale !== undefined ? { locale: input.context.locale } : {}),
        },
      },
      options,
    );
  }
}
