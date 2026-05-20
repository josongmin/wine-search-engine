/**
 * ReAct Agent Orchestrator — the core agentic loop.
 *
 * Flow:
 *   1. Build system prompt + user query
 *   2. Loop: planner phase → tool execution phase
 *   3. Tool results become observations → feed back to planner/synthesis
 *   4. Terminate on: answer | max_steps | timeout | loop | error
 *   5. Fallback to single-shot search if LLM fails entirely
 */

import type { ChatLlmPort } from '../../domain/ai/port/chat-llm.port.js';
import type { AgentExecutionObserver } from '../../domain/agent/port/agent-execution-observer.port.js';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import { DEFAULT_AGENT_CONFIG } from '../../domain/agent/model/agent-config.js';
import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import {
  type AgentToolDeps,
} from './agent-tools.js';
import {
  AgentAnswerRecoveryPolicy,
  hasToolObservations,
} from './agent-answer-recovery-policy.js';
import {
  AgentPlannerPhaseRunner,
} from './agent-planner-phase-runner.js';
import { AgentObservationSynthesisRunner } from './agent-observation-synthesis-runner.js';
import { AgentContractExecutionPhase } from './agent-contract-execution-phase.js';
import {
  admitAgentRequest,
  buildAgentExecutionContext,
} from './agent-execution-context.js';
import { AgentToolExecutionPhase } from './agent-tool-execution-phase.js';
import { AgentResultFinalizer } from './agent-result-finalizer.js';
import { AgentRunLoop } from './agent-run-loop.js';
import { AgentTerminalRoutingPolicy } from './agent-terminal-routing-policy.js';
import {
  AgentSemanticContractCompiler,
  mergeAgentSemanticContract,
} from './agent-semantic-contract.js';

interface AgentOrchestratorDeps {
  readonly chatLlm: ChatLlmPort;
  readonly toolDeps: AgentToolDeps;
  readonly executionObserver?: AgentExecutionObserver | undefined;
  readonly querySanitizer?: QuerySanitizer | undefined;
}

export class AgentOrchestrator {
  private readonly config: AgentConfig;
  private readonly answerRecoveryPolicy: AgentAnswerRecoveryPolicy;
  private readonly plannerPhaseRunner: AgentPlannerPhaseRunner;
  private readonly observationSynthesisRunner: AgentObservationSynthesisRunner;
  private readonly contractExecutionPhase: AgentContractExecutionPhase;
  private readonly toolExecutionPhase: AgentToolExecutionPhase;
  private readonly resultFinalizer: AgentResultFinalizer;
  private readonly runLoop: AgentRunLoop;
  private readonly terminalRoutingPolicy: AgentTerminalRoutingPolicy;
  private readonly semanticContractCompiler: AgentSemanticContractCompiler;

  constructor(
    private readonly deps: AgentOrchestratorDeps,
    config?: Partial<AgentConfig>,
  ) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
    this.answerRecoveryPolicy = new AgentAnswerRecoveryPolicy({ toolDeps: deps.toolDeps });
    this.semanticContractCompiler = new AgentSemanticContractCompiler(deps.chatLlm);
    this.plannerPhaseRunner = new AgentPlannerPhaseRunner({ chatLlm: deps.chatLlm });
    this.observationSynthesisRunner = new AgentObservationSynthesisRunner({ chatLlm: deps.chatLlm });
    this.contractExecutionPhase = new AgentContractExecutionPhase({ toolDeps: deps.toolDeps });
    this.toolExecutionPhase = new AgentToolExecutionPhase({
      toolDeps: deps.toolDeps,
      contractExecutionPhase: this.contractExecutionPhase,
    });
    this.resultFinalizer = new AgentResultFinalizer({
      executionObserver: deps.executionObserver,
    });
    this.runLoop = new AgentRunLoop({
      plannerPhaseRunner: this.plannerPhaseRunner,
      toolExecutionPhase: this.toolExecutionPhase,
    });
    this.terminalRoutingPolicy = new AgentTerminalRoutingPolicy();
  }

  async execute(
    query: string,
    requestId: string,
    overrides?: Partial<Pick<AgentConfig, 'maxSteps' | 'perStepTimeoutMs' | 'agentTimeoutMs'>>,
    abortSignal?: AbortSignal,
  ): Promise<AgentResult> {
    const admissionResult = admitAgentRequest(
      { query, requestId },
      { querySanitizer: this.deps.querySanitizer },
    );
    if (admissionResult !== null) {
      return admissionResult;
    }

    const {
      effectiveConfig,
      queryExecutionContract: deterministicQueryExecutionContract,
      budget,
      state,
    } = buildAgentExecutionContext({
      query,
      requestId,
      baseConfig: this.config,
      overrides,
    });
    const semanticContract = await this.semanticContractCompiler.compileIfNeeded({
      query,
      requestId,
      deterministicContract: deterministicQueryExecutionContract,
      timeoutMs: effectiveConfig.perStepTimeoutMs,
      state,
      abortSignal,
    });
    const queryExecutionContract = semanticContract !== undefined
      ? mergeAgentSemanticContract(deterministicQueryExecutionContract, semanticContract)
      : deterministicQueryExecutionContract;

    await this.runLoop.run({
      query,
      requestId,
      effectiveConfig,
      queryExecutionContract,
      budget,
      state,
      abortSignal,
    });

    if (this.terminalRoutingPolicy.shouldRunObservationSynthesis({ state, abortSignal })) {
      await this.observationSynthesisRunner.run(query, requestId, effectiveConfig, state, abortSignal);
    }

    const observedToolOutput = hasToolObservations(state);
    const answer = await this.answerRecoveryPolicy.recoverAnswer(query, requestId, state, observedToolOutput, abortSignal);

    return this.resultFinalizer.finalize({
      query,
      requestId,
      answer,
      observedToolOutput,
      budget,
      state,
    });
  }
}
