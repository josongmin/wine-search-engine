import type { SearchExecutorPort } from '../../../application/search/port/search-executor.port.js';
import type { ResolveUseCasePort } from '../../../application/search/port/search-route-usecases.port.js';
import type { EvalRunnerContract } from '../../../config/container-eval-contracts.js';
import type { WineSearchContainerServices } from '../../../config/container.js';

export interface SearchRouteDeps {
  readonly searchUseCase: SearchExecutorPort;
}

export interface ResolveRouteDeps {
  readonly resolveUseCase: ResolveUseCasePort;
}

export interface HttpServerDeps
  extends SearchRouteDeps {
  readonly evalRunner: EvalRunnerContract | null;
  /** Agentic orchestrator — present when AGENT_ENABLED=true and ChatLlmPort is available. */
  /**
   * Plan-then-Execute wine-search slice — present when
   * `WINE_SEARCH_ENABLED=true` and an Anthropic credential is configured.
   * When `undefined`, the `/v1/agent` route is not registered.
   */
  readonly wineSearch?: WineSearchContainerServices | undefined;
}
