import type { Config } from './env.js';
import { buildCoreContainerServices } from './container-core.js';
import { buildFeatureContainerServices } from './container-features.js';
import { buildWatchlistContainerServices } from './container-watchlist.js';
import { buildLearningContainerServices } from './container-learning.js';
import type { LearningContainerServices } from './container-learning.js';
import type { RuntimeHandles } from './runtime-handles.js';
import type { DrinkingWindowUseCasePort } from '../application/drinking-window/port/drinking-window-usecase.port.js';
import type { DrinkingWindowPredictorPort } from '../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';
import type {
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

export interface Container extends LearningContainerServices {
  /** OpenAI-compatible chat when `OPENAI_API_KEY` is set. */
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
  /** Agentic orchestrator — present when AGENT_ENABLED=true and ChatLlmPort available. */
  readonly agentOrchestrator?: AgentOrchestrator | undefined;
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
  // and OPENAI_API_KEY is unset (see config/env.ts). If we somehow reach here
  // without a chatLlm, fail loudly rather than silently 404 the agent route.
  if (config.agent.enabled && core.chatLlm === undefined) {
    throw new Error(
      'AGENT_ENABLED=true but no ChatLlm was constructed — check OPENAI_API_KEY and chatLlm wiring',
    );
  }

  const feedbackIngestEnabled =
    !config.killSwitch.learning && learning.feedbackStore !== null;

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
            },
          ),
        }
      : {}),
  };
}
