import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { StepBudget } from '../../domain/agent/service/step-budget.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentPlannerPhaseRunner } from './agent-planner-phase-runner.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import { AgentRunLoopTerminationPolicy } from './agent-run-loop-termination-policy.js';
import type { AgentToolExecutionPhase } from './agent-tool-execution-phase.js';

const log = bootstrapLogger.child({ component: 'AgentRunLoop' });

interface AgentRunLoopDeps {
  readonly plannerPhaseRunner: AgentPlannerPhaseRunner;
  readonly toolExecutionPhase: AgentToolExecutionPhase;
}

interface AgentRunLoopInput {
  readonly query: string;
  readonly requestId: string;
  readonly effectiveConfig: AgentConfig;
  readonly queryExecutionContract: AgentQueryExecutionContract;
  readonly budget: StepBudget;
  readonly state: AgentExecutionState;
  readonly abortSignal?: AbortSignal | undefined;
}

export class AgentRunLoop {
  private readonly terminationPolicy = new AgentRunLoopTerminationPolicy();

  constructor(private readonly deps: AgentRunLoopDeps) {}

  async run(input: AgentRunLoopInput): Promise<void> {
    const {
      query,
      requestId,
      effectiveConfig,
      queryExecutionContract,
      budget,
      state,
      abortSignal,
    } = input;

    try {
      for (;;) {
        const budgetCheck = budget.canProceed();
        if (!budgetCheck.allowed) {
          this.terminationPolicy.applyBudgetExhausted(state, budgetCheck.reason);
          break;
        }

        const remainingSteps = effectiveConfig.maxSteps - budget.getStepCount();
        // Planner-defect retries are recorded in `state.steps` for observability,
        // but they should not consume the "you already have grounded results"
        // last-step pressure path. Use actual tool progress instead.
        const hasToolProgress = state.toolOutcomes.length > 0;
        const isLastStep = remainingSteps === 1 || (remainingSteps === 2 && hasToolProgress);

        if (state.totalInputTokens + state.totalOutputTokens >= effectiveConfig.maxTotalTokens) {
          log.info(
            { requestId, totalTokens: state.totalInputTokens + state.totalOutputTokens, budget: effectiveConfig.maxTotalTokens },
            'agent token budget exhausted before LLM call - terminating',
          );
          this.terminationPolicy.applyTokenBudgetExhausted(state);
          break;
        }

        if (abortSignal?.aborted) {
          this.terminationPolicy.applyPreflightAbort(state);
          break;
        }

        const plannerPhase = await this.deps.plannerPhaseRunner.run(
          query,
          requestId,
          effectiveConfig,
          state,
          remainingSteps,
          isLastStep,
          abortSignal,
        );
        if (plannerPhase === null) {
          break;
        }

        const shouldBreak = await this.deps.toolExecutionPhase.run(
          requestId,
          effectiveConfig,
          budget,
          state,
          queryExecutionContract,
          plannerPhase,
          abortSignal,
        );
        if (shouldBreak) {
          break;
        }
      }
    } catch (err) {
      log.error({ err, requestId }, 'Agent run loop unexpected error');
      this.terminationPolicy.applyUnexpectedError(state, err);
    }
  }
}
