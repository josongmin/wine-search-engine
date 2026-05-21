import type { AgentStep, AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import type { ToolCallEvidenceFrame } from '../../domain/agent/model/tool-call-evidence-frame.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { RetrievalDrinkingWindowProjection } from '../../domain/retrieval/model/retrieval-document.js';
import type { AgentVerificationReason } from './agent-query-execution-contract.js';
import type { SynthesisContext, ToolOutcome } from '../../domain/agent/model/tool-outcome.js';

export type AgentPlannerDirective =
  | { readonly kind: 'relax_constraints_retry' }
  | { readonly kind: 'pending_drinkability_check'; readonly entityIds: readonly string[] }
  | { readonly kind: 'required_tool'; readonly tool: string; readonly instruction: string }
  | { readonly kind: 'grounded_search_required'; readonly instruction: string }
  | {
      /**
       * P0: the planner attempted to commit an answer after a single tool call
       * for a query that the contract flagged as requiring a verify/synthesize
       * step (negation, comparison, multi-constraint, etc.). The candidate
       * answer was dropped; the planner must emit either a refined tool call
       * or an answer that explicitly cites grounding for every uncovered
       * constraint.
       */
      readonly kind: 'verification_required';
      readonly reason: AgentVerificationReason;
      readonly uncoveredConstraints: readonly string[];
      readonly instruction: string;
    };

export interface AgentExecutionState {
  readonly steps: AgentStep[];
  readonly toolOutcomes: ToolOutcome[];
  readonly collectedFrames: ToolCallEvidenceFrame[];
  lastSearchResult: SearchResponseV1 | undefined;
  readonly groundedDrinkingWindowByEntityId: Map<string, RetrievalDrinkingWindowProjection>;
  terminationReason: AgentTerminationReason;
  totalInputTokens: number;
  totalOutputTokens: number;
  reasoningFailureDetected: boolean;
  policyBlocked: boolean;
  llmCircuitOpen: boolean;
  unknownToolAttempts: number;
  plannerDefectAttempts: number;
  timeoutStats: { llmStep: number; tool: number; parallelBatch: number };
  hasInjectedRefinementHint: boolean;
  pendingRefinementRetry: boolean;
  pendingPlannerDirective: AgentPlannerDirective | undefined;
  /**
   * P0: latched after the first re-plan triggered by `verification_required`
   * is satisfied. Prevents an infinite verify-loop when the second-step answer
   * is itself a candidate; the guard only fires once per query.
   */
  verificationStepCompleted: boolean;
  /**
   * L1.C: latched true when the tool execution phase short-circuited the
   * run loop instead of letting the planner LLM emit `answer`. Observable
   * for telemetry / tests; does NOT drive control flow on its own (the
   * terminal routing already uses `state.answer === ''` as its gate).
   */
  fastAnswerBypassTriggered: boolean;
  fallbackApplied: boolean;
  fallbackLayer: SynthesisContext['fallbackApplied'];
  failedSynthesisAttempts: number;
  fallbackSearchUsed: boolean;
  answer: string;
}

export function createAgentExecutionState(): AgentExecutionState {
  return {
    steps: [],
    toolOutcomes: [],
    collectedFrames: [],
    lastSearchResult: undefined,
    groundedDrinkingWindowByEntityId: new Map(),
    terminationReason: 'max_steps',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    reasoningFailureDetected: false,
    policyBlocked: false,
    llmCircuitOpen: false,
    unknownToolAttempts: 0,
    plannerDefectAttempts: 0,
    timeoutStats: { llmStep: 0, tool: 0, parallelBatch: 0 },
    hasInjectedRefinementHint: false,
    pendingRefinementRetry: false,
    pendingPlannerDirective: undefined,
    verificationStepCompleted: false,
    fastAnswerBypassTriggered: false,
    fallbackApplied: false,
    fallbackLayer: null,
    failedSynthesisAttempts: 0,
    fallbackSearchUsed: false,
    answer: '',
  };
}
