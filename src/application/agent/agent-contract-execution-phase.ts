import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentToolCallPair } from '../../domain/agent/model/agent-step.js';
import type { ToolCallEvidenceFrame } from '../../domain/agent/model/tool-call-evidence-frame.js';
import { toolCallIdForStep } from '../../domain/agent/service/build-tool-call-evidence-frame.js';
import type { StepBudget } from '../../domain/agent/service/step-budget.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentToolDeps, AgentToolResult } from './agent-tools.js';
import { executeAgentToolsBatch } from './agent-tools.js';
import { truncateObservation } from './agent-prompt.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import { AgentContractExecutionResultPolicy } from './agent-contract-execution-result-policy.js';
import { AgentContractPolicy } from './agent-contract-policy.js';
import {
  buildToolOutcome,
  getParallelBatchTimeoutMs,
  withTimeout,
} from './agent-tool-execution-support.js';

const log = bootstrapLogger.child({ component: 'AgentContractExecutionPhase' });

interface AgentContractExecutionPhaseDeps {
  readonly toolDeps: AgentToolDeps;
}

export class AgentContractExecutionPhase {
  private readonly contractPolicy = new AgentContractPolicy();
  private readonly executionResultPolicy = new AgentContractExecutionResultPolicy();

  constructor(private readonly deps: AgentContractExecutionPhaseDeps) {}

  private buildRuntimeToolDeps(state: AgentExecutionState): AgentToolDeps {
    return {
      ...this.deps.toolDeps,
      groundedDrinkingWindowLookup: (id) => state.groundedDrinkingWindowByEntityId.get(String(id)),
    };
  }

  async runDrinkabilityChecks(
    queryExecutionContract: AgentQueryExecutionContract,
    requestId: string,
    effectiveConfig: AgentConfig,
    budget: StepBudget,
    state: AgentExecutionState,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const pendingIds = this.contractPolicy.getPendingDrinkabilityEntityIds(queryExecutionContract, state);
    if (pendingIds.length === 0) {
      return true;
    }

    const checkCalls = pendingIds.map((entityId) => ({
      tool: 'check_drinking_window',
      input: { entity_id: entityId },
    }));
    const budgetCheck = budget.recordParallelBatch(checkCalls, { skipNearDuplicate: true });
    if (!budgetCheck.allowed) {
      this.executionResultPolicy.applyBudgetReservationFailure(state, budgetCheck.reason);
      return false;
    }

    const stepIndex = state.steps.length;
    const stepStartMs = Date.now();
    const autoAbortController = new AbortController();
    const propagateAutoAbort = (): void => { autoAbortController.abort(); };
    abortSignal?.addEventListener('abort', propagateAutoAbort, { once: true });

    let results: readonly AgentToolResult[];
    try {
      results = await withTimeout(
        executeAgentToolsBatch(
          checkCalls,
          this.buildRuntimeToolDeps(state),
          `${requestId}-step${stepIndex}`,
          {
            abortSignal: autoAbortController.signal,
            toolCallId: toolCallIdForStep(requestId, stepIndex),
          },
        ),
        getParallelBatchTimeoutMs(checkCalls, effectiveConfig.parallelBatchTimeoutMs),
        'Contract drinkability batch timed out',
      );
    } catch (err) {
      autoAbortController.abort();
      const durationMs = Math.max(0, Date.now() - stepStartMs);
      const handled = this.executionResultPolicy.applyFailure({
        err,
        requestId,
        stepIndex,
        checkCalls,
        durationMs,
        state,
      });
      if (!handled) {
        log.error({ err, requestId, stepIndex }, 'contract drinkability batch failed');
      }
      return false;
    } finally {
      autoAbortController.abort();
      abortSignal?.removeEventListener('abort', propagateAutoAbort);
    }

    const durationMs = Math.max(0, Date.now() - stepStartMs);
    const observations: string[] = [];
    const actionPairs: AgentToolCallPair[] = [];
    const frames: ToolCallEvidenceFrame[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const call = checkCalls[i]!;
      const observation = truncateObservation(result.observation, effectiveConfig.maxContextChars);
      observations.push(observation);
      actionPairs.push({ action: call, observation });
      if (result.evidenceFrame !== undefined) {
        frames.push(result.evidenceFrame);
        state.collectedFrames.push(result.evidenceFrame);
      }
      state.toolOutcomes.push(
        buildToolOutcome(
          requestId,
          stepIndex,
          i,
          call.tool,
          observation,
          result.rawResult,
          durationMs,
          result.rawResult === null,
          false,
          false,
        ),
      );
    }

    state.steps.push({
      index: stepIndex,
      thought: 'contract: drinkability check after entity retrieval',
      actionPairs,
      actions: checkCalls,
      observations,
      durationMs,
      tokenCount: { input: 0, output: 0 },
      ...(frames.length > 0 ? { evidenceFrames: frames } : {}),
    });
    return true;
  }
}
