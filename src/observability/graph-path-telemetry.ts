/**
 * Wave F4: unified graph-path observability.
 *
 * Before this module existed, ops could see the downstream effects of the
 * graph-aware readers (bundle-selector fail-closed counters, budget-ledger
 * reservations, retrieval-critic retries) but there was no single counter
 * set that answered "what fraction of production traffic actually exercised
 * the graph path, and why did the remainder fall back to flat?".
 *
 * Every graph-aware reader that the 7-PR constraint-graph train touched
 * now increments this module exactly once per invocation with:
 *
 *   - `reader`: WHICH reader made the decision (one of seven enumerated
 *     names; typo-proof via the discriminated union below).
 *   - `outcome`: one of FIVE mutually exclusive outcomes explaining
 *     whether the graph path engaged and — if not — why it fell back.
 *
 * The shape is a module-scoped `Map<reader, Record<outcome, number>>`
 * pure accumulator. No per-request state leaks across requests because
 * there is no mutable per-request shared state — only monotonic counters.
 *
 * **Hot-path budget:** one Map `get`, one arithmetic increment, one Map
 * `set`. No allocations per record beyond what V8 already shares. The
 * module is designed to be called from `evaluateHardConstraints` /
 * `computeSoftConstraint` — which execute per candidate — without
 * showing up in ranking profiles.
 *
 * **Failure mode:** unknown outcomes trip an exhaustiveness check at
 * compile time (discriminated union on `GraphPathOutcome`) and throw at
 * runtime inside `recordGraphPathDecision`. We do NOT silently swallow
 * unknown outcomes — operators need to trust the totals.
 *
 * @see docs/adr/019-graph-path-telemetry.md
 */

/**
 * Mutually exclusive descriptions of the graph-path decision each reader
 * makes on a single invocation. The ordering here mirrors the ADR-019
 * taxonomy:
 *
 *   1. `graph_aware_trivial`     — `compiled.constraintGraph` present with
 *                                  `origin='deterministic_from_atoms'`. The
 *                                  graph was emitted deterministically from
 *                                  the plan atoms (Phase 1a path). No LLM
 *                                  topology layer engaged.
 *   2. `graph_aware_planner`     — graph present with `origin='planner_emitted'`
 *                                  (ADR-012 Phase 1b.2 deterministic planner).
 *   3. `graph_aware_hybrid`      — graph present with `origin='hybrid'` (the
 *                                  LLM topology layer merged with the trivial
 *                                  projection).
 *   4. `flat_fallback_no_graph`  — `compiled.constraintGraph === undefined`.
 *                                  Either the planner produced no graph for
 *                                  this query shape, or an earlier stage
 *                                  discarded it.
 *   5. `flat_fallback_flag_off`  — graph emission disabled by
 *                                  `CONSTRAINT_GRAPH_EMIT=false`.
 */
export type GraphPathOutcome =
  | 'graph_aware_trivial'
  | 'graph_aware_planner'
  | 'graph_aware_hybrid'
  | 'flat_fallback_no_graph'
  | 'flat_fallback_flag_off';

/**
 * Every graph-aware reader that must call `recordGraphPathDecision`. The
 * union is exhaustive — adding a new reader requires adding it here AND
 * to the allow-list in
 * `test/regression/constraint-graph-readers-unchanged.regression.test.ts`.
 */
export type GraphPathReader =
  | 'provenance_closure'
  | 'decision_input'
  | 'ranker_hard_gate'
  | 'ranker_soft_weight'
  | 'pre_rank_coverage'
  | 'graph_executor'
  | 'bundle_selector';

export interface GraphPathDecision {
  readonly reader: GraphPathReader;
  readonly outcome: GraphPathOutcome;
  readonly requestId?: string;
}

const OUTCOMES: readonly GraphPathOutcome[] = [
  'graph_aware_trivial',
  'graph_aware_planner',
  'graph_aware_hybrid',
  'flat_fallback_no_graph',
  'flat_fallback_flag_off',
] as const;

const READERS: readonly GraphPathReader[] = [
  'provenance_closure',
  'decision_input',
  'ranker_hard_gate',
  'ranker_soft_weight',
  'pre_rank_coverage',
  'graph_executor',
  'bundle_selector',
] as const;

function zeroOutcomeRecord(): Record<GraphPathOutcome, number> {
  const out = {} as Record<GraphPathOutcome, number>;
  for (const o of OUTCOMES) out[o] = 0;
  return out;
}

/**
 * Module-scoped accumulator. Kept private so every mutation flows through
 * {@link recordGraphPathDecision}; snapshot / reset helpers below expose
 * frozen views for operators + tests.
 */
