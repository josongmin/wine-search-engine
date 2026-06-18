import type { QueryPlannerPort, RankingPort } from '../application/search/port/search-pipeline-deps.port.js';
import {
  PlannerV1Adapter,
  buildAnchorRefreshCallbackFromAliasOverlay,
} from './planner-v1-adapter.js';
import type { ChatLlmPort } from '../domain/ai/port/chat-llm.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type { Resolver } from '../domain/resolver/service/resolver.js';
import type { CandidatePoolService } from '../domain/retrieval/service/candidate-pool.js';
import type {
  BudgetLedger,
  BudgetLedgerOptions,
} from '../domain/retrieval/service/budget-ledger.js';
import type { DecisionEngine } from '../domain/decision/service/decision-engine.js';
import type { ResponseBuilder } from '../domain/response/service/response-builder.js';
import type { MixedSolver } from '../domain/mixed/service/mixed-solver.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { SnapshotVersions } from '../application/search/search.usecase.js';
import type { CacheLookupRuntimeState } from '../application/search/search-usecase-cache-lookup.js';
import type { SearchSnapshotFieldAvailability } from '../domain/shared/types/search-field-availability.js';
import type {
  BrowseRetrieverPort,
  CompareRetrieverPort,
} from '../application/search/port/search-pipeline-deps.port.js';
import type { Config } from './env.js';
import type { Pool } from 'pg';
import type { RuntimeHandles } from './runtime-handles.js';
import { buildCoreAdapterServices } from './container-adapters.js';
import {
  buildRuntimeSupportServices,
  type RuntimeSupportServices,
} from './container-runtime-support.js';
import {
  buildBudgetLedgerFactory,
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
import { warnStartupMisconfigurations } from './startup-preflight.js';
import type { AnchorRefreshCallback } from '../domain/query/service/anchor-refresh.js';

export interface CoreContainerServices {
  // T1.2: typed as QueryPlannerPort for backward compat while Planner returns QueryPlanV2.
  // T1.5 will update the port to QueryPlanV2.
  readonly queryPlanner: QueryPlannerPort;
  readonly entityLookupAnchorRefresh: AnchorRefreshCallback;
  readonly chatLlm?: ChatLlmPort;
  readonly entityResolver: Resolver;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: RankingPort;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly mixedSolver: MixedSolver;
  readonly browseRetriever: BrowseRetrieverPort;
  readonly compareRetriever: CompareRetrieverPort;
  readonly snapshotVersions: SnapshotVersions;
  readonly querySanitizer: RuntimeSupportServices['querySanitizer'];
  readonly injectionJudge?: RuntimeSupportServices['injectionJudge'];
  readonly cacheService?: RuntimeSupportServices['cacheService'];
  readonly cacheLookupRuntimeState: CacheLookupRuntimeState;
  readonly cacheLookupRuntimeStateProvider: () => CacheLookupRuntimeState;
  readonly ltrModels?: RuntimeSupportServices['ltrModels'];
  readonly runtimeReadiness: RuntimeSupportServices['runtimeReadiness'];
  readonly fieldAvailability: SearchSnapshotFieldAvailability;
  readonly drinkingWindowPredictor: DrinkingWindowPredictorPort;
  readonly calibrationStore: CalibrationStore;
  /**
   * ADR-013 Phase 1c.x: per-request budget ledger factory. Call
   * `budgetLedgerFactory({ priceTotalKrw })` once per retrieval
   * invocation; the returned ledger is request-scoped and MUST NOT be
   * cached across requests.
   */
  readonly budgetLedgerFactory: (options?: BudgetLedgerOptions) => BudgetLedger;
  /**
   * Live PG pool when DB-backed (undefined in snapshot/in-memory modes).
   * Exposed so DB-only planes (e.g. the T-ELV2-07 curation write plane) can be
   * wired only when a pool exists.
   */
  readonly pool?: Pool;
}

export async function buildCoreContainerServices(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<CoreContainerServices> {
  // RCA-03: Emit structured warnings for any missing retrieval infrastructure
  // before the HTTP server starts accepting connections, so operators can
  // diagnose degraded channels without waiting for the first failing request.
  warnStartupMisconfigurations(config);

  const support = await buildRuntimeSupportServices(config, runtime);
  const adapters = await Promise.resolve(buildCoreAdapterServices(config, runtime));

  // T1.2: Wrap the concrete Planner (returns QueryPlanV2) in the V1 adapter so
  // existing consumers continue to receive QueryPlanV1-shaped objects.
  // T1.5 will remove this adapter once all consumers migrate to QueryPlanV2.
  //
  // Wave 1 (entity-route anchor-refresh, memory `project_entity_route_broken`):
  // hand the alias overlay through `anchorRefresh` so the adapter can recover
  // anchors at execution time when the planner missed an alias the overlay
  // holds. The callback is always wired in production because the alias
  // matcher is always built (either PG-backed, snapshot-backed, or
  // search-index-backed — see container-adapters.ts).
  const entityLookupAnchorRefresh = buildAnchorRefreshCallbackFromAliasOverlay(
    adapters.aliasMatcher,
  );
  const queryPlanner: QueryPlannerPort = new PlannerV1Adapter(
    await buildQueryPlanner(
      adapters,
      runtime.pool,
      adapters.chatLlm,
      config.openai.llmQueryInterpreter,
      config.openai.llmQueryInterpreterTimeoutMs,
      support.phraseCache,
      runtime.searchSnapshotId,
    ),
    {
      anchorRefresh: entityLookupAnchorRefresh,
    },
  );
  const entityResolver = buildEntityResolver(adapters, config);
  const candidatePool = buildCandidatePool(adapters, support, config);
  const browseRetriever = buildBrowseRetriever(adapters);
  const compareRetriever = buildCompareRetriever(adapters);
  const baseRanker = buildRanker(adapters, config, support);
  const ranker = buildRankingPipeline(baseRanker);

  return {
    ...(runtime.pool !== undefined ? { pool: runtime.pool } : {}),
    queryPlanner,
    entityLookupAnchorRefresh,
    entityResolver,
    candidatePool,
    browseRetriever,
    compareRetriever,
    ...(adapters.chatLlm !== undefined ? { chatLlm: adapters.chatLlm } : {}),
    ranker,
    decisionEngine: buildDecisionEngine(adapters, config),
    responseBuilder: buildResponseBuilder(),
    mixedSolver: buildMixedSolver(adapters, ranker),
    snapshotVersions: buildSnapshotVersions(config),
    cacheLookupRuntimeState: buildCacheReadRuntimeState(config),
    cacheLookupRuntimeStateProvider: buildCacheReadRuntimeStateProvider(config, ranker),
    calibrationStore: adapters.calibrationStore,
    budgetLedgerFactory: buildBudgetLedgerFactory(),
    ...support,
  };
}
