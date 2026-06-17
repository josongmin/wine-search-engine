import type { SearchExecutorPort } from '../../../application/search/port/search-executor.port.js';
import type { EntityLookupV2UseCasePort } from '../../../application/search/port/search-route-usecases.port.js';
import type { EvalRunnerContract } from '../../../config/container-eval-contracts.js';
import type { WineSearchContainerServices } from '../../../config/container.js';
import type { CurationUseCase } from '../../../application/curation/curation.usecase.js';

export interface SearchRouteDeps {
  readonly searchUseCase: SearchExecutorPort;
}

/** Dependencies for the operator curation plane routes (T-ELV2-07). */
export interface CurationOpsRouteDeps {
  readonly curationUseCase: CurationUseCase;
}

/** Dependencies for `/v1/entity/resolve` (internal) and `/v2/entity-lookup` (public). */
export type ResolveRouteDeps = {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
};

export interface HttpServerDeps
  extends SearchRouteDeps, ResolveRouteDeps {
  readonly evalRunner: EvalRunnerContract | null;
  /**
   * Operator curation plane use case (T-ELV2-07). Optional so lightweight
   * server-construction tests need not stub it; when present the ops curation
   * routes are registered.
   */
  readonly curationUseCase?: CurationUseCase | undefined;
  /** Agentic orchestrator — present when AGENT_ENABLED=true and ChatLlmPort is available. */
  /**
   * Plan-then-Execute wine-search slice — present when
   * `WINE_SEARCH_ENABLED=true` and an Anthropic credential is configured.
   * When `undefined`, the `/v1/agent` route is not registered.
   */
  readonly wineSearch?: WineSearchContainerServices | undefined;
}
