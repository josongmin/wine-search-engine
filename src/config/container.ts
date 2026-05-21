import type { Config } from './env.js';
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
import { AgentOrchestrator } from '../application/agent/agent-orchestrator.js';
import { getAgentExecutionMetricsCollector } from '../infrastructure/observability/agent-execution-metrics.js';
import type { EntityDocumentLookupPort } from '../application/search/port/search-pipeline-deps.port.js';
import { InMemoryCorpusCardinalityCache } from '../domain/retrieval/service/corpus-cardinality-cache.js';
import {
  buildComparisonDecompositionLegs,
  buildComparisonDecompositionLegsForRetrieval,
} from '../domain/query/service/decomposition-detector.js';
// ── Plan-then-Execute (wine-search) wiring — strangler-fig coexistence
// with the legacy AgentOrchestrator. Gated by `WINE_SEARCH_ENABLED`.
// All construction lives inside `buildWineSearchContainerServices` so the
// branch can be torn out cleanly when the legacy agent route retires.
import { isWineSearchEnabled } from './wine-search-feature-flag.js';
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
import { ClaudeStructuredLlmAdapter } from '../infrastructure/ai/claude-structured-llm-adapter.js';
import type { SearchUseCase } from '../application/search/search.usecase.js';
import type { DecomposedSearchUseCase } from '../application/search/decomposed-search.usecase.js';
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { WineSearchOrchestrator as WineSearchOrchestratorImpl } from '../application/wine-search/wine-search-orchestrator.js';
import type { WineSearchOrchestratorContract as WineSearchOrchestrator } from '../application/wine-search/wine-search-orchestrator.js';
export {
  getWiringManifest,
  topologicalBuildOrder,
  WIRING_MANIFEST,
} from './container-wiring-manifest.js';
export type {
  ContainerPortId,
  SubContainerId,
  SubContainerSpec,
  WiringManifest,
} from './container-wiring-manifest.js';

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
  /** Agentic orchestrator — present when AGENT_ENABLED=true and ChatLlmPort available. */
  readonly agentOrchestrator?: AgentOrchestrator | undefined;
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
  config: Config,
  core: Awaited<ReturnType<typeof buildCoreContainerServices>>,
  features: ReturnType<typeof buildFeatureContainerServices>,
): WineSearchContainerServices | undefined {
  if (!isWineSearchEnabled()) {
    return undefined;
  }
  if (config.anthropic.apiKey === undefined) {
    // Anthropic credential is REQUIRED for the structured-LLM path. Fail
    // loudly so the operator can't enable the flag in a half-configured
    // environment.
    throw new Error(
      'WINE_SEARCH_ENABLED=true but ANTHROPIC_API_KEY is not configured — set ANTHROPIC_API_KEY or unset WINE_SEARCH_ENABLED.',
    );
  }

  // ── 1) Structured-LLM adapter (Anthropic native tool_use). Single
  //      instance shared by analyzer (LLM fallback), mini-loop, synthesis.
  const structuredLlm = new ClaudeStructuredLlmAdapter({
    apiKey: config.anthropic.apiKey,
    httpTimeoutMs: config.openai.httpTimeoutMs,
  });

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
  const miniLoopRunner = new MiniLoopRunner({
    structuredLlm,
    logger: wineSearchLogger,
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
  const features = buildFeatureContainerServices(config, core, runtime);
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
  const wineSearch = buildWineSearchContainerServices(config, core, features);

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
    ...(config.agent.enabled && core.chatLlm !== undefined
      ? /* agent orchestrator wired */ {
          agentOrchestrator: new AgentOrchestrator(
            {
              chatLlm: core.chatLlm,
              querySanitizer: core.querySanitizer,
              executionObserver: getAgentExecutionMetricsCollector(),
              toolDeps: {
                searchUseCase: features.searchUseCase,
                decomposedSearchExecute: async (
                  subQueries,
                  comparisonIntent,
                  originalQuery,
                  requestId,
                  startTime,
                  parentContext,
                  options,
                  retrievalSubQueries,
                ) =>
                  features.decomposedSearchUseCase.execute(
                    subQueries as [string, string],
                    retrievalSubQueries !== undefined
                      ? buildComparisonDecompositionLegsForRetrieval(
                          subQueries as [string, string],
                          retrievalSubQueries as [string, string],
                        )
                      : buildComparisonDecompositionLegs(subQueries as [string, string]),
                    comparisonIntent as 'compare' | 'recommend_one' | 'list_both',
                    originalQuery,
                    requestId,
                    startTime,
                    parentContext,
                    options,
                  ),
                // Direct entity lookup by ID — bypasses the full search pipeline
                // for check_drinking_window. Uses batch getDocuments() with a
                // single-element array (T-E4-01: getDocument is deprecated).
                entityLookup: async (id) => {
                  const docs = await core.entityLookup.getDocuments([id]);
                  return docs.get(id) ?? undefined;
                },
                ...(core.entityLookup.getDrinkingWindowDocuments !== undefined
                  ? {
                      drinkingWindowEntityLookup: async (id) => {
                        const docs = await core.entityLookup.getDrinkingWindowDocuments!([id]);
                        return docs.get(id) ?? undefined;
                      },
                    }
                  : {}),
                corpusCardinality: InMemoryCorpusCardinalityCache.empty(),
              },
            },
            {
              maxSteps: config.agent.maxSteps,
              agentTimeoutMs: config.agent.agentTimeoutMs,
              perStepTimeoutMs: config.agent.perStepTimeoutMs,
              maxContextChars: 8_000,
              // L1.C: fast-answer bypass toggle (default true). Saves one
              // planner LLM RTT on simple-lookup queries by routing the
              // grounded answer through synthesis directly.
              fastAnswerBypassPlanner: config.agent.fastAnswerBypassPlanner,
            },
          ),
        }
      : {}),
    ...(wineSearch !== undefined ? { wineSearch } : {}),
  };
}
