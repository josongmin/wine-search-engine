/**
 * Bench-scorer adapter — pure mapping from `WineSearchResult` (the new
 * orchestrator's output) into the `ScenarioExecution` contract the bench
 * scorer (`test/benchmark/agent/scorer.ts`) consumes.
 *
 * Why this module exists:
 *   The bench scorer is orchestrator-agnostic: it takes a `ScenarioExecution`
 *   (answer, tool trace, observations, termination, etc.) and returns a
 *   `ScenarioResult` with per-dimension scores. To run the
 *   `WineSearchOrchestrator` against the existing scenario corpus we need a
 *   `WineSearchResult → ScenarioExecution` projection — that projection lives
 *   here.
 *
 * Invariants (CLAUDE.md SOTA+++++ schema-quality bar):
 *   - PURE: no IO, no logging, no clock reads — every output is a function of
 *     its input.
 *   - No `as DomainType` casts on cross-module data. `JSON.stringify` on
 *     tool-call arguments is the only structural transform.
 *   - Termination mapping is exhaustive across `AgentTerminationReason`.
 *     A new union variant added upstream MUST surface a tsc error here.
 *   - `evidenceFrames` is intentionally OMITTED — `WineSearchResult` does
 *     not (yet) plumb `ToolCallEvidenceFrame[]` to the top level; downstream
 *     claim-level evaluation degrades gracefully.
 *
 * Mapping notes (verify-by-reading `ScenarioExecution` at
 *  `test/benchmark/agent/scorer.ts:134`):
 *   - `stepCount` counts only steps with `source ∈ { 'runner', 'wine_agent_loop' }`.
 *     Analyzer / router / synthesizer phases are bookkeeping; they do not
 *     represent "agent steps" in the scorer's sense and would inflate the
 *     step-efficiency penalty otherwise.
 *   - `toolCallCount` is taken from the top-level `result.toolCallCount`
 *     (already an invariant: sum of `toolCalls.length` across runner+wine_agent_loop
 *     steps, set by the orchestrator and validated by its Zod schema).
 *   - `totalTokens` keeps only `{ input, output }`. Cache tokens
 *     (`cacheReadTokens` + `cacheCreationTokens`) are dropped — the scorer's
 *     `costEfficiency` budgets are anchored to raw input/output.
 */

import type { AgentTerminationReason } from '@domain/agent/model/agent-step.js';
import type { ToolCallEvidenceFrame } from '@domain/agent/model/tool-call-evidence-frame.js';
import type { WineSearchResult, ExecutionStep } from './wine-search-result-schemas.js';

// ---------------------------------------------------------------------------
// Structural mirror of the bench scorer's input contract
//
// The bench scorer lives at `test/benchmark/agent/scorer.ts` and its
// `ScenarioExecution` / `ToolCallTrace` / `TerminationReason` types are the
// canonical source. The main `tsconfig.json` excludes `test/` from rootDir,
// so we cannot import those types into `src/` without breaking `tsc --build`.
//
// We mirror the contract here as a structural type. The mirror is a STRICT
// SUPERSET of the scorer's shape (same fields, same optionality) so any
// `ScenarioExecutionLike` value flows freely into a `ScenarioExecution`
// position. A contract test under `__tests__/` imports the real scorer types
// and `satisfies`-checks the projection — drift fails the test fast.
// ---------------------------------------------------------------------------

/** Mirror of `TerminationReason` from `test/benchmark/agent/scenario.ts`. */
export type ScenarioTerminationReason =
  | 'answer'
  | 'fallback'
  | 'blocked'
  | 'error'
  | 'timeout';

/** Mirror of `ToolCallTrace` from `test/benchmark/agent/scorer.ts:42`. */
export interface ScenarioToolCallTrace {
  readonly tool: string;
  readonly input?: string;
}

/** Mirror of `ScenarioExecution` from `test/benchmark/agent/scorer.ts:134`. */
export interface ScenarioExecutionLike {
  readonly answer: string;
  readonly stepCount: number;
  readonly toolCallCount: number;
  readonly toolsUsed: readonly ScenarioToolCallTrace[];
  readonly observations: readonly string[];
  readonly evidenceFrames?: readonly ToolCallEvidenceFrame[] | undefined;
  readonly terminationReason: ScenarioTerminationReason;
  readonly totalDurationMs: number;
  readonly totalTokens: { input: number; output: number };
  readonly evidenceFrameCount?: number | undefined;
  readonly stageTimings?: Readonly<Record<string, number>> | undefined;
}

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Source-kind allowlist for `stepCount`: only runner / wine_agent_loop steps
 *  represent "real" agent steps that emit tool calls. Analyzer / router /
 *  synthesizer phases are framework bookkeeping. */
