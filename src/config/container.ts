import type { Pool } from 'pg';
import type { Config } from './env.js';
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
import type { DrinkingWindowPredictor } from '../infrastructure/ml/drinking-window-predictor.js';
import type { WineToolExecutor } from '../interface/claude-tools/tool-executor.js';
import type { AdaptiveToolExecutor } from '../interface/claude-tools/adaptive-tool-executor.js';
import type { RedisWatchlistPublisher } from '../infrastructure/watchlist/redis-watchlist-publisher.js';
import type { RedisWatchlistSubscriber } from '../infrastructure/watchlist/redis-watchlist-subscriber.js';
import type { WebhookDelivery } from '../infrastructure/watchlist/webhook-delivery.js';
import type { EvalRunner } from '../domain/evaluation/service/eval-runner.js';
import {
  buildCoreContainerServices,
  buildFeatureContainerServices,
  type CoreContainerServices,
  type FeatureContainerServices,
} from './container-modules.js';

export interface Container
  extends Pick<
      CoreContainerServices,
      | 'queryPlanner'
      | 'entityResolver'
      | 'candidatePool'
      | 'ranker'
      | 'decisionEngine'
      | 'responseBuilder'
      | 'mixedSolver'
      | 'drinkingWindowPredictor'
    >,
    FeatureContainerServices {
  readonly queryPlanner: Planner;
  readonly entityResolver: Resolver;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: Ranker;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly mixedSolver: MixedSolver;
  readonly searchUseCase: SearchUseCase;
  readonly replayUseCase: ReplayUseCase;
  readonly interpretUseCase: InterpretUseCase;
  readonly resolveUseCase: ResolveUseCase;
  readonly hybridUseCase: HybridUseCase;
  readonly decomposedSearchUseCase: DecomposedSearchUseCase;
  readonly drinkingWindowUseCase: DrinkingWindowUseCase;
  readonly batchSearchUseCase: BatchSearchUseCase;
  readonly drinkingWindowPredictor: DrinkingWindowPredictor;
  readonly wineToolExecutor: WineToolExecutor;
  readonly adaptiveToolExecutor: AdaptiveToolExecutor;
  readonly watchlistPublisher: RedisWatchlistPublisher;
  readonly watchlistSubscriber: RedisWatchlistSubscriber;
  readonly webhookDelivery: WebhookDelivery;
  readonly evalRunner: EvalRunner | null;
}

export async function createContainer(config: Config, pool?: Pool): Promise<Container> {
  const core = await buildCoreContainerServices(config, pool);
  const features = await buildFeatureContainerServices(config, core, pool);

  return {
    queryPlanner: core.queryPlanner,
    entityResolver: core.entityResolver,
    candidatePool: core.candidatePool,
    ranker: core.ranker,
    decisionEngine: core.decisionEngine,
    responseBuilder: core.responseBuilder,
    mixedSolver: core.mixedSolver,
    drinkingWindowPredictor: core.drinkingWindowPredictor,
    ...features,
  };
}
