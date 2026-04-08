import type { QueryPlannerPort, RankingPort } from '../application/search/port/search-pipeline-deps.port.js';
import { PlannerV1Adapter } from './planner-v1-adapter.js';
import type { ChatLlmPort } from '../domain/ai/port/chat-llm.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type { Resolver } from '../domain/resolver/service/resolver.js';
import type { CandidatePoolService } from '../domain/retrieval/service/candidate-pool.js';
import type { DecisionEngine } from '../domain/decision/service/decision-engine.js';
import type { ResponseBuilder } from '../domain/response/service/response-builder.js';
import type { MixedSolver } from '../domain/mixed/service/mixed-solver.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';
import type { CacheLookupRuntimeState } from '../application/search/search-usecase-cache-lookup.js';
import type {
  BrowseRetrieverPort,
  CompareRetrieverPort,
  EntityDocumentLookupPort,
} from '../application/search/port/search-pipeline-deps.port.js';
import type { Config } from './env.js';
import type { RuntimeHandles } from './runtime-handles.js';
import { buildCoreAdapterServices } from './container-adapters.js';
import {
  buildRuntimeSupportServices,
  type RuntimeSupportServices,
} from './container-runtime-support.js';
import {
  buildCandidatePool,
  buildBrowseRetriever,
  buildCompareRetriever,
  buildEntityResolver,
  buildQueryPlanner,
  buildRanker,
  buildRankingPipeline,
  buildSnapshotVersions,
  buildDecisionEngine,
  buildMixedSolver,
  buildResponseBuilder,
} from './container-core-builders.js';
import {
  buildCacheReadRuntimeState,
  buildCacheReadRuntimeStateProvider,
} from './kill-switch-policy.js';

export interface CoreContainerServices {
  // T1.2: typed as QueryPlannerPort for backward compat while Planner returns QueryPlanV2.
  // T1.5 will update the port to QueryPlanV2.
  readonly queryPlanner: QueryPlannerPort;
  readonly chatLlm?: ChatLlmPort;
  readonly entityResolver: Resolver;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: RankingPort;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly mixedSolver: MixedSolver;
  readonly browseRetriever: BrowseRetrieverPort;
  readonly compareRetriever: CompareRetrieverPort;
  readonly entityLookup: EntityDocumentLookupPort;
  readonly snapshotVersions: SnapshotVersions;
  readonly querySanitizer: RuntimeSupportServices['querySanitizer'];
  readonly injectionJudge?: RuntimeSupportServices['injectionJudge'];
  readonly cacheService?: RuntimeSupportServices['cacheService'];
  readonly cacheLookupRuntimeState: CacheLookupRuntimeState;
  readonly cacheLookupRuntimeStateProvider: () => CacheLookupRuntimeState;
  readonly ltrModels?: RuntimeSupportServices['ltrModels'];
  readonly drinkingWindowPredictor: DrinkingWindowPredictorPort;
  readonly calibrationStore: CalibrationStore;
}

export async function buildCoreContainerServices(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<CoreContainerServices> {
  const support = await buildRuntimeSupportServices(config, runtime);
  const adapters = buildCoreAdapterServices(config, runtime.pool);

  // T1.2: Wrap the concrete Planner (returns QueryPlanV2) in the V1 adapter so
  // existing consumers continue to receive QueryPlanV1-shaped objects.
  // T1.5 will remove this adapter once all consumers migrate to QueryPlanV2.
  const queryPlanner: QueryPlannerPort = new PlannerV1Adapter(
    await buildQueryPlanner(
      adapters,
      runtime.pool,
      adapters.chatLlm,
      config.openai.llmQueryInterpreter,
      config.openai.llmQueryInterpreterTimeoutMs,
      support.phraseCache,
    ),
  );
  const entityResolver = buildEntityResolver(adapters, config);
  const candidatePool = buildCandidatePool(adapters, support, config);
  const browseRetriever = buildBrowseRetriever(adapters);
  const compareRetriever = buildCompareRetriever(adapters);
  const baseRanker = buildRanker(adapters, config, support);
  const ranker = buildRankingPipeline(baseRanker);

  return {
    queryPlanner,
    entityResolver,
    candidatePool,
    browseRetriever,
    compareRetriever,
    entityLookup: adapters.searchIndex,
    ranker,
    decisionEngine: buildDecisionEngine(adapters, config),
    responseBuilder: buildResponseBuilder(),
    mixedSolver: buildMixedSolver(adapters, ranker),
    snapshotVersions: buildSnapshotVersions(config),
    cacheLookupRuntimeState: buildCacheReadRuntimeState(config),
    cacheLookupRuntimeStateProvider: buildCacheReadRuntimeStateProvider(config, ranker),
    calibrationStore: adapters.calibrationStore,
    ...support,
  };
}
