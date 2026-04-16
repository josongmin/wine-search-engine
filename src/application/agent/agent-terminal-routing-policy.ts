import type { AgentExecutionState } from './agent-execution-state.js';

interface AgentTerminalRoutingInput {
  readonly state: AgentExecutionState;
  readonly abortSignal?: AbortSignal | undefined;
}

export class AgentTerminalRoutingPolicy {
  shouldRunObservationSynthesis(input: AgentTerminalRoutingInput): boolean {
    const { state, abortSignal } = input;
    return (
      !state.policyBlocked &&
      !state.llmCircuitOpen &&
      state.answer === '' &&
      state.terminationReason !== 'answer' &&
      !(abortSignal?.aborted)
    );
  }
}
