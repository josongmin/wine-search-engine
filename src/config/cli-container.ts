import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GlobalArgs } from '../application/cli/context/global-args.js';
import type { CommandContext } from '../application/cli/context/command-context.js';
import type { CliFacadeRegistry } from '../application/cli/port/cli-facade-registry.port.js';
import type { AuthFacadePort } from '../application/cli/port/auth-facade.port.js';
import type { ProfileStorePort } from '../application/cli/port/profile-store.port.js';
import type { ResolvedCliProfile } from '../application/cli/context/cli-profile.js';
import { EnvProfileResolver } from '../infrastructure/cli/profile/env-profile-resolver.js';
import { CodexAuthFacade } from '../infrastructure/cli/auth/codex-auth-facade.js';
import { CodexAuthStoreAdapter } from '../infrastructure/cli/auth/codex-auth-store.js';
import { ChatGptModelCatalogProbeAdapter } from '../infrastructure/cli/auth/chatgpt-model-catalog-probe.js';
import { CodexLoginDelegateAdapter } from '../infrastructure/cli/auth/codex-login-delegate.js';
import { LocalSearchFacade } from '../infrastructure/cli/local/local-search-facade.js';
import { LocalEntityFacade } from '../infrastructure/cli/local/local-entity-facade.js';
import { LocalWineSearchFacade } from '../infrastructure/cli/local/local-wine-search-facade.js';
import { LocalRawApiInvoker } from '../infrastructure/cli/local/local-raw-api-invoker.js';
import { RemoteSearchFacade } from '../infrastructure/cli/remote/remote-search-facade.js';
import { RemoteEntityFacade } from '../infrastructure/cli/remote/remote-entity-facade.js';
import { RemoteWineSearchFacade } from '../infrastructure/cli/remote/remote-wine-search-facade.js';
import { RemoteRawApiInvoker } from '../infrastructure/cli/remote/remote-raw-api-invoker.js';

/**
 * CLI composition root. Its ONLY job is to turn resolved global args into a
 * {@link CommandContext}: resolve the profile, assemble the facade registry,
 * and set request id / timeout / abort signal. No leaf parsing, no business
 * logic, no rendering (architecture decision §13).
 */

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

function buildAuthFacade(env: EnvLike): AuthFacadePort {
  return new CodexAuthFacade(
    new CodexAuthStoreAdapter(env),
    new ChatGptModelCatalogProbeAdapter(env),
    new CodexLoginDelegateAdapter(),
  );
}

/**
 * Builds the facade registry. Auth is target-independent; typed and raw-api
 * facades branch on the resolved target so leaf commands remain transport-agnostic.
 */
function resolveFacadeRegistry(env: EnvLike, profile: ResolvedCliProfile): CliFacadeRegistry {
  if (profile.target === 'local') {
    return {
      auth: buildAuthFacade(env),
      search: new LocalSearchFacade(),
      entity: new LocalEntityFacade(),
      wineSearch: new LocalWineSearchFacade(),
      rawApi: new LocalRawApiInvoker(),
    };
  }
  return {
    auth: buildAuthFacade(env),
    search: new RemoteSearchFacade(profile),
    entity: new RemoteEntityFacade(profile),
    wineSearch: new RemoteWineSearchFacade(profile),
    rawApi: new RemoteRawApiInvoker(profile),
  };
}

export interface BuildContextDeps {
  readonly env?: EnvLike;
  readonly profileResolver?: ProfileStorePort;
  readonly facadeRegistry?: CliFacadeRegistry;
}

/**
 * Assembles the {@link CommandContext} for a command run. All collaborators are
 * injectable so tests can supply fakes (env, resolver, facades) without
 * touching the real Codex token store.
 */
export function buildCommandContext(args: GlobalArgs, deps: BuildContextDeps = {}): CommandContext {
  const env = deps.env ?? process.env;
  const profileResolver = deps.profileResolver ?? new EnvProfileResolver(env);
  const profile = profileResolver.resolve({ args });
  const facades = deps.facadeRegistry ?? resolveFacadeRegistry(env, profile);
  const requestId = args.requestId ?? randomUUID();
  const timeoutMs = profile.timeoutMs ?? null;
  return {
    target: profile.target,
    profile,
    requestId,
    timeoutMs,
    abortSignal: timeoutMs != null ? AbortSignal.timeout(timeoutMs) : undefined,
    cwd: process.cwd(),
    readTextFile: (path: string) => readFile(path, 'utf8'),
    facades,
  };
}
