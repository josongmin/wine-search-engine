import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type { AgentExecutionObserver } from '../../domain/agent/port/agent-execution-observer.port.js';
import type { StepBudget } from '../../domain/agent/service/step-budget.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import {
  AgentResultAssembler,
  buildAgentResultMetrics,
} from './agent-result-assembly.js';
import { AgentResultTelemetryReporter } from './agent-result-telemetry-reporter.js';

interface AgentResultFinalizerDeps {
  readonly executionObserver?: AgentExecutionObserver | undefined;
}

interface FinalizeAgentResultInput {
  readonly query: string;
  readonly requestId: string;
  readonly answer: string;
  readonly observedToolOutput: boolean;
  readonly budget: StepBudget;
  readonly state: AgentExecutionState;
}

export class AgentResultFinalizer {
  private readonly assembler = new AgentResultAssembler();
  private readonly telemetryReporter: AgentResultTelemetryReporter;

  constructor(deps: AgentResultFinalizerDeps) {
    this.telemetryReporter = new AgentResultTelemetryReporter(deps);
  }

  finalize(input: FinalizeAgentResultInput): AgentResult {
    const metrics = buildAgentResultMetrics(input);
    this.telemetryReporter.report({
      requestId: input.requestId,
      state: input.state,
      metrics,
    });
    return this.assembler.build(input, metrics);
  }
}
