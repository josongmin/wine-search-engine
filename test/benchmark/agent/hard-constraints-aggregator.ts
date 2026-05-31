/**
 * Per-scenario aggregator for planner-emitted hard constraints.
 *
 * Source of truth: each successful discovery-search / lookup tool call returns a
 * `SearchResponseV1` whose `parsedConstraints.hard` array enumerates the
 * planner's final hard-constraint set (rule-based direct hits + ontology
 * expansion + LLM-extracted hits, after the constraint compiler merges them).
 *
 * The bench insight rule `hard_constraints_low` (see
 * `benchmark-insight-generator.ts`) reads the SCENARIO MEAN of this count.
 *
 * Aggregation policy:
 *   - Sum across ALL search tool invocations within the scenario (multi-step
 *     agents may call search primitives more than once; we count every emission).
 *   - Tool outcomes whose result is not a SearchResponseV1 are ignored.
 *   - Missing `parsedConstraints` (older response shape) contributes 0.
 *
 * Why sum across calls instead of max-of-calls: the insight warning text
 * ("Retrieval is under-filtered") is about the total filter pressure the
 * agent's planner produced over the scenario lifetime, not the peak of a
 * single call. A scenario that emits two search calls each with 2 hard
 * constraints contributed more filter signal than one that called once with 3.
 *
 * Excluded by design:
 *   - `softConstraintCount` (soft constraints are a separate signal).
 *   - `inferred` constraints (those don't appear in `parsedConstraints.hard`).
 */
import type { ToolOutcome } from '../../../src/domain/agent/model/tool-outcome.js';
import type { SearchResponseV1 } from '../../../src/domain/response/model/search-response.js';

const SEARCH_TOOL_NAMES = new Set([
  'search_hybrid',
  'search_semantic',
  'search_lexical',
  'lookup_wine',
]);

function isSearchResponseV1(value: unknown): value is SearchResponseV1 {
  if (value === null || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return rec['queryType'] === 'search';
}

/**
 * Count the hard constraints emitted by a single tool outcome.
 *
 * Returns 0 when the outcome's result is not a SearchResponseV1, has no
 * `parsedConstraints`, or the constraint list is empty.
 */
export function countHardConstraintsForOutcome(outcome: ToolOutcome): number {
  // Skip non-search tools (defensive: search responses are only produced by
  // the enumerated search-family tools above). A non-search outcome whose
  // result happens to be shaped like a SearchResponseV1 still counts — the
  // structural check is the load-bearing guard.
  if (!SEARCH_TOOL_NAMES.has(outcome.tool)) return 0;
  if (!isSearchResponseV1(outcome.result)) return 0;
  const parsed = outcome.result.parsedConstraints;
  if (parsed === undefined) return 0;
  return parsed.hard.length;
}

/**
 * Per-scenario sum of planner-emitted hard constraints across every search
 * tool call in the scenario.
 *
 * Returns `null` when the scenario produced no tool outcomes at all (e.g.
 * knowledge-only or blocked scenarios). Returns `0` when the scenario ran
 * search tools but they all emitted zero hard constraints — that's a real
 * signal (under-filtered retrieval), not missing data.
 */
export function aggregateHardConstraintsForScenario(
  toolOutcomes: readonly ToolOutcome[] | undefined,
): number | null {
  if (toolOutcomes === undefined || toolOutcomes.length === 0) return null;
  let total = 0;
  let sawAnySearch = false;
  for (const outcome of toolOutcomes) {
    if (SEARCH_TOOL_NAMES.has(outcome.tool)) {
      sawAnySearch = true;
      total += countHardConstraintsForOutcome(outcome);
    }
  }
  return sawAnySearch ? total : null;
}

/**
 * Bench-summary mean: arithmetic mean of per-scenario hard-constraint sums,
 * over scenarios that have a non-null value. Scenarios with `null` (no
 * search calls / no measurement) are excluded from the denominator —
 * including them would silently bias the mean toward zero.
 *
 * Returns `0` when no scenario carries a non-null sample, so the summary
 * field is still numeric (the `BenchmarkReport.summary.meanHardConstraints`
 * contract is `number`, not `number | null`).
 */
export function meanHardConstraintsAcrossScenarios(
  perScenarioCounts: readonly (number | null | undefined)[],
): number {
  let sum = 0;
  let n = 0;
  for (const v of perScenarioCounts) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}