const perReaderCounts = new Map<GraphPathReader, Record<GraphPathOutcome, number>>();

function getOrInitReaderBucket(
  reader: GraphPathReader,
): Record<GraphPathOutcome, number> {
  let bucket = perReaderCounts.get(reader);
  if (bucket === undefined) {
    bucket = zeroOutcomeRecord();
    perReaderCounts.set(reader, bucket);
  }
  return bucket;
}

/**
 * Records a single graph-path decision. Exactly one call per reader
 * invocation — the reader is responsible for choosing the outcome label
 * before the telemetry call so we never record the same decision twice.
 *
 * Throws on:
 *   - unknown `reader` (not in {@link READERS})
 *   - unknown `outcome` (not in {@link OUTCOMES})
 *
 * Both checks are belt-and-braces — the discriminated union already
 * rejects typos at compile time, but the runtime guards catch hand-rolled
 * `as` casts from tests or ETL scripts.
 */
export function recordGraphPathDecision(decision: GraphPathDecision): void {
  if (!READERS.includes(decision.reader)) {
    throw new Error(
      `recordGraphPathDecision: unknown reader "${decision.reader}"`,
    );
  }
  if (!OUTCOMES.includes(decision.outcome)) {
    throw new Error(
      `recordGraphPathDecision: unknown outcome "${decision.outcome}" `
      + `for reader "${decision.reader}"`,
    );
  }
  const bucket = getOrInitReaderBucket(decision.reader);
  bucket[decision.outcome] += 1;
}

export interface GraphPathCountersSnapshot {
  readonly byReader: Readonly<Record<string, Readonly<Record<GraphPathOutcome, number>>>>;
  readonly totalByOutcome: Readonly<Record<GraphPathOutcome, number>>;
}

/**
 * Returns a frozen view of the current counter state — safe to hand to
 * reporters, log fields, or test assertions. The per-reader buckets are
 * frozen copies, so mutating them after snapshot does not affect the
 * internal accumulator.
 */
export function snapshotGraphPathCounters(): GraphPathCountersSnapshot {
  const byReader: Record<string, Readonly<Record<GraphPathOutcome, number>>> = {};
  const totalByOutcome: Record<GraphPathOutcome, number> = zeroOutcomeRecord();

  for (const reader of READERS) {
    const bucket = perReaderCounts.get(reader);
    if (bucket === undefined) {
      byReader[reader] = Object.freeze(zeroOutcomeRecord());
      continue;
    }
    const copy = zeroOutcomeRecord();
    for (const o of OUTCOMES) {
      copy[o] = bucket[o];
      totalByOutcome[o] += bucket[o];
    }
    byReader[reader] = Object.freeze(copy);
  }
  return Object.freeze({
    byReader: Object.freeze(byReader),
    totalByOutcome: Object.freeze(totalByOutcome),
  });
}

/**
 * Test-only hook: zeroes every counter. Production code must NOT call
 * this — the counters are monotonic across requests and operators rely
 * on that invariant for baseline comparisons.
 */
export function resetGraphPathCounters(): void {
  perReaderCounts.clear();
}

// ─────────────────────────────────────────────────────────────────────
// Reader-side helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Convenience helper that inspects a (possibly-absent) ConstraintGraph
 * plus an environment flag and returns the matching outcome label.
 *
 * Readers that already have a local `graph.origin` branch can pass the
 * origin directly; readers that only know "graph present / absent" use
 * this helper to avoid duplicating the flag-off check. Both shapes land
 * on identical outcome labels so the counter totals remain consistent.
 */
export function classifyGraphPresence(input: {
  readonly graphPresent: boolean;
  readonly graphOrigin?: 'deterministic_from_atoms' | 'planner_emitted' | 'hybrid' | undefined;
  readonly graphEmitFlagOn: boolean;
}): GraphPathOutcome {
  if (!input.graphEmitFlagOn) return 'flat_fallback_flag_off';
  if (!input.graphPresent) return 'flat_fallback_no_graph';
  switch (input.graphOrigin) {
    case 'deterministic_from_atoms':
      return 'graph_aware_trivial';
    case 'planner_emitted':
      return 'graph_aware_planner';
    case 'hybrid':
      return 'graph_aware_hybrid';
    case undefined:
      // Graph is present but origin is unknown — the reader failed to
      // pass it. Treat as trivial (the deterministic path) rather than
      // crashing the hot path; the compile-time discriminated union
      // prevents this in practice.
      return 'graph_aware_trivial';
    default: {
      // Exhaustiveness check: every origin enum value must be handled.
      const _never: never = input.graphOrigin;
      return _never;
    }
  }
}
