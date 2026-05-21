/**
 * Bench-scorer adapter — pure mapping from orchestrator outputs into the
 * `ScenarioExecution` contract the bench scorer (`test/benchmark/agent/scorer.ts`)
 * consumes.
 *
 * Why this module exists:
 *   The bench scorer is orchestrator-agnostic: it takes a `ScenarioExecution`
 *   (answer, tool trace, observations, termination, etc.) and returns a
 *   `ScenarioResult` with per-dimension scores. To run the *new*
 *   `WineSearchOrchestrator` against the existing 18k-line scenario corpus we
 *   need a `WineSearchResult → ScenarioExecution` projection. The legacy
 *   `AgentResult` projection already lives inline in
 *   `test/benchmark/agent/runner.ts` (around line 1316); we re-implement it
 *   faithfully here so both projections live side-by-side and can be diffed by
 *   the cutover-validation harness.
 *
 * Invariants (CLAUDE.md SOTA+++++ schema-quality bar):
 *   - PURE: no IO, no logging, no clock reads — every output is a function of
 *     its input.
 *   - No `as DomainType` casts on cross-module data. `JSON.stringify` on
 *     tool-call arguments is the only structural transform.
 *   - Termination mapping is exhaustive across `AgentTerminationReason`.
 *     A new union variant added upstream MUST surface a tsc error here.
 *   - `evidenceFrames` is intentionally OMITTED for the new orchestrator —
 *     `WineSearchResult` does not (yet) plumb `ToolCallEvidenceFrame[]` to
 *     the top level; downstream claim-level evaluation degrades gracefully.
 *
 * Mapping notes (verify-by-reading `ScenarioExecution` at
 *  `test/benchmark/agent/scorer.ts:134`):
 *   - `stepCount` counts only steps with `source ∈ { 'runner', 'mini_loop' }`.
 *     Analyzer / router / synthesizer phases are bookkeeping; they do not
 *     represent "agent steps" in the scorer's sense and would inflate the
 *     step-efficiency penalty otherwise.
 *   - `toolCallCount` is taken from the top-level `result.toolCallCount`
 *     (already an invariant: sum of `toolCalls.length` across runner+mini_loop
 *     steps, set by the orchestrator and validated by its Zod schema).
 *   - `totalTokens` keeps only `{ input, output }`. Cache tokens
 *     (`cacheReadTokens` + `cacheCreationTokens`) are dropped — the scorer's
 *     `costEfficiency` budgets are anchored to raw input/output and the legacy
 *     orchestrator never plumbed cache fields.
 *   - `terminationReason` is mapped via `mapAgentTerminationToScenario` so
 *     `'max_steps' / 'budget' / 'loop_detected' / 'aborted'` collapse to
 *     `'fallback'` exactly the way the existing bench harness does
 *     (`test/benchmark/agent/runner.ts:631`).
 */

import type { AgentResult } from '@domain/agent/model/agent-result.js';
import type { AgentStep, AgentTerminationReason, AgentToolCall } from '@domain/agent/model/agent-step.js';
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

/** Source-kind allowlist for `stepCount`: only runner / mini_loop steps
 *  represent "real" agent steps that emit tool calls. Analyzer / router /
 *  synthesizer phases are framework bookkeeping. */
