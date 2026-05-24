import type { Config } from './env.js';
// Multi-query flag SSoT lives in wine-search-feature-flags so the same
// constant gates BOTH container generator construction AND the runtime
// fan-out check in `search-usecase-hybrid-candidates.ts` (CLAUDE.md rule 30).
import { MULTI_QUERY_FEATURE_FLAG_ENABLED } from './wine-search-feature-flags.js';
import { buildCoreContainerServices } from './container-core.js';
import { buildFeatureContainerServices } from './container-features.js';
import { buildWatchlistContainerServices } from './container-watchlist.js';
import { buildLearningContainerServices } from './container-learning.js';
import type { LearningContainerServices } from './container-learning.js';
import type { RuntimeHandles } from './runtime-handles.js';
import type { RuntimeReadinessSnapshot } from './container-runtime-support.js';
import type { DrinkingWindowUseCasePort } from '../application/drinking-window/port/drinking-window-usecase.port.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';
import type {
  AutocompleteUseCasePort,
  BatchSearchUseCasePort,
  DecomposedSearchUseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
  ReplayUseCasePort,
  ResolveUseCasePort,
} from '../application/search/port/search-route-usecases.port.js';
import type { WatchlistServicePort } from '../application/watchlist/watchlist.service.js';
import type { WatchlistRuntimePort } from '../infrastructure/watchlist/watchlist-delivery-runtime.js';
import type {
  CandidatePoolPort,
  DecisionEnginePort,
  EntityResolverPort,
  MixedSolverPort,
  QueryPlannerPort,
  RankingPort,
  ResponseBuilderPort,
} from '../application/search/port/search-pipeline-deps.port.js';
import type { EvalRunnerContract } from './container-eval-contracts.js';
import type { AdaptiveToolExecutorContract } from './container-tool-contracts.js';
import type { ChatLlmPort } from '../domain/ai/port/chat-llm.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type { EntityDocumentLookupPort } from '../application/search/port/search-pipeline-deps.port.js';
// ── Plan-then-Execute (wine-search) wiring — canonical agentic entry point
// after the 3.0.0 cutover. Construction lives inside
// `buildWineSearchContainerServices`.
import { QueryAnalyzerService } from '../application/wine-search/query-analyzer.js';
import { DeterministicRouter } from '../application/wine-search/deterministic-router.js';
import { ExecutionRunner } from '../application/wine-search/execution-runner.js';
import { MiniLoopRunner } from '../application/wine-search/mini-loop.js';
import { buildMiniLoopToolBundle } from '../application/wine-search/mini-loop-tool-bundle.js';
import { SynthesisRunner } from '../application/wine-search/synthesis-runner.js';
import { SearchUseCaseAdapter } from '../application/wine-search/adapters/search-use-case-adapter.js';
import { ComparisonUseCaseAdapter } from '../application/wine-search/adapters/comparison-use-case-adapter.js';
import { FoodPairingUseCaseAdapter } from '../application/wine-search/adapters/food-pairing-use-case-adapter.js';
import { DrinkabilityUseCaseAdapter } from '../application/wine-search/adapters/drinkability-use-case-adapter.js';
import { FoodPairingUseCase } from '../application/food-pairing/food-pairing.usecase.js';
import {
  buildSharedStructuredLlm,
  resolveMultiQueryRewriteModel,
  type SharedStructuredLlmServices,
} from './container-structured-llm.js';
import { createMultiQueryGenerator } from '../domain/retrieval/service/multi-query-generator.js';
import { createHydeGenerator } from '../domain/retrieval/service/hyde-generator.js';
import type { UseCaseExtensions } from './container-usecases.js';
import { RedisToolResultCache } from '../infrastructure/cache/redis-tool-result-cache.js';
import type { ToolResultCachePort } from '../application/wine-search/port/tool-result-cache.port.js';
import type { SearchUseCase } from '../application/search/search.usecase.js';
import type { DecomposedSearchUseCase } from '../application/search/decomposed-search.usecase.js';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { WineSearchOrchestrator as WineSearchOrchestratorImpl } from '../application/wine-search/wine-search-orchestrator.js';
import type { WineSearchOrchestratorContract as WineSearchOrchestrator } from '../application/wine-search/wine-search-orchestrator.js';
export interface Container extends LearningContainerServices {
  /** OpenAI-compatible chat when an OpenAI credential or credential pool is set. */
  readonly chatLlm?: ChatLlmPort;
  readonly queryPlanner: QueryPlannerPort;
  readonly entityResolver: EntityResolverPort;
  readonly candidatePool: CandidatePoolPort;
  readonly ranker: RankingPort;
  readonly decisionEngine: DecisionEnginePort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly mixedSolver: MixedSolverPort;
  readonly entityLookup: EntityDocumentLookupPort;
  readonly searchUseCase: SearchExecutorPort;
  readonly replayUseCase: ReplayUseCasePort;
  readonly interpretUseCase: InterpretUseCasePort;
  readonly resolveUseCase: ResolveUseCasePort;
  readonly autocompleteUseCase: AutocompleteUseCasePort;
  readonly hybridUseCase: HybridUseCasePort;
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
  readonly drinkingWindowUseCase: DrinkingWindowUseCasePort;
  readonly drinkingWindowPredictor: DrinkingWindowPredictorPort;
  readonly batchSearchUseCase: BatchSearchUseCasePort;
  readonly adaptiveToolExecutor: AdaptiveToolExecutorContract;
  readonly watchlistService: WatchlistServicePort;
  readonly watchlistRuntime: WatchlistRuntimePort | null;
  readonly evalRunner: EvalRunnerContract | null;
  /** True when Postgres feedback store is wired and learning kill-switch is off. */
  readonly feedbackIngestEnabled: boolean;
  readonly calibrationStore: CalibrationStore;
  readonly runtimeReadiness: RuntimeReadinessSnapshot;
  /**
   * Plan-then-Execute wine-search orchestrator — present when
   * `WINE_SEARCH_ENABLED=true` and an Anthropic API key is configured.
   * When undefined, the `/v1/wine-search` route is NOT registered (legacy
   * `/v1/agent/*` remains the active surface).
   */
  readonly wineSearch?: WineSearchContainerServices | undefined;
}

