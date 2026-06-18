import type { LookupFacadePort } from '../../../application/cli/port/lookup-facade.port.js';
import type { CliFacadeRequestOptions } from '../../../application/cli/port/facade-request-options.port.js';
import type { PrimitiveSearchInput } from '../../../application/cli/dto/search.dto.js';
import { deepKeysToSnake } from '../../../interface/http/middleware/snake-case-hook.js';
import { LOOKUP_V2_DEFAULT_MAX_CANDIDATES } from '../../../interface/http/constants.js';
import { LocalLookupContainerRuntime } from './local-lookup-container-runtime.js';

/**
 * Local CLI lookup facade — calls EntityLookupV2UseCase directly (V2-only
 * cutover). Snake-cases the camelCase domain result so the rendered shape
 * matches the remote transport (which receives snake_case from /v2/entity-lookup).
 */
export class LocalLookupFacade implements LookupFacadePort {
  constructor(
    private readonly runtime: Pick<LocalLookupContainerRuntime, 'withContainer'> = new LocalLookupContainerRuntime(),
  ) {}

  async lookupWine(
    input: PrimitiveSearchInput,
    options: CliFacadeRequestOptions,
  ): Promise<Record<string, unknown>> {
    return await this.runtime.withContainer(async (container) => {
      const result = await container.entityLookupV2UseCase.execute(
        {
          query: input.query,
          maxCandidates: input.limit ?? LOOKUP_V2_DEFAULT_MAX_CANDIDATES,
          mode: 'default',
          requestId: options.requestId,
          ...(input.context?.locale !== undefined ? { locale: input.context.locale } : {}),
        },
        {
          requestId: options.requestId,
          abortSignal: options.abortSignal,
        },
      );
      return deepKeysToSnake(result) as Record<string, unknown>;
    });
  }
}
