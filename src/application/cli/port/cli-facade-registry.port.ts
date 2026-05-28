import type { AuthFacadePort } from './auth-facade.port.js';
import type { SearchFacadePort } from './search-facade.port.js';
import type { EntityFacadePort } from './entity-facade.port.js';
import type { WineSearchFacadePort } from './wine-search-facade.port.js';
import type { RawApiInvokerPort } from './raw-api-invoker.port.js';

/**
 * The set of facades a command may reach through its {@link CommandContext}.
 * The composition root (`cli-container.ts`) assembles a concrete registry per
 * target (local vs remote) so commands never branch on transport themselves.
 *
 * Typed product facades (`search`/`entity`/`wineSearch`) stay separate from
 * the raw transport facade (`rawApi`) by design — see the architecture
 * decision, §7.
 */
export interface CliFacadeRegistry {
  readonly auth: AuthFacadePort;
  readonly search: SearchFacadePort;
  readonly entity: EntityFacadePort;
  readonly wineSearch: WineSearchFacadePort;
  readonly rawApi: RawApiInvokerPort;
}