/**
 * Container slice for the Plan-then-Execute wine-search stack. Kept as a
 * nested object so the entire feature can be enabled/disabled atomically and
 * tests can assert presence with a single null-check.
 */
export interface WineSearchContainerServices {
  readonly wineSearchOrchestrator: WineSearchOrchestrator;
}

/**
 * Build the Plan-then-Execute wine-search container slice when the
 * `WINE_SEARCH_ENABLED` flag is on AND an Anthropic API key is configured.
 *
 * The flag is checked at container construction (composition root) — NOT
 * per request — so flipping it at runtime requires a process restart. This
 * matches `AGENT_ENABLED` semantics and keeps request handling branch-free.
 *
 * Returns `undefined` when the flag is off OR no Anthropic credential is
 * available. The HTTP server skips route registration in that case
 * (zero-cost when disabled).
 *
 * SOTA+++++ design:
 *  - Components are constructed inside this single self-contained function so
 *    the entire feature can be torn out cleanly when the legacy agent retires.
 *  - `StructuredLlmAdapter` registers its own circuit breaker via the
 *    `globalCircuitBreakerRegistry` — same observability surface as the
 *    legacy `chatLlm` adapter.
 *  - HTTP timeout reuses `config.openai.httpTimeoutMs` (the canonical LLM
 *    HTTP read timeout). A dedicated `ANTHROPIC_HTTP_TIMEOUT_MS` can be
 *    added later if Anthropic-specific tuning is required.
 *  - The orchestrator class implements the same `WineSearchOrchestrator`
 *    structural contract the HTTP route depends on (Track A/B/C result-shape
 *    unification — see `wine-search-result-schemas.ts`). The container
 *    therefore performs ZERO shape translation; the route handler owns the
 *    single camelCase → snake_case re-case at the HTTP boundary.
 */
