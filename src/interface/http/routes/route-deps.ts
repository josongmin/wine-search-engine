import type {
  SearchUseCaseContract,
  DecomposedSearchUseCaseContract,
  BatchSearchUseCaseContract,
  ReplayUseCaseContract,
  InterpretUseCaseContract,
  ResolveUseCaseContract,
  HybridUseCaseContract,
  AdaptiveToolExecutorContract,
} from '../../../config/container-contracts.js';
import type { EvalRunner } from '../../../domain/evaluation/service/eval-runner.js';

export interface SearchRouteDeps {
  readonly searchUseCase: SearchUseCaseContract;
  readonly decomposedSearchUseCase: DecomposedSearchUseCaseContract;
}

export interface BatchSearchRouteDeps {
  readonly batchSearchUseCase: BatchSearchUseCaseContract;
}

export interface ReplayRouteDeps {
  readonly replayUseCase: ReplayUseCaseContract;
}

export interface InterpretRouteDeps {
  readonly interpretUseCase: InterpretUseCaseContract;
}

export interface ResolveRouteDeps {
  readonly resolveUseCase: ResolveUseCaseContract;
}

export interface HybridRouteDeps {
  readonly hybridUseCase: HybridUseCaseContract;
}

export interface ClaudeToolsRouteDeps {
  readonly adaptiveToolExecutor: AdaptiveToolExecutorContract;
}

export interface HttpServerDeps
  extends SearchRouteDeps,
    BatchSearchRouteDeps,
    ReplayRouteDeps,
    InterpretRouteDeps,
    ResolveRouteDeps,
    HybridRouteDeps,
    ClaudeToolsRouteDeps {
  readonly evalRunner: EvalRunner | null;
}
