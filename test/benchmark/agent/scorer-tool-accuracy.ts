/**
 * Tool-accuracy dimension scoring.
 *
 * Extracted from `scorer.ts` during round 9 decomposition (2026-05-26).
 */

import type { ScenarioExpectation } from './scenario.js';
import type { Diagnostic, ToolCallTrace } from './scorer.js';
import {
  PENALTY_EXTRA_TOOL_PER_CALL,
  PENALTY_EXTRA_TOOL_CAP,
  PENALTY_TOOL_DUPLICATE,
  PENALTY_TOOL_ORDER_VIOLATION,
} from './constants.js';
import { clamp01 } from './scorer-aggregation.js';
import { countSemanticToolInvocations } from './scorer-tool-call-signatures.js';
import { parseToolCallInput } from './scorer-context-relevance.js';

const DISCOVERY_SEARCH_TOOLS = new Set([
  'search_hybrid',
  'search_semantic',
  'search_lexical',
]);

function isDiscoveryPartitionBatch(calls: readonly ToolCallTrace[]): boolean {
  if (calls.length < 2 || !calls.every((call) => DISCOVERY_SEARCH_TOOLS.has(call.tool))) {
    return false;
  }
  const wineTypes = calls
    .map((call) => parseToolCallInput(call)?.['wine_type'])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase());
  if (wineTypes.length !== calls.length) {
    return false;
  }
  return new Set(wineTypes).size === calls.length;
}

function toolCallSatisfiesExpectation(
  call: ToolCallTrace,
  expectedTool: NonNullable<ScenarioExpectation['tools']>[number],
): boolean {
  if (expectedTool.inputContains === undefined || expectedTool.inputContains.length === 0) {
    return true;
  }
  const input = (call.input ?? '').toLowerCase();
  return expectedTool.inputContains.every((sub) => input.includes(sub.toLowerCase()));
}