function buildWineSearchContainerServices(
  _config: Config,
  core: Awaited<ReturnType<typeof buildCoreContainerServices>>,
  features: ReturnType<typeof buildFeatureContainerServices>,
  sharedStructuredLlm: SharedStructuredLlmServices | null,
): WineSearchContainerServices | undefined {
  // Reuse the shared StructuredLlmPort built at the composition root.
  // Returns `undefined` when no credential was available (same gating
  // semantics as the prior in-function adapter construction).
  if (sharedStructuredLlm === null) {
    return undefined;
  }
  const { structuredLlm } = sharedStructuredLlm;

  // ── 2) Use-case adapters. These translate runner-port input shapes into
  //      the existing application-layer request/response shapes. Runtime
  //      instances are guaranteed concrete by `buildUseCaseContainerServices`
  //      (see container-usecases.ts), so the structural cast at the seam is
  //      safe and audit-traceable.
  const searchUseCaseConcrete = features.searchUseCase as unknown as SearchUseCase;
  const decomposedSearchConcrete =
    features.decomposedSearchUseCase as unknown as DecomposedSearchUseCase;
  const searchAdapter = new SearchUseCaseAdapter(searchUseCaseConcrete);
  const comparisonAdapter = new ComparisonUseCaseAdapter(decomposedSearchConcrete);

  // FoodPairingUseCase is constructed here (not in container-usecases.ts)
  // because it is currently consumed only by the wine-search lane. Once the
  // legacy agent-tools branch adopts it directly, move construction up to
  // `buildUseCaseContainerServices` so both lanes share one instance.
  const foodPairingUseCase = new FoodPairingUseCase({
    searchUseCase: features.searchUseCase,
  });
  const foodPairingAdapter = new FoodPairingUseCaseAdapter(foodPairingUseCase);

  // Drinkability lookup uses the full retrieval document (the drinkability
  // adapter requires the broader `RetrievalDocument` shape — see
  // `DrinkabilityEntityLookupPort` in
  // `application/wine-search/adapters/drinkability-use-case-adapter.ts`).
  // The drinking-window projection is a narrower shape and intentionally
  // NOT used here.
  const drinkabilityAdapter = new DrinkabilityUseCaseAdapter({
    drinkingWindowUseCase: features.drinkingWindowUseCase,
    entityLookup: async (id) => {
      const docs = await core.entityLookup.getDocuments([id]);
      return docs.get(id) ?? undefined;
    },
  });

  // ── 3) Component construction. Logger derives one child per component so
  //      structured logs are filterable by component name.
  const wineSearchLogger = bootstrapLogger.child({ component: 'WineSearch' });
  // Track A's `QueryAnalyzerService` consumes a `{ warn, info }` shape;
  // mini-loop and synthesis require an additional `error` method. Pino
  // satisfies both — we pass the same logger instance.
  const queryAnalyzer = new QueryAnalyzerService({
    structuredLlm,
    logger: wineSearchLogger,
  });
  const router = new DeterministicRouter({ now: () => new Date() });
  const executionRunner = new ExecutionRunner({
    searchUseCase: searchAdapter,
    comparisonUseCase: comparisonAdapter,
    foodPairingUseCase: foodPairingAdapter,
    drinkabilityUseCase: drinkabilityAdapter,
  });
  // ── Tool-result cache. Wired ONLY when the env flag is on (default ON);
  //    runner-side enforcement also reads `WINE_SEARCH_TOOL_CACHE_ENABLED`,
  //    but injecting `undefined` here is the cheaper short-circuit (skips
  //    the runner's per-call shouldConsultCache check). The adapter is
  //    fail-open by contract — if Redis is unavailable at runtime, every
  //    get returns null and every set is a no-op (see
  //    RedisToolResultCache).
  const toolResultCache: ToolResultCachePort | undefined =
    process.env['WINE_SEARCH_TOOL_CACHE_ENABLED'] === '0'
      ? undefined
      : new RedisToolResultCache();
  const miniLoopRunner = new MiniLoopRunner({
    structuredLlm,
    logger: wineSearchLogger,
    ...(toolResultCache !== undefined ? { toolResultCache } : {}),
  });
  const synthesisRunner = new SynthesisRunner({
    structuredLlm,
    logger: wineSearchLogger,
  });

  // ── 4) Outer orchestrator. The concrete `WineSearchOrchestrator` class
  //      structurally implements the route-facing `WineSearchOrchestrator`
  //      contract (same `execute(input): Promise<WineSearchResult>` signature
  //      and the unified result shape from
  //      `@app/wine-search/wine-search-result-schemas.js`). No translation
  //      happens here — the HTTP route owns the single camelCase →
  //      snake_case re-case at the wire boundary.
  // ── 4a) MiniLoop tool bundle. Without this slot the orchestrator falls
  //       through to Synthesizer Layer 4 (graceful degradation) on
  //       multi-step plans — i.e. the new architecture would silently NOT
  //       drive `MiniLoopRunner` for the ~10–20% of queries that need
  //       multi-hop ReAct. The bundle reuses the SAME adapter instances
  //       already wired into `ExecutionRunner` so the deterministic and
  //       LLM-driven lanes share state, caches, and circuit breakers
  //       (CLAUDE.md rule 30 — SSoT for tool ports).
  const miniLoopToolBundle = buildMiniLoopToolBundle({
    searchUseCase: searchAdapter,
    comparisonUseCase: comparisonAdapter,
    foodPairingUseCase: foodPairingAdapter,
    drinkabilityUseCase: drinkabilityAdapter,
  });

  const wineSearchOrchestrator: WineSearchOrchestrator =
    new WineSearchOrchestratorImpl({
      queryAnalyzer,
      router,
      executionRunner,
      miniLoopRunner,
      synthesisRunner,
      miniLoopToolBundle,
      logger: bootstrapLogger,
    });

  return { wineSearchOrchestrator };
}

