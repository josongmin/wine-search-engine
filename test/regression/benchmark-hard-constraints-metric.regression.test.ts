/**
 * Regression: bench `hard_constraints_low` insight metric must reflect the
 * planner-emitted hard-constraint counts from search tool outcomes.
 *
 * Background:
 *   Through ~May 2026 the bench summary's `meanHardConstraints` was hard-coded
 *   to 0 with a TODO. This caused the `hard_constraints_low` insight rule
 *   (warn threshold 1.5) to fire on every run regardless of actual planner
 *   behavior, masking real signal and burning operator attention.
 *
 * The fix introduces `hard-constraints-aggregator.ts`, which:
 *   - Per scenario, sums `SearchResponseV1.parsedConstraints.hard.length`
 *     across every `ToolOutcome` whose `result` is a SearchResponseV1.
 *   - Returns `null` when no search tool ran (knowledge-only / blocked /
 *     fallback) — these scenarios are excluded from the bench-wide mean so
 *     the metric measures planner filter pressure, NOT the rate of
 *     search-issuing scenarios.
 *   - Returns `0` when search ran but the planner emitted zero hard
 *     constraints — that is a real "under-filtered retrieval" signal.
 *
 * Pins:
 *   - Per-scenario sum equals total hard constraints across all search calls.
 *   - 5-scenario batch mean equals arithmetic mean of non-null samples.
 *   - Non-search tool outcomes (e.g. `domain_knowledge_lookup`) are ignored.
 *   - Scenarios with `undefined` toolOutcomes yield `null` (excluded from mean).
 *   - Numeric-`0` scenarios participate in the mean and are NOT excluded.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateHardConstraintsForScenario,
  countHardConstraintsForOutcome,
  meanHardConstraintsAcrossScenarios,
} from '../benchmark/agent/hard-constraints-aggregator.js';
import type { ToolOutcome } from '../../src/domain/agent/model/tool-outcome.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

function makeSearchResponse(hardCount: number): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      kind: 'multi_match',
      reason: 'test',
    } as unknown as SearchResponseV1['engineDecision'],
    results: [],
    meta: { requestId: 'test', engineVersion: 'v1', durationMs: 1 } as unknown as SearchResponseV1['meta'],
    parsedConstraints: {
      hard: Array.from({ length: hardCount }, (_, i) => ({
        field: `field_${i}`,
        op: 'eq',
        value: `value_${i}`,
      })),
      soft: [],
      unparsed: [],
    },
  };
}

function makeSearchOutcome(hardCount: number, tool: string = 'search_hybrid'): ToolOutcome {
  return {
    stepId: `step-${tool}-${hardCount}`,
    tool,
    kind: 'success',
    result: makeSearchResponse(hardCount),
    durationMs: 10,
  };
}

describe('Bench hard-constraints metric — planner-emitted aggregation', () => {
  it('R-BENCH-HC-01: a single search tool call surfaces parsedConstraints.hard.length verbatim', () => {
    const outcome = makeSearchOutcome(2);
    expect(countHardConstraintsForOutcome(outcome)).toBe(2);
  });

  it('R-BENCH-HC-02: per-scenario sum aggregates ALL search outcomes (direct + ontology-expanded combined)', () => {
    // Mirrors the user-described shape: a scenario whose planner emitted
    // directHardConstraintCount=2 + ontologyExpandedConstraintCount=1 ends up
    // with 3 hard constraints in the compiled SearchResponseV1 — and the
    // bench aggregator must surface 3, not 2.
    const outcomes: ToolOutcome[] = [makeSearchOutcome(3)];
    expect(aggregateHardConstraintsForScenario(outcomes)).toBe(3);
  });

  it('R-BENCH-HC-03: multi-step scenarios SUM hard constraints across every search call', () => {
    const outcomes: ToolOutcome[] = [
      makeSearchOutcome(2), // first search: 2 hard constraints
      makeSearchOutcome(1), // refined search: 1 hard constraint
    ];
    expect(aggregateHardConstraintsForScenario(outcomes)).toBe(3);
  });

  it('R-BENCH-HC-04: non-search tool outcomes are ignored', () => {
    const outcomes: ToolOutcome[] = [
      {
        stepId: 'knowledge-step',
        tool: 'domain_knowledge_lookup',
        kind: 'success',
        result: { some: 'knowledge_payload' },
        durationMs: 5,
      },
      makeSearchOutcome(2),
    ];
    expect(aggregateHardConstraintsForScenario(outcomes)).toBe(2);
  });

  it('R-BENCH-HC-05: scenarios with NO search outcomes return null (excluded from bench mean)', () => {
    const outcomes: ToolOutcome[] = [
      {
        stepId: 'knowledge-only',
        tool: 'domain_knowledge_lookup',
        kind: 'success',
        result: { some: 'knowledge_payload' },
        durationMs: 5,
      },
    ];
    expect(aggregateHardConstraintsForScenario(outcomes)).toBeNull();
  });

  it('R-BENCH-HC-06: undefined toolOutcomes → null (knowledge-only / blocked scenarios)', () => {
    expect(aggregateHardConstraintsForScenario(undefined)).toBeNull();
  });

  it('R-BENCH-HC-07: empty toolOutcomes array → null', () => {
    expect(aggregateHardConstraintsForScenario([])).toBeNull();
  });

  it('R-BENCH-HC-08: search outcome with zero hard constraints → 0 (real signal, NOT null)', () => {
    // This is the load-bearing distinction: a scenario that issued a search
    // but whose planner emitted ZERO hard constraints is exactly what the
    // `hard_constraints_low` insight is meant to catch. It MUST contribute 0
    // to the mean, not be silently excluded.
    expect(aggregateHardConstraintsForScenario([makeSearchOutcome(0)])).toBe(0);
  });

  it('R-BENCH-HC-09: search outcome with parsedConstraints absent → 0', () => {
    const responseWithoutParsed = {
      queryType: 'search' as const,
      engineDecision: {} as unknown as SearchResponseV1['engineDecision'],
      results: [],
      meta: {} as unknown as SearchResponseV1['meta'],
    };
    const outcome: ToolOutcome = {
      stepId: 'no-parsed',
      tool: 'search_hybrid',
      kind: 'success',
      result: responseWithoutParsed,
      durationMs: 5,
    };
    expect(countHardConstraintsForOutcome(outcome)).toBe(0);
  });

  it('R-BENCH-HC-10: outcome whose result is not a SearchResponseV1 (queryType mismatch) → 0', () => {
    const outcome: ToolOutcome = {
      stepId: 'bad-shape',
      tool: 'search_hybrid',
      kind: 'success',
      result: { queryType: 'comparison', foo: 'bar' },
      durationMs: 5,
    };
    expect(countHardConstraintsForOutcome(outcome)).toBe(0);
  });

  it('R-BENCH-HC-11: 5-scenario batch mean equals arithmetic mean of non-null samples', () => {
    // Synthetic batch:
    //  - scenario A: search outcomes with hard=2 — contributes 2
    //  - scenario B: search outcomes with hard=3+1=4 (two calls) — contributes 4
    //  - scenario C: search outcome with hard=0 — contributes 0 (still counted)
    //  - scenario D: no toolOutcomes (knowledge-only) — null, excluded
    //  - scenario E: search outcome with hard=6 — contributes 6
    //
    // Expected mean over {2, 4, 0, 6} = 12 / 4 = 3.
    const a = aggregateHardConstraintsForScenario([makeSearchOutcome(2)]);
    const b = aggregateHardConstraintsForScenario([makeSearchOutcome(3), makeSearchOutcome(1)]);
    const c = aggregateHardConstraintsForScenario([makeSearchOutcome(0)]);
    const d = aggregateHardConstraintsForScenario(undefined);
    const e = aggregateHardConstraintsForScenario([makeSearchOutcome(6)]);

    expect(a).toBe(2);
    expect(b).toBe(4);
    expect(c).toBe(0);
    expect(d).toBeNull();
    expect(e).toBe(6);

    const mean = meanHardConstraintsAcrossScenarios([a, b, c, d, e]);
    expect(mean).toBe(3);
  });

  it('R-BENCH-HC-12: batch with all-null samples returns 0 (not NaN — must remain numeric)', () => {
    // The BenchmarkReport.summary.meanHardConstraints contract is `number`,
    // NOT `number | null`. When zero scenarios produced a non-null sample we
    // surface 0, not NaN — NaN would crash the insight rule's
    // `r.meanHardConstraints.toFixed(2)` call.
    const mean = meanHardConstraintsAcrossScenarios([null, null, undefined]);
    expect(Number.isFinite(mean)).toBe(true);
    expect(mean).toBe(0);
  });

  it('R-BENCH-HC-13: undefined and NaN samples are excluded from the mean', () => {
    // Defensive: never let a corrupted upstream value poison the mean.
    const mean = meanHardConstraintsAcrossScenarios([2, undefined, Number.NaN, 4]);
    expect(mean).toBe(3); // (2 + 4) / 2
  });

  it('R-BENCH-HC-14: italian-red Korean colloquial query shape — 2 hard constraints surfaces as 2, not 0', () => {
    // Acceptance test for the original symptom: "이탈리아 레드 평점 좋은" SHOULD
    // emit at least country=Italy + wine_type=red, so the per-scenario sum
    // must be ≥2 and the bench mean for a single-scenario batch must reflect
    // that — proving the metric is no longer hard-coded to zero.
    const koreanItalianRed = makeSearchOutcome(2);
    const sum = aggregateHardConstraintsForScenario([koreanItalianRed]);
    expect(sum).toBe(2);
    expect(meanHardConstraintsAcrossScenarios([sum])).toBe(2);
  });
});
