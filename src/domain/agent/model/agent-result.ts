/**
 * Final result from the agent orchestrator.
 */

import type { AgentStep, AgentTerminationReason } from './agent-step.js';
import type { SearchResponseV1 } from '../../response/model/search-response.js';

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
}
