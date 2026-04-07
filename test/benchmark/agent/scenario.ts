/**
 * Agent benchmark scenario definition.
 *
 * Each scenario defines:
 *   - A user query
 *   - Expected tool call sequence (for tool-accuracy scoring)
 *   - Expected answer keywords (for answer-quality scoring)
 *   - Constraints on step count and cost
 */

export type ScenarioTier =
  | 'single_shot'
  | 'multi_step'
  | 'complex_reasoning'
  | 'conversational'
  | 'edge_case'
  | 'nested_condition'
  | 'comparison_nested'
  | 'relative_reference'
  | 'situation_based'
  | 'negation'
  | 'knowledge_hybrid'
  | 'extreme';

export interface ExpectedToolCall {
  readonly tool: string;
  /** If set, input must contain these keys. */
  readonly inputContains?: readonly string[];
}

export interface ScenarioExpectation {
  /** Tools that SHOULD be called (in any order unless ordered=true). */
  readonly tools?: readonly ExpectedToolCall[];
  /** If true, tools must be called in the specified order. */
  readonly ordered?: boolean;
  /** Max acceptable step count. */
  readonly maxSteps: number;
  /** Keywords that MUST appear in the final answer. */
  readonly answerContains?: readonly string[];
  /** Keywords that must NOT appear in the answer. */
  readonly answerExcludes?: readonly string[];
  /** Expected termination reason. */
  readonly terminationReason?: 'answer' | 'fallback';
}

export interface AgentBenchmarkScenario {
  readonly id: number;
  readonly tier: ScenarioTier;
  readonly query: string;
  readonly description: string;
  readonly expectation: ScenarioExpectation;
  /** Skip this scenario (e.g., requires Phase 2 features). */
  readonly skip?: string;
}
