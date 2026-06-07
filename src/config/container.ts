import type { Pool } from 'pg';
import type { Config } from './env.js';
// Multi-query flag SSoT lives in wine-search-feature-flags so the same
// constant gates BOTH container generator construction AND the runtime
// fan-out check in `search-usecase-hybrid-candidates.ts` (CLAUDE.md rule 30).
import {
  MULTI_QUERY_FEATURE_FLAG_ENABLED,
} from './wine-search-feature-flags.js';
import { buildCoreContainerServices } from './container-core.js';
import { buildFeatureContainerServices } from './container-features.js';
import type { RuntimeHandles } from './runtime-handles.js';
import type { RuntimeReadinessSnapshot } from './container-runtime-support.js';
import type { DrinkingWindowUseCasePort } from '../application/drinking-window/port/drinking-window-usecase.port.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';
import type { CurationUseCase } from '../application/curation/curation.usecase.js';
import type {
  AutocompleteUseCasePort,
  BatchSearchUseCasePort,
  DecomposedSearchUseCasePort,
  EntityLookupV2UseCasePort,
  HybridUseCasePort,
  InterpretUseCasePort,
  ResolveUseCasePort,
} from '../application/search/port/search-route-usecases.port.js';
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
import type { ChatLlmPort } from '../domain/ai/port/chat-llm.port.js';
import type { CalibrationStore } from '../domain/resolver/port/calibration-store.port.js';
import type { EntityDocumentLookupPort } from '../application/search/port/search-pipeline-deps.port.js';
// ── Plan-then-Execute (wine-search) wiring — canonical agentic entry point
// after the 3.0.0 cutover. Construction lives inside
// `buildWineSearchContainerServices`.
import { QueryAnalyzerService } from '../application/wine-search/query-analyzer.js';
import { DeterministicRouter } from '../application/wine-search/deterministic-router.js';
import { ExecutionRunner } from '../application/wine-search/execution-runner.js';
import { WineAgentLoopRunner } from '../application/wine-search/wine-agent-loop.js';
import { buildWineAgentLoopToolBundle } from '../application/wine-search/wine-agent-loop-tool-bundle.js';
import { SynthesisRunner } from '../application/wine-search/synthesis-runner.js';
import { SearchUseCaseAdapter } from '../application/wine-search/adapters/search-use-case-adapter.js';
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
import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { WineSearchOrchestrator as WineSearchOrchestratorImpl } from '../application/wine-search/wine-search-orchestrator.js';
import type { WineSearchOrchestratorContract as WineSearchOrchestrator } from '../application/wine-search/wine-search-orchestrator.js';
import type { AgentSessionStorePort } from '../application/wine-search/port/agent-session-store.port.js';
import { computeAgentSessionExpiry } from './agent-session-store.js';
import { createSqliteAgentSessionStore } from '../infrastructure/db/agent-session-store.js';
import { AgentSessionService } from '../application/wine-search/agent-session-service.js';
import { AgentUseCase } from '../application/wine-search/agent-usecase.js';
import type { AgentUseCasePort } from '../application/wine-search/port/agent-usecase.port.js';
import { bindLiveSearchSnapshotRuntimeHandles } from './runtime-handles.js';
import { createLookupAuthorityServices } from './lookup-authority.js';
export interface Container {
  /** Chat LLM when an OpenAI credential pool or Codex ChatGPT login token is available. */
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
  readonly interpretUseCase: InterpretUseCasePort;
  readonly resolveUseCase: ResolveUseCasePort;
  readonly entityLookupV2UseCase: EntityLookupV2UseCasePort;
  /** Operator curation plane (T-ELV2-07); present only when a PG pool is wired. */
  readonly curationUseCase?: CurationUseCase | undefined;
  readonly autocompleteUseCase: AutocompleteUseCasePort;
  readonly hybridUseCase: HybridUseCasePort;
  readonly decomposedSearchUseCase: DecomposedSearchUseCasePort;
  readonly drinkingWindowUseCase: DrinkingWindowUseCasePort;
  readonly drinkingWindowPredictor: DrinkingWindowPredictorPort;
  readonly batchSearchUseCase: BatchSearchUseCasePort;
  readonly evalRunner: EvalRunnerContract | null;
  readonly calibrationStore: CalibrationStore;
  readonly runtimeReadiness: RuntimeReadinessSnapshot;
  /**
   * Plan-then-Execute wine-search orchestrator — present when
   * `WINE_SEARCH_ENABLED=true` and an Anthropic API key is configured.
   * When undefined, the `/v1/agent` route is not registered.
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
  /** Persistent session store (SQLite). Absent when no durable backend is
   *  configured — multi-turn then fails closed rather than falling back to a
   *  process-local store (T-MTA-03). */
  readonly agentSessionStore?: AgentSessionStorePort | undefined;
  /** Owner of server-managed session history custody (T-MTA-02). The HTTP
   *  session routes delegate to this rather than assembling store +
   *  orchestrator themselves. Absent (→ 503) when no persistent store is
   *  wired. */
  readonly agentSessionService?: AgentSessionService | undefined;
  /** Single application seam both HTTP routes and the local CLI facade call
   *  for the agent surface (run + sessions). Always present; session methods
   *  fail closed (503) internally when no store is wired. */
  readonly agentUseCase: AgentUseCasePort;
}

