import type { GoldSetFilter, EvalReport } from '../domain/evaluation/index.js';
import type {
  DrinkingWindowPredictorPort,
} from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { SearchResponseV1 } from '../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../domain/response/model/result-item.js';
import type { Planner } from '../domain/query/service/planner.js';
import type { Resolver } from '../domain/resolver/service/resolver.js';
import type { CandidatePoolService } from '../domain/retrieval/service/candidate-pool.js';
import type { Ranker } from '../domain/ranking/service/ranker.js';
import type { DecisionEngine } from '../domain/decision/service/decision-engine.js';
import type { ResponseBuilder } from '../domain/response/service/response-builder.js';
import type { MixedSolver } from '../domain/mixed/service/mixed-solver.js';
import type { SearchUseCase } from '../application/search/search.usecase.js';
import type { ReplayUseCase } from '../application/search/replay.usecase.js';
import type { InterpretUseCase } from '../application/search/interpret.usecase.js';
import type { ResolveUseCase } from '../application/search/resolve.usecase.js';
import type { HybridUseCase } from '../application/search/hybrid.usecase.js';
import type { DecomposedSearchUseCase } from '../application/search/decomposed-search.usecase.js';
import type { DrinkingWindowUseCase } from '../application/drinking-window/drinking-window.usecase.js';
import type { BatchSearchUseCase } from '../application/search/batch-search.usecase.js';

export type DrinkingWindowPredictorContract = DrinkingWindowPredictorPort;
export type QueryPlannerContract = Pick<Planner, 'plan'>;
export type EntityResolverContract = Pick<Resolver, 'resolve'>;
export type CandidatePoolContract = Pick<CandidatePoolService, 'generate'>;
export type RankerContract = Pick<Ranker, 'rank'>;
export type DecisionEngineContract = Pick<DecisionEngine, 'decide'>;
export type ResponseBuilderContract = Pick<ResponseBuilder, 'build'>;
export type MixedSolverContract = Pick<MixedSolver, 'solve'>;
export type SearchUseCaseContract = Pick<SearchUseCase, 'execute'>;
export type ReplayUseCaseContract = Pick<ReplayUseCase, 'execute'>;
export type InterpretUseCaseContract = Pick<InterpretUseCase, 'execute'>;
export type ResolveUseCaseContract = Pick<ResolveUseCase, 'execute'>;
export type HybridUseCaseContract = Pick<HybridUseCase, 'execute'>;
export type DecomposedSearchUseCaseContract = Pick<DecomposedSearchUseCase, 'execute'>;
export type DrinkingWindowUseCaseContract = Pick<DrinkingWindowUseCase, 'check'>;
export type BatchSearchUseCaseContract = Pick<BatchSearchUseCase, 'execute'>;

export type WineToolExecutionResult =
  | SearchResponseV1
  | ComparisonSearchResponse
  | DrinkingWindowBlock
  | { error: string };

export interface WineToolExecutorContract {
  execute(
    toolName: string,
    input: unknown,
    requestId: string,
  ): Promise<WineToolExecutionResult>;
}

export interface AdaptiveToolExecutionResult<T = WineToolExecutionResult> {
  readonly result: T;
  readonly fallbackApplied?: 'mixed' | undefined;
}

export interface AdaptiveToolExecutorContract {
  executeWithFallback(
    toolName: string,
    input: unknown,
    requestId: string,
  ): Promise<AdaptiveToolExecutionResult>;
}

export interface EvalRunnerContract {
  run(filter?: GoldSetFilter): Promise<EvalReport>;
}
