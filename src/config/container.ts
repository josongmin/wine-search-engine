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
  const feedbackIngestEnabled =
    !config.killSwitch.learning && learning.feedbackStore !== null;

  return {
    ...learning,
    feedbackIngestEnabled,
    ...(core.chatLlm !== undefined ? { chatLlm: core.chatLlm } : {}),
    queryPlanner: core.queryPlanner,
    entityResolver: core.entityResolver,
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
      ? {
          agentOrchestrator: new AgentOrchestrator(
            {
              chatLlm: core.chatLlm,
              toolDeps: {
                searchUseCase: features.searchUseCase,
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
