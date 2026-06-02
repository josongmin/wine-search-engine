import type { SearchExecutorPort } from '../../../application/search/port/search-executor.port.js';
import type {
  EntityLookupV2UseCasePort,
  LookupWineV2CompatibilityUseCasePort,
  ResolveUseCasePort,
} from '../../../application/search/port/search-route-usecases.port.js';
import type { EvalRunnerContract } from '../../../config/container-eval-contracts.js';
import type { WineSearchContainerServices } from '../../../config/container.js';
import type { CurationUseCase } from '../../../application/curation/curation.usecase.js';

export interface SearchRouteDeps {
  readonly searchUseCase: SearchExecutorPort;
  readonly lookupWineV2CompatibilityUseCase?: LookupWineV2CompatibilityUseCasePort | undefined;
}

/** Dependencies for the operator curation plane routes (T-ELV2-07). */
export interface CurationOpsRouteDeps {
  readonly curationUseCase: CurationUseCase;
}

export interface ResolveRouteDeps {
  readonly resolveUseCase: ResolveUseCasePort;
}

/** Dependencies for the dedicated `/v2/entity-lookup` route (T-ELV2-01). */
export interface EntityLookupV2RouteDeps {
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
}

export interface HttpServerDeps
  extends SearchRouteDeps {
  readonly evalRunner: EvalRunnerContract | null;
  /**
   * Dedicated V2 entity-lookup use case. Always constructed by the container
   * (no optional dependency), so the route is always registered in production;
   * kept optional here so lightweight server-construction tests need not stub it.
   */
  readonly entityLookupV2UseCase?: EntityLookupV2UseCasePort | undefined;
  readonly lookupWineV2CompatibilityUseCase?: LookupWineV2CompatibilityUseCasePort | undefined;
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
