import type { AuthFacadePort } from './auth-facade.port.js';
import type { SearchFacadePort } from './search-facade.port.js';
import type { LookupFacadePort } from './lookup-facade.port.js';
import type { AgentFacadePort } from './agent-facade.port.js';

/**
 * The set of facades a command may reach through its {@link CommandContext}.
 * The composition root (`cli-container.ts`) assembles a concrete registry per
 * target (local vs remote) so commands never branch on transport themselves.
 *
 * Typed product facades (`search`/`lookup`/`agent`) stay transport-agnostic.
 */
export interface CliFacadeRegistry {
  readonly auth: AuthFacadePort;
  readonly search: SearchFacadePort;
  readonly lookup: LookupFacadePort;
  readonly agent: AgentFacadePort;
}
