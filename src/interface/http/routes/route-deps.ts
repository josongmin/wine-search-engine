import type { SearchExecutorPort } from '../../../application/search/port/search-executor.port.js';
import type {
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

export interface SearchRouteDeps {
  readonly searchUseCase: SearchExecutorPort;
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
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

export interface HybridRouteDeps {
  readonly hybridUseCase: HybridUseCasePort;
}

export interface ClaudeToolsRouteDeps {
  readonly adaptiveToolExecutor: AdaptiveToolExecutorContract;
}

export interface WatchlistRouteDeps {
  readonly watchlistService: WatchlistServicePort;
}

export interface HttpServerDeps
  extends SearchRouteDeps,
    BatchSearchRouteDeps,
    ReplayRouteDeps,
    InterpretRouteDeps,
    ResolveRouteDeps,
    HybridRouteDeps,
    ClaudeToolsRouteDeps,
    WatchlistRouteDeps {
  readonly evalRunner: EvalRunnerContract | null;
}
