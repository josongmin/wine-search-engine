import type { AgentToolDeps } from './agent-tools.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import { AgentAnswerRecoveryPolicy } from './agent-answer-recovery-policy.js';

interface AgentFallbackFinalizerDeps {
  readonly toolDeps: Pick<AgentToolDeps, 'searchUseCase'>;
}

export class AgentFallbackFinalizer {
  private readonly answerRecoveryPolicy: AgentAnswerRecoveryPolicy;

  constructor(deps: AgentFallbackFinalizerDeps) {
    this.answerRecoveryPolicy = new AgentAnswerRecoveryPolicy(deps);
  }

  async runFallbackCascade(
    query: string,
    requestId: string,
    state: AgentExecutionState,
    observedToolOutput: boolean,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    return this.answerRecoveryPolicy.recoverAnswer(
      query,
      requestId,
      state,
      observedToolOutput,
      abortSignal,
    );
  }
}