export function scoreToolAccuracy(
  exp: ScenarioExpectation,
  toolsUsed: readonly ToolCallTrace[],
  diagnostics: Diagnostic[],
  terminationReason?: string,
  stepCount?: number,
): number {
  // When the agent never ran (step 0 + fallback), tool expectations cannot be
  // evaluated — the LLM was unavailable (e.g. rate-limited), not the agent's fault.
  // Return 1 with an info note so the dim doesn't punish infrastructure failures.
  if (
    terminationReason === 'fallback'
    && (stepCount ?? 0) === 0
    && exp.mustNotCallTools === undefined
    && exp.expectedBlocked !== true
  ) {
    diagnostics.push({
      dim: 'toolAccuracy',
      severity: 'info',
      code: 'TOOL_ACCURACY_SKIPPED_STEP0_FALLBACK',
      message: 'tool accuracy not scored: agent never ran (step 0 fallback, LLM unavailable)',
    });
    return 1;
  }
  // Adversarial: mustNotCallTools is a CRITICAL hard fail.
  if (exp.mustNotCallTools !== undefined && exp.mustNotCallTools.length > 0) {
    const violated = exp.mustNotCallTools.filter((forbidden) =>
      toolsUsed.some((t) => t.tool === forbidden),
    );
    if (violated.length > 0) {
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'critical',
        code: 'MUST_NOT_CALL_VIOLATED',
        message: `forbidden tools were called: ${violated.join(', ')}`,
        observed: violated.join(','),
      });
      return 0;
    }
  }

  if (exp.expectedBlocked === true) {
    if (toolsUsed.length === 0) return 1;
    diagnostics.push({
      dim: 'toolAccuracy',
      severity: 'critical',
      code: 'EXPECTED_BLOCKED_BUT_RAN',
      message: 'expectedBlocked=true but tool calls were observed',
      observed: toolsUsed.length,
      expected: 0,
    });
    return 0;
  }

  if (exp.tools === undefined || exp.tools.length === 0) {
    // No tool expectations defined. Emit info diagnostic so scenario authors
    // can see which scenarios are leaving toolAccuracy unconstrained.
    // Only emit when mustNotCallTools and expectedBlocked are also absent —
    // those paths already define tool behavior explicitly.
    if (exp.mustNotCallTools === undefined && exp.expectedBlocked !== true) {
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'info',
        code: 'TOOL_EXPECTATIONS_UNDEFINED',
        message: 'scenario defines no tool expectations (tools[], mustNotCallTools, expectedBlocked); toolAccuracy not constrained — add expected tool calls to validate retrieval behavior',
      });
    }
    return 1;
  }
  const expected = exp.tools;
  const expectedNames = expected.map((t) => t.tool);
  const unmatchedCallsByTool = new Map<string, ToolCallTrace[]>();
  for (const call of toolsUsed) {
    const bucket = unmatchedCallsByTool.get(call.tool) ?? [];
    bucket.push(call);
    unmatchedCallsByTool.set(call.tool, bucket);
  }

  let matchedCount = 0;
  for (const expTool of expected) {
    const matchingCalls = unmatchedCallsByTool.get(expTool.tool) ?? [];
    if (matchingCalls.length === 0) {
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'warn',
        code: 'EXPECTED_TOOL_MISSING',
        message: `expected tool not called: ${expTool.tool}`,
      });
      continue;
    }
    const matchedIdx = matchingCalls.findIndex((call) => toolCallSatisfiesExpectation(call, expTool));
    if (matchedIdx === -1) {
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'warn',
        code: 'INPUT_CONTAINS_UNSATISFIED',
        message: `tool ${expTool.tool} called but inputContains unsatisfied`,
      });
      continue;
    }
    matchingCalls.splice(matchedIdx, 1);
    matchedCount++;
  }
  let score = matchedCount / expected.length;

  if (exp.ordered === true && matchedCount === expected.length) {
    const callOrder = toolsUsed.map((t) => t.tool);
    let cursor = 0;
    let inOrder = true;
    for (const expectedName of expectedNames) {
      const found = callOrder.indexOf(expectedName, cursor);
      if (found === -1) {
        inOrder = false;
        break;
      }
      cursor = found + 1;
    }
    if (!inOrder) {
      score *= PENALTY_TOOL_ORDER_VIOLATION;
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'warn',
        code: 'TOOL_ORDER_VIOLATION',
        message: 'expected tool order not respected',
      });
    }
  }

  const expectedSet = new Set(expectedNames);
  const extraCalls = toolsUsed.filter((t) => !expectedSet.has(t.tool)).length;
  if (extraCalls > 0) {
    const penalty = Math.min(PENALTY_EXTRA_TOOL_CAP, extraCalls * PENALTY_EXTRA_TOOL_PER_CALL);
    score *= 1 - penalty;
    diagnostics.push({
      dim: 'toolAccuracy',
      severity: 'warn',
      code: 'EXTRA_TOOL_CALLS',
      message: `${extraCalls} extra/wrong tool call(s) (penalty ${(penalty * 100).toFixed(0)}%)`,
      observed: extraCalls,
    });
  }

  // v4: continuous ratio penalty replaces hard `> 2x AND > 2` cliff.
  // The old threshold had a discontinuity: expectedReps=1, actualReps=2 → no penalty;
  // actualReps=3 → sudden 30% penalty. The continuous model gives smooth degradation:
  //   penalty = max(expectedReps / actualReps, PENALTY_TOOL_DUPLICATE)
  // This caps at PENALTY_TOOL_DUPLICATE (0.7) for extreme duplication but gives
  // graduated penalties for mild over-calling (e.g., 5 expected, 6 actual → 0.83).
  // O(N) via pre-built Maps instead of O(N²) filter-per-tool.
  const expectedCounts = new Map<string, number>();
  for (const e of expected) {
    expectedCounts.set(e.tool, (expectedCounts.get(e.tool) ?? 0) + 1);
  }
  const actualCallsByTool = new Map<string, ToolCallTrace[]>();
  for (const t of toolsUsed) {
    const calls = actualCallsByTool.get(t.tool) ?? [];
    calls.push(t);
    actualCallsByTool.set(t.tool, calls);
  }
  for (const [tool, expReps] of expectedCounts) {
    const actualCalls = actualCallsByTool.get(tool) ?? [];
    const actReps =
      DISCOVERY_SEARCH_TOOLS.has(tool) && expReps === 1 && isDiscoveryPartitionBatch(actualCalls)
        ? expReps
        : countSemanticToolInvocations(actualCalls);
    if (actReps > expReps) {
      const ratio = expReps / actReps; // 0 < ratio < 1
      const penalty = Math.max(ratio, PENALTY_TOOL_DUPLICATE);
      score *= penalty;
      diagnostics.push({
        dim: 'toolAccuracy',
        severity: 'warn',
        code: 'TOOL_DUPLICATE_CALLS',
        message: `tool ${tool} called ${actualCalls.length}x (${actReps} semantic invocation(s), expected ${expReps}x, penalty ${((1 - penalty) * 100).toFixed(0)}%)`,
        observed: actReps,
        expected: expReps,
      });
    }
  }

  return clamp01(score);
}