function normalizeRuntimeHandles(
  runtime: Pool | RuntimeHandles | undefined,
): RuntimeHandles {
  if (runtime === undefined) {
    return {};
  }
  if ('totalCount' in runtime) {
    return { pool: runtime };
  }
  return runtime;
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
  _core: Awaited<ReturnType<typeof buildCoreContainerServices>>,
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
  const searchAdapter = new SearchUseCaseAdapter(searchUseCaseConcrete);

  // ── 3) Component construction. Logger derives one child per component so
  //      structured logs are filterable by component name.
  const wineSearchLogger = bootstrapLogger.child({ component: 'WineSearch' });
  // Track A's `QueryAnalyzerService` consumes a `{ warn, info }` shape;
  // wine-agent-loop and synthesis require an additional `error` method. Pino
  // satisfies both — we pass the same logger instance.
  const queryAnalyzer = new QueryAnalyzerService({
    structuredLlm,
    logger: wineSearchLogger,
  });
  const router = new DeterministicRouter();
  const executionRunner = new ExecutionRunner({
    searchUseCase: searchAdapter,
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
  const wineAgentLoopRunner = new WineAgentLoopRunner({
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
  // ── 4a) WineAgentLoop tool bundle. Without this slot the orchestrator falls
  //       through to Synthesizer Layer 4 (graceful degradation) on
  //       multi-step plans — i.e. the new architecture would silently NOT
  //       drive `WineAgentLoopRunner` for the ~10–20% of queries that need
  //       multi-hop ReAct. The bundle reuses the SAME adapter instances
  //       already wired into `ExecutionRunner` so the deterministic and
  //       LLM-driven lanes share state, caches, and circuit breakers
  //       (CLAUDE.md rule 30 — SSoT for tool ports).
  const wineAgentLoopToolBundle = buildWineAgentLoopToolBundle({
    searchUseCase: searchAdapter,
    // Dedicated lookup authority (V2). `lookup_wine` dispatches here directly;
    // `searchUseCase` is reserved for discovery + similar_to_entity.
    lookupWine: features.entityLookupV2UseCase,
    decomposedSearchUseCase: features.decomposedSearchUseCase,
    drinkingWindowUseCase: features.drinkingWindowUseCase,
    entityLookup: _core.entityLookup,
  });

  // ── 4b) Comparison LLM fallback. One-shot grounded synthesis for stalled
  //       comparison_nested plans (bench v9 found 4 such scenarios in the
  //       bottom 15 — all terminated with `max_steps`).
  const wineSearchOrchestrator: WineSearchOrchestrator =
    new WineSearchOrchestratorImpl({
      queryAnalyzer,
      router,
      executionRunner,
      wineAgentLoopRunner,
      synthesisRunner,
      wineAgentLoopToolBundle,
      logger: bootstrapLogger,
    });

  // Persistent multi-turn session store (T-MTA-03). Production wires a durable
  // SQLite file via `AGENT_SESSION_DB_PATH`. When unset, the session surface
  // fails CLOSED (no service → 503) rather than silently falling back to a
  // process-local store that would lose history across restarts/instances.
  // Single-shot `/v1/agent` runs do NOT need the store and stay available.
  const sessionDbPath = process.env['AGENT_SESSION_DB_PATH'];
  let agentSessionStore: AgentSessionStorePort | undefined;
  let agentSessionService: AgentSessionService | undefined;
  if (sessionDbPath !== undefined && sessionDbPath.length > 0) {
    try {
      agentSessionStore = createSqliteAgentSessionStore({ path: sessionDbPath });
      agentSessionService = new AgentSessionService({
        store: agentSessionStore,
        orchestrator: wineSearchOrchestrator,
        computeExpiry: (now) => computeAgentSessionExpiry(now),
      });
    } catch (err) {
      bootstrapLogger.error(
        { err, path: sessionDbPath },
        '[container] failed to open agent session SQLite store — multi-turn session surface DISABLED (fail-closed)',
      );
      agentSessionStore = undefined;
      agentSessionService = undefined;
    }
  }

  const agentUseCase = new AgentUseCase({
    orchestrator: wineSearchOrchestrator,
    ...(agentSessionService !== undefined ? { sessionService: agentSessionService } : {}),
  });

  return {
    wineSearchOrchestrator,
    agentUseCase,
    ...(agentSessionStore !== undefined ? { agentSessionStore } : {}),
    ...(agentSessionService !== undefined ? { agentSessionService } : {}),
  };
}

export async function createContainer(
  config: Config,
  runtime: Pool | RuntimeHandles = {},
): Promise<Container> {
  const runtimeHandles = await bindLiveSearchSnapshotRuntimeHandles(
    normalizeRuntimeHandles(runtime),
  );
  const core = await buildCoreContainerServices(config, runtimeHandles);

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

  const lookupAuthority = await createLookupAuthorityServices(
    config,
    runtimeHandles,
    {
      calibrationStore: core.calibrationStore,
      entityResolver: core.entityResolver,
    },
  );
  const features = buildFeatureContainerServices(
    config,
    core,
    lookupAuthority,
    runtimeHandles,
    useCaseExtensions,
  );
  // Defense-in-depth: env validation already throws when AGENT_ENABLED=true
  // and no OpenAI credential is set (see config/env.ts). If we somehow reach here
  // without a chatLlm, fail loudly rather than silently 404 the agent route.
  if (config.agent.enabled && core.chatLlm === undefined) {
    throw new Error(
      'AGENT_ENABLED=true but no ChatLlm was constructed — check OPENAI_API_KEY/OPENAI_API_KEYS, Codex ChatGPT login token, and chatLlm wiring',
    );
  }

  // Plan-then-Execute wine-search slice. Returns `undefined` when the
  // `WINE_SEARCH_ENABLED` flag is off — the `/v1/agent` route is
  // simply not registered in that case (zero runtime cost).
  const wineSearch = buildWineSearchContainerServices(
    config,
    core,
    features,
    sharedStructuredLlm,
  );

  return {
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
    ...(wineSearch !== undefined ? { wineSearch } : {}),
  };
}
