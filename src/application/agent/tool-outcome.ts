/**
 * E7: ToolOutcome — typed observation companion for the agent contract executor.
 *
 * Complements the untyped `observation: string` pattern in AgentToolCallPair with
 * a structured outcome that distinguishes success, empty result, partial result,
 * timeout, tool error, and policy violation.
 *
 * The existing AgentStep and AgentToolCallPair substrate is NOT replaced —
 * ToolOutcome is generated alongside them as a typed companion. Downstream
 * synthesis can branch on ToolOutcome.kind without parsing observation text.
 */

// ─── AgentToolName ────────────────────────────────────────────────────────────
//
// SSOT: agent-tool-attempt-schema.ts owns KNOWN_AGENT_TOOL_NAMES.
// Re-exported here as AgentToolName / isAgentToolName for backward compat
// with ToolOutcome, TOOL_BATCH_POLICY, and existing consumers.
//
export {
  type KnownAgentToolName as AgentToolName,
  isKnownAgentToolName as isAgentToolName,
} from './agent-tool-attempt-schema.js';

// ─── ToolOutcomeKind ──────────────────────────────────────────────────────────

/**
 * Outcome classification for a single tool invocation.
 *
 * | value             | meaning                                               |
 * |-------------------|-------------------------------------------------------|
 * | success           | Tool executed and returned usable results             |
 * | empty_result      | Tool executed but returned 0 results                  |
 * | partial_result    | Results exist but don't satisfy expectedOutputSchema  |
 * | tool_error        | Tool execution itself threw / rejected                |
 * | timeout           | Tool invocation exceeded its time budget              |
 * | policy_violation  | Batch policy constraint prevented execution           |
 */
export type ToolOutcomeKind =
  | 'success'
  | 'empty_result'
  | 'partial_result'
  | 'tool_error'
  | 'timeout'
  | 'policy_violation';

// ─── ToolOutcome ──────────────────────────────────────────────────────────────

/**
 * E7: Typed outcome for a single agent tool invocation.
 *
 * Generated alongside (not replacing) the existing AgentToolCallPair observation.
 * Consumers: SynthesisContext builder, E8 fallback_trace, offline eval.
 */
export interface ToolOutcome {
  /** Deterministic step identifier (query hash + step index + tool position). */
  readonly stepId: string;

  /** The tool that was invoked. */
  readonly tool: string; // AgentToolName or unknown/future tools

  /** Structured outcome classification. */
  readonly kind: ToolOutcomeKind;

  /** The raw tool result, when available (success or partial_result). */
  readonly result?: unknown;

  /** Human-readable error message, when kind is tool_error or timeout. */
  readonly errorMessage?: string | undefined;

  /**
   * Unmet postconditions from the expectedOutputSchema, when kind is partial_result.
   * E.g. ['minResults: expected ≥2, got 1', 'requiredFields: missing vintageYear'].
   */
  readonly postconditionViolations?: readonly string[] | undefined;

  /** Wall-clock execution time for this tool call in milliseconds. */
  readonly durationMs: number;
}

// ─── ExpectedOutputSchema ────────────────────────────────────────────────────

/**
 * Postcondition schema for a PlanStep tool invocation.
 * Used to detect partial_result outcomes.
 */
export interface ExpectedOutputSchema {
  /** Minimum number of results the tool must return (for search_wines). */
  readonly minResults?: number | undefined;
  /** Fields that must be non-null on every result item. */
  readonly requiredFields?: readonly string[] | undefined;
}

// ─── SynthesisContext ─────────────────────────────────────────────────────────

/**
 * E7: Structured synthesis context — records typed, filterable step outcomes.
 *
 * Enables the synthesis prompt to distinguish successful from failed steps
 * without parsing observation text.
 */
export interface SynthesisContext {
  /** The original user query. */
  readonly query: string;

  /** All tool outcomes from this agent execution. */
  readonly steps: readonly ToolOutcome[];

  /** Steps where kind !== 'success' (empty_result, partial, error, timeout, violation). */
  readonly failedSteps: readonly ToolOutcome[];

  /**
   * Whether the synthesis LLM itself failed (timeout, token exhaustion, etc.).
   * When true, Layer 3 / Layer 4 fallback was applied.
   */
  readonly reasoningFailure: boolean;

  /**
   * Which fallback layer was applied during synthesis.
   * null = no fallback needed; synthesis LLM succeeded.
   */
  readonly fallbackApplied: 'layer2' | 'layer3' | 'layer4' | null;
}

// ─── buildSynthesisContext ────────────────────────────────────────────────────

/**
 * Build a SynthesisContext from tool outcomes and fallback state.
 *
 * Pure function — no side effects. Used by the orchestrator after all tool
 * steps complete, before synthesis LLM invocation.
 */
export function buildSynthesisContext(
  query: string,
  steps: readonly ToolOutcome[],
  reasoningFailure: boolean,
  fallbackApplied: SynthesisContext['fallbackApplied'],
): SynthesisContext {
  const failedSteps = steps.filter((s) => s.kind !== 'success');
  return { query, steps, failedSteps, reasoningFailure, fallbackApplied };
}
