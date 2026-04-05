import type {
  DrinkingWindowPredictorPort,
} from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { DrinkingWindowUseCasePort } from '../application/drinking-window/port/drinking-window-usecase.port.js';
import type {
  CandidatePoolPort,
  DecisionEnginePort,
  EntityResolverPort,
  MixedSolverPort,
  QueryPlannerPort,
  RankingPort,
  ResponseBuilderPort,
} from '../application/search/port/search-pipeline-deps.port.js';
import type { SearchResponseCachePort } from '../domain/performance/port/search-response-cache.port.js';

export type DrinkingWindowPredictorContract = DrinkingWindowPredictorPort;
export type QueryPlannerContract = QueryPlannerPort;
export type EntityResolverContract = EntityResolverPort;
export type CandidatePoolContract = CandidatePoolPort;
export type RankerContract = RankingPort;
export type DecisionEngineContract = DecisionEnginePort;
export type ResponseBuilderContract = ResponseBuilderPort;
export type MixedSolverContract = MixedSolverPort;
export type SearchResponseCacheContract = SearchResponseCachePort;
export type DrinkingWindowUseCaseContract = DrinkingWindowUseCasePort;

export type * from './container-search-contracts.js';
export type {
  WatchlistRuntimeContract,
  WatchlistServiceContract,
} from './container-watchlist-contracts.js';
export type * from './container-eval-contracts.js';
export type * from './container-tool-contracts.js';
