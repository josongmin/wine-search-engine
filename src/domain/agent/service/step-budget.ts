/**
 * Tracks remaining budget (steps, time) for an agent run.
 * Immutable — each check returns a new state.
 */

import type { AgentConfig } from '../model/agent-config.js';
import type { AgentTerminationReason } from '../model/agent-step.js';

export interface BudgetCheck {
  readonly allowed: boolean;
  readonly reason?: AgentTerminationReason | undefined;
}

export class StepBudget {
  private readonly startTime: number;
  private stepCount = 0;
  /** Tracks tool+input pairs to detect infinite loops. */
  private readonly seenActions = new Set<string>();

  constructor(private readonly config: AgentConfig) {
    this.startTime = Date.now();
  }

  /** Check if another step is allowed. */
  canProceed(): BudgetCheck {
    if (this.stepCount >= this.config.maxSteps) {
      return { allowed: false, reason: 'max_steps' };
    }
    if (Date.now() - this.startTime > this.config.agentTimeoutMs) {
      return { allowed: false, reason: 'timeout' };
    }
    return { allowed: true };
  }

  /** Record a step and check for loops. Returns false if loop detected. */
  recordStep(tool: string, input: Record<string, unknown>): BudgetCheck {
    this.stepCount++;
    const key = `${tool}:${JSON.stringify(input)}`;
    if (this.seenActions.has(key)) {
      return { allowed: false, reason: 'loop_detected' };
    }
    this.seenActions.add(key);
    return { allowed: true };
  }

  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  getStepCount(): number {
    return this.stepCount;
  }
}
