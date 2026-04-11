/**
 * Final result from the agent orchestrator.
 */

import type { AgentStep, AgentTerminationReason } from './agent-step.js';
import type { SearchResponseV1 } from '../../response/model/search-response.js';
import type { SynthesisContext, ToolOutcome } from '../../../application/agent/tool-outcome.js';
import type { AuditExtension } from '../../audit/model/audit-extension.js';

export interface AgentResult {
  readonly answer: string;
  readonly steps: readonly AgentStep[];
  readonly totalDurationMs: number;
  readonly totalTokens: { readonly input: number; readonly output: number };
  readonly toolCallCount: number;
  readonly fallbackApplied: boolean;
  readonly terminationReason: AgentTerminationReason;
  /** Last search result from the pipeline, if any tool call produced one. */
  readonly searchResults?: SearchResponseV1 | undefined;
  /**
   * E7-T2: Typed tool outcomes, generated alongside AgentStep for each tool invocation.
   * Enables downstream consumers (E8 audit, eval) to branch on outcome kind
   * without parsing observation text.
   * Populated for both sequential and batch tool call paths.
   */
  readonly toolOutcomes?: readonly ToolOutcome[] | undefined;

  /**
   * E7-T3: Structured synthesis/fallback context derived from typed tool outcomes.
   * Captures failed steps and which fallback layer, if any, was applied.
   */
  readonly synthesisContext?: SynthesisContext | undefined;

  /**
   * E8: Structured fallback trace for agent responses.
   * Uses the canonical AuditExtension fallback_trace shape as SSOT.
   */
  readonly fallbackTrace?: AuditExtension['fallback_trace'] | undefined;
}
