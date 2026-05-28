import type { SearchExecutorPort } from '../../../application/search/port/search-executor.port.js';
import type {
  AutocompleteUseCasePort,
  BatchSearchUseCasePort,
  DecomposedSearchUseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
  ReplayUseCasePort,
  ResolveUseCasePort,
} from '../../../application/search/port/search-route-usecases.port.js';
import type { WatchlistServicePort } from '../../../application/watchlist/watchlist.service.js';
import type { EvalRunnerContract } from '../../../config/container-eval-contracts.js';
import type { AdaptiveToolExecutorContract } from '../../../config/container-tool-contracts.js';
import type { FeedbackStore } from '../../../domain/learning/port/feedback-store.port.js';
import type { WineSearchContainerServices } from '../../../config/container.js';
import type {
  WineSearchOrchestratorContract as WineSearchOrchestrator,
} from '../../../application/wine-search/wine-search-orchestrator.js';

export interface SearchRouteDeps {
  readonly searchUseCase: SearchExecutorPort;
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
  readonly wineSearchOrchestrator?: WineSearchOrchestrator | undefined;
}

export interface BatchSearchRouteDeps {
  readonly batchSearchUseCase: BatchSearchUseCasePort;
}

export interface ReplayRouteDeps {
  readonly replayUseCase: ReplayUseCasePort;
}

export interface InterpretRouteDeps {
  readonly interpretUseCase: InterpretUseCasePort;
}

export interface ResolveRouteDeps {
  readonly resolveUseCase: ResolveUseCasePort;
}

export interface AutocompleteRouteDeps {
  readonly autocompleteUseCase: AutocompleteUseCasePort;
}

export interface HybridRouteDeps {
  readonly hybridUseCase: HybridUseCasePort;
}

export interface ClaudeToolsRouteDeps {
  readonly adaptiveToolExecutor: AdaptiveToolExecutorContract;
}

export interface WatchlistRouteDeps {
  readonly watchlistService: WatchlistServicePort;
}

export interface FeedbackRouteDeps {
  /** Null when Postgres is not configured or feedback persistence is unavailable. */
  readonly feedbackStore: FeedbackStore | null;
  /** False when `KILL_SWITCH_LEARNING` is on or no feedback store exists. */
  readonly feedbackIngestEnabled: boolean;
}

export interface HttpServerDeps
  extends SearchRouteDeps,
    BatchSearchRouteDeps,
    ReplayRouteDeps,
    InterpretRouteDeps,
    ResolveRouteDeps,
    HybridRouteDeps,
    ClaudeToolsRouteDeps,
    WatchlistRouteDeps,
    FeedbackRouteDeps {
  readonly autocompleteUseCase?: AutocompleteUseCasePort | undefined;
  readonly evalRunner: EvalRunnerContract | null;
  /** Agentic orchestrator — present when AGENT_ENABLED=true and ChatLlmPort is available. */
  /**
   * Plan-then-Execute wine-search slice — present when
   * `WINE_SEARCH_ENABLED=true` and an Anthropic credential is configured.
   * When `undefined`, the `/v1/wine-search` route is not registered.
   */
  readonly wineSearch?: WineSearchContainerServices | undefined;
}
