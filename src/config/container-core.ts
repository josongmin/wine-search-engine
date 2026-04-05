import type { Planner } from '../domain/query/service/planner.js';
import type { Resolver } from '../domain/resolver/service/resolver.js';
import { CandidatePoolService } from '../domain/retrieval/service/candidate-pool.js';
import { Ranker } from '../domain/ranking/service/ranker.js';
import { DecisionEngine } from '../domain/decision/service/decision-engine.js';
import { ResponseBuilder } from '../domain/response/service/response-builder.js';
import { MixedSolver } from '../domain/mixed/service/mixed-solver.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';
import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { buildCoreAdapterServices } from './container-adapters.js';
import {
  buildRuntimeSupportServices,
  type RuntimeSupportServices,
} from './container-runtime-support.js';
import {
  buildCandidatePool,
  buildEntityResolver,
  buildQueryPlanner,
  buildRanker,
  buildSnapshotVersions,
  buildDecisionEngine,
  buildMixedSolver,
  buildResponseBuilder,
} from './container-core-builders.js';

export interface CoreContainerServices {
  readonly queryPlanner: Planner;
  readonly entityResolver: Resolver;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: Ranker;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly mixedSolver: MixedSolver;
  readonly snapshotVersions: SnapshotVersions;
  readonly querySanitizer: RuntimeSupportServices['querySanitizer'];
  readonly injectionJudge?: RuntimeSupportServices['injectionJudge'];
  readonly cacheService?: RuntimeSupportServices['cacheService'];
  readonly ltrModels?: RuntimeSupportServices['ltrModels'];
  readonly drinkingWindowPredictor: DrinkingWindowPredictorPort;
}

export async function buildCoreContainerServices(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<CoreContainerServices> {
  const support = await buildRuntimeSupportServices(config, runtime);
  const adapters = buildCoreAdapterServices(config, runtime.pool);

  const queryPlanner = buildQueryPlanner(adapters);
  const entityResolver = buildEntityResolver(adapters);
  const candidatePool = buildCandidatePool(adapters, support, config);
  const ranker = buildRanker(adapters, config);

  return {
    queryPlanner,
    entityResolver,
    candidatePool,
    ranker,
    decisionEngine: buildDecisionEngine(adapters, config),
    responseBuilder: buildResponseBuilder(),
    mixedSolver: buildMixedSolver(adapters, ranker),
    snapshotVersions: buildSnapshotVersions(config),
    ...support,
  };
}