export async function createContainer(
  config: Config,
  runtime: RuntimeHandles = {},
): Promise<Container> {
  const core = await buildCoreContainerServices(config, runtime);

  // Construct the shared StructuredLlmPort BEFORE feature services so
  // the multi-query / HyDE generators (consumed by `SearchUseCase`) can
  // share the same adapter instance with the wine-search orchestrator.
  // Returns `null` when no credential is configured — both consumers
  // degrade gracefully (skip features that need an LLM).
  const sharedStructuredLlm = buildSharedStructuredLlm(config);

  const useCaseExtensions: UseCaseExtensions = (() => {
    if (sharedStructuredLlm === null) return {};
    if (!MULTI_QUERY_FEATURE_FLAG_ENABLED) return {};
    const rewriteModel = resolveMultiQueryRewriteModel();
    return {
      multiQueryGenerator: createMultiQueryGenerator({
        structuredLlm: sharedStructuredLlm.structuredLlm,
        model: rewriteModel,
      }),
      hydeGenerator: createHydeGenerator({
        structuredLlm: sharedStructuredLlm.structuredLlm,
        model: rewriteModel,
      }),
    };
  })();

  const features = buildFeatureContainerServices(config, core, runtime, useCaseExtensions);
  const watchlist = buildWatchlistContainerServices(config, runtime);
  const learning = buildLearningContainerServices(runtime);
  // Defense-in-depth: env validation already throws when AGENT_ENABLED=true
  // and no OpenAI credential is set (see config/env.ts). If we somehow reach here
  // without a chatLlm, fail loudly rather than silently 404 the agent route.
  if (config.agent.enabled && core.chatLlm === undefined) {
    throw new Error(
      'AGENT_ENABLED=true but no ChatLlm was constructed — check OPENAI_API_KEY/OPENAI_API_KEYS and chatLlm wiring',
    );
  }

  const feedbackIngestEnabled =
    !config.killSwitch.learning && learning.feedbackStore !== null;

  // Plan-then-Execute wine-search slice. Returns `undefined` when the
  // `WINE_SEARCH_ENABLED` flag is off — the `/v1/wine-search` route is
  // simply not registered in that case (zero runtime cost).
  const wineSearch = buildWineSearchContainerServices(
    config,
    core,
    features,
    sharedStructuredLlm,
  );

  return {
    ...learning,
    feedbackIngestEnabled,
    ...(core.chatLlm !== undefined ? { chatLlm: core.chatLlm } : {}),
    queryPlanner: core.queryPlanner,
    entityResolver: core.entityResolver,
    entityLookup: core.entityLookup,
    candidatePool: core.candidatePool,
    ranker: core.ranker,
    decisionEngine: core.decisionEngine,
    responseBuilder: core.responseBuilder,
    mixedSolver: core.mixedSolver,
    ...features,
    drinkingWindowPredictor: core.drinkingWindowPredictor,
    calibrationStore: core.calibrationStore,
    runtimeReadiness: core.runtimeReadiness,
    ...watchlist,
    ...(wineSearch !== undefined ? { wineSearch } : {}),
  };
}