const SCORER_STEP_SOURCES: ReadonlySet<ExecutionStep['source']> = new Set([
  'runner',
  'wine_agent_loop',
]);

// ---------------------------------------------------------------------------
// Termination mapping
// ---------------------------------------------------------------------------

/**
 * Map an `AgentTerminationReason` (domain union) → `ScenarioTerminationReason`
 * (bench-scorer union mirror). Exhaustive switch — adding a variant upstream
 * forces a tsc error here.
 *
 * The legacy bench harness has an identical mapping inline at
 * `test/benchmark/agent/runner.ts:631`; we mirror it byte-for-byte so the
 * legacy and new sides project termination identically.
 */
export function mapAgentTerminationToScenario(
  reason: AgentTerminationReason,
): ScenarioTerminationReason {
  switch (reason) {
    case 'answer':
      return 'answer';
    case 'timeout':
      return 'timeout';
    case 'error':
      return 'error';
    case 'blocked':
      return 'blocked';
    case 'max_steps':
    case 'budget':
    case 'loop_detected':
    case 'fallback':
    case 'aborted':
      return 'fallback';
  }
}

// ---------------------------------------------------------------------------
// WineSearchResult → ScenarioExecution
// ---------------------------------------------------------------------------

/**
 * Flatten the per-step tool calls of a `WineSearchResult` into the
 * `ToolCallTrace[]` shape the scorer consumes (`{ tool, input }` where `input`
 * is a stringified JSON object — matches the legacy adapter's call shape).
 *
 * Only steps whose `source` is `'runner'` or `'wine_agent_loop'` are inspected.
 * The orchestrator's top-level `toolCallCount` invariant pins the same set,
 * so the flattened length here MUST equal `result.toolCallCount`.
 */
function extractWineSearchToolsUsed(
  steps: readonly ExecutionStep[],
): ScenarioToolCallTrace[] {
  const calls: ScenarioToolCallTrace[] = [];
  for (const step of steps) {
    if (!SCORER_STEP_SOURCES.has(step.source)) continue;
    const toolCalls = step.toolCalls;
    if (toolCalls === undefined) continue;
    for (const call of toolCalls) {
      calls.push({
        tool: call.name,
        input: JSON.stringify(call.arguments),
      });
    }
  }
  return calls;
}

/**
 * Flatten the per-step `observations` arrays into a single ordered list.
 *
 * Like `extractWineSearchToolsUsed`, only runner / wine_agent_loop step
 * observations are surfaced. We additionally filter out empty strings —
 * those carry no signal and would dilute the scorer's `contextRecall` and
 * `faithfulness` dimensions (parity with `test/benchmark/agent/runner.ts:1330`
 * which applies the same `.filter((o) => o.length > 0)`).
 */
function extractWineSearchObservations(
  steps: readonly ExecutionStep[],
): string[] {
  const observations: string[] = [];
  for (const step of steps) {
    if (!SCORER_STEP_SOURCES.has(step.source)) continue;
    const obs = step.observations;
    if (obs === undefined) continue;
    for (const o of obs) {
      if (o.length > 0) observations.push(o);
    }
  }
  return observations;
}

/**
 * Project a `WineSearchResult` from the new orchestrator into the
 * `ScenarioExecution` contract consumed by the bench scorer.
 *
 * Pure mapping. Does not validate input — callers are expected to have
 * passed the result through `WineSearchResultSchema` already (the
 * orchestrator does this internally before return).
 */
export function wineSearchResultToScenarioExecution(
  result: WineSearchResult,
): ScenarioExecutionLike {
  const toolsUsed = extractWineSearchToolsUsed(result.executionSteps);
  const observations = extractWineSearchObservations(result.executionSteps);
  // Step count: only runner / wine_agent_loop sourced steps. Avoids inflating the
  // step-efficiency penalty when analyzer/router/synthesizer phases are
  // present in the trace.
  let stepCount = 0;
  for (const step of result.executionSteps) {
    if (SCORER_STEP_SOURCES.has(step.source)) stepCount += 1;
  }
  return {
    answer: result.answer,
    stepCount,
    toolCallCount: result.toolCallCount,
    toolsUsed,
    observations,
    terminationReason: mapAgentTerminationToScenario(result.terminationReason),
    totalDurationMs: result.totalDurationMs,
    totalTokens: {
      input: result.tokenUsage.inputTokens,
      output: result.tokenUsage.outputTokens,
    },
  };
}