const SCORER_STEP_SOURCES: ReadonlySet<ExecutionStep['source']> = new Set([
  'runner',
  'mini_loop',
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
 * Only steps whose `source` is `'runner'` or `'mini_loop'` are inspected.
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
 * Like `extractWineSearchToolsUsed`, only runner / mini_loop step
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
  // Step count: only runner / mini_loop sourced steps. Avoids inflating the
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

// ---------------------------------------------------------------------------
// AgentResult → ScenarioExecution
//
// Re-implements the inline projection at
// `test/benchmark/agent/runner.ts:1316-1359`. The original is not exportable
// (defined as a block inside the runner driver); re-implementing here keeps
// the legacy ↔ new comparison symmetric — both sides flow through *this*
// module so any drift is local and testable.
// ---------------------------------------------------------------------------

/**
 * Flatten `AgentResult.steps[]` → `ToolCallTrace[]`. Mirrors the legacy
 * `result.steps.flatMap(...)` pattern. Handles both the modern `actionPairs`
 * (parallel batch) and the legacy `action` (sequential) step shapes.
 */
function extractLegacyToolsUsed(steps: readonly AgentStep[]): ScenarioToolCallTrace[] {
  const calls: ScenarioToolCallTrace[] = [];
  for (const step of steps) {
    const pairs = step.actionPairs;
    if (pairs !== undefined) {
      for (const pair of pairs) {
        calls.push({
          tool: pair.action.tool,
          input: JSON.stringify(pair.action.input),
        });
      }
      continue;
    }
    const action = step.action;
    if (action !== undefined) {
      calls.push({
        tool: action.tool,
        input: JSON.stringify(action.input),
      });
      continue;
    }
    // TODO(cleanup): the deprecated `step.actions` field is read for
    // backward-compatibility with older bench fixtures (CLAUDE.md rule 31).
    const fallbackBatch = readDeprecatedLegacyActions(step);
    for (const a of fallbackBatch) {
      calls.push({ tool: a.tool, input: JSON.stringify(a.input) });
    }
  }
  return calls;
}

/**
 * Single suppressed-deprecation access to `step.actions` — isolates the
 * `@typescript-eslint/no-deprecated` lint suppression to one line, which is
 * permitted during migration windows per CLAUDE.md rule 31.
 */
function readDeprecatedLegacyActions(step: AgentStep): readonly AgentToolCall[] {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- migration fallback for older fixtures.
  return step.actions ?? [];
}

/**
 * Flatten `AgentResult.steps[]` → observation strings. Prefers typed
 * `evidenceFrames[].observationSnapshot` when present (ADR-009 Phase 0) — the
 * snapshots are byte-equivalent to what the LLM saw but are sourced from a
 * structured frame. Falls back to step-level `actionPairs[].observation` /
 * `step.observation` otherwise. Mirrors `test/benchmark/agent/runner.ts:1330`.
 */
function extractLegacyObservations(result: AgentResult): string[] {
  const frames = result.evidenceFrames;
  if (frames !== undefined && frames.length > 0) {
    const out: string[] = [];
    for (const f of frames) {
      if (f.observationSnapshot.length > 0) out.push(f.observationSnapshot);
    }
    return out;
  }
  const out: string[] = [];
  for (const step of result.steps) {
    const pairs = step.actionPairs;
    if (pairs !== undefined) {
      for (const p of pairs) {
        if (p.observation.length > 0) out.push(p.observation);
      }
      continue;
    }
    if (step.observation !== undefined && step.observation.length > 0) {
      out.push(step.observation);
    }
  }
  return out;
}

/**
 * Project a legacy `AgentResult` from the ReAct orchestrator into a
 * `ScenarioExecution`. Mirrors the inline projection at
 * `test/benchmark/agent/runner.ts:1316`.
 */
export function agentResultToScenarioExecution(
  result: AgentResult,
): ScenarioExecutionLike {
  const toolsUsed = extractLegacyToolsUsed(result.steps);
  const observations = extractLegacyObservations(result);
  return {
    answer: result.answer,
    stepCount: result.steps.length,
    toolCallCount: result.toolCallCount,
    toolsUsed,
    observations,
    ...(result.evidenceFrames !== undefined && result.evidenceFrames.length > 0
      ? { evidenceFrames: result.evidenceFrames }
      : {}),
    terminationReason: mapAgentTerminationToScenario(result.terminationReason),
    totalDurationMs: result.totalDurationMs,
    totalTokens: {
      input: result.totalTokens.input,
      output: result.totalTokens.output,
    },
    ...(result.evidenceFrames !== undefined
      ? { evidenceFrameCount: result.evidenceFrames.length }
      : {}),
  };
}
