import type { SearchExecutorPort } from '../../../application/search/port/search-executor.port.js';
import type { EntityLookupV2UseCasePort } from '../../../application/search/port/search-route-usecases.port.js';
import type { EvalRunnerContract } from '../../../config/container-eval-contracts.js';
import type { WineSearchContainerServices } from '../../../config/container.js';
import type { CurationUseCase } from '../../../application/curation/curation.usecase.js';
import type { LookupOpsRuntimeHealthView } from '../../../config/lookup-authority.js';

export interface SearchRouteDeps {
  readonly searchUseCase: SearchExecutorPort;
}

/** Dependencies for the operator curation plane routes (T-ELV2-07). */
export interface CurationOpsRouteDeps {
  readonly curationUseCase: CurationUseCase;
  readonly lookupOpsRuntime?: LookupOpsRuntimeHealthView | undefined;
}

/** Dependencies for `POST /v2/entity-lookup` and ops inspect routes. */
export type EntityLookupV2RouteDeps = {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
};

export interface HttpServerDeps
  extends SearchRouteDeps, EntityLookupV2RouteDeps {
  readonly evalRunner: EvalRunnerContract | null;
  /**
   * Operator curation plane use case (T-ELV2-07). Optional so lightweight
   * server-construction tests need not stub it; when present the ops curation
   * routes are registered.
   */
  readonly curationUseCase?: CurationUseCase | undefined;
  /** Lookup runtime substrate snapshot for ops coverage-health (when wired). */
  readonly lookupOpsRuntime?: LookupOpsRuntimeHealthView | undefined;
  /** Agentic orchestrator — present when AGENT_ENABLED=true and ChatLlmPort is available. */
  /**
   * Plan-then-Execute wine-search slice — present when
   * `WINE_SEARCH_ENABLED=true` and an Anthropic credential is configured.
   * When `undefined`, the `/v1/agent` route is not registered.
   */
  readonly wineSearch?: WineSearchContainerServices | undefined;
}
