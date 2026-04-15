# ADR-013: ConstraintGraph Phase 1c — BundleSelector + Graph-Aware Executor

## Status: Proposed — 2026-04-15

Phase 1c / Axis 1.5 of the
[2026-04-15 improvement plan](../plans/2026-04-15-improvement.md).
Rides on top of:
- [ADR-010](./010-constraint-graph-phase-1a.md) — graph type + deterministic projector
- [ADR-011](./011-constraint-graph-phase-1b-first-reader.md) — first graph readers
- [ADR-012](./012-constraint-graph-phase-1b2-topology-planner.md) — LLM topology planner
- [ADR-014](./014-ranker-graph-native.md) — ranker + retrieval annotator graph-native

Phase 1c closes the P1-C blocker: when the LLM topology planner emits a
multi-subquery graph (e.g. "3-course pairing, shared ₩150k budget"),
the retrieval pool returns a *flat* candidate list and the ranker treats
it as a single pool. Cross-slot assignment structure is silently
dropped — two great reds plus two great whites rank as four reds
because reds dominate the scoring. There is no mechanism to *pick one
candidate per subquery slot under shared budget*.

## Context

After ADR-012 the compiler can emit `constraintGraph.origin='hybrid'`
graphs with `SubqueryNode`s and `shares_budget` edges. After ADR-014 the
ranker and annotator read the graph natively. What still fails:

1. There is no per-subquery candidate pool. `candidatePool.execute()`
   returns one fused list keyed to the root query only.
2. Shared-budget edges are descriptive — no stage enforces them.
3. `BudgetLedger.reserve` (where it exists / future P1-C fix) fires
   *pre-rank* on every candidate, so unselected candidates burn budget
   that should have been returned to the slot they lost.
4. `RankedResult` is a single-candidate type. There is no carrier for a
   *bundle* of ranked results split across subqueries with a shared
   bundle score and shared-budget telemetry.

Phase 1c introduces:

- An **exact** assignment solver (K≤5) that picks one candidate per
  subquery slot optimising the bundle score subject to `shares_budget`
  side conditions.
- A **BundleSelector** orchestrator: `(graph, candidatesBySubquery)` →
  `AssignmentSolution { assignments, bundleScore, budgetUsage,
  degradationReasons, tieBreakReason }`.
- A **graph-aware executor** that wraps `candidatePool.execute`. Trivial
  graphs (single subquery, or no `shares_budget`) pass through
  byte-identically. Hybrid multi-subquery graphs engage the bundle
  path.
- A new **`BundleRankedResult`** model that composes `RankedResult[]`
  across subqueries with carrier fields for `subqueryId`, `bundleId`,
  `sharedBudgetUsage`.
- Telemetry counter `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT`
  — any non-zero value signals that the P1-C fix has regressed
  (unselected candidates have reserved budget).

## Decision

### 1. K≤5 exact solver, K>5 fail closed

`K` is the number of `SubqueryNode`s in the graph. The exact
Hungarian-style algorithm is `O(K^3)` with a `2^K`-subset pass for the
shared-budget side condition (K=5 is ~120 solver invocations total,
cheap enough for the online path). `K>5` returns:

```
{ solved: false, reason: 'bundle_selector_fail_closed:k_exceeds_exact_limit' }
```

Consistent with the CLAUDE.md heuristic policy: we do **not** silently
fall back to greedy assignment. If real traffic produces K>5 (tracked
via telemetry), we explicitly author an ADR amendment approving either
(a) higher K with explicit factorial cost or (b) a greedy-approximate
solver with an explicit approximation-quality acceptance target.

### 2. Budget as cost-matrix penalty, not post-hoc filter

The Hungarian solver minimises the sum of per-cell costs. Shared
budgets are encoded as a subset-sum side condition: the solver
enumerates the `2^K` subsets of subqueries covered by a given
`shares_budget` edge and, for each enumerated subset, penalises
assignments whose aggregated price exceeds the budget with a large
additive penalty (`BUDGET_OVERFLOW_PENALTY`) proportional to the
overflow. The optimum is therefore the optimum under the soft
constraint; a hard-infeasible input (e.g. cheapest 2-wine assignment
still exceeds ₩150k) surfaces as a fail-closed with reason
`budget_infeasible_under_penalty` rather than a silent best-effort
result.

### 3. Ranked-result carrier contract — Option A: separate type

We considered two designs:

- **Option A (chosen)**: keep `RankedResult` as the single-candidate
  type; introduce `BundleRankedResult` as a distinct type that
  *composes* `RankedResult[]` with bundle-scoped metadata
  (`subqueryId`, `bundleId`, `sharedBudgetUsage`).
- Option B: extend `RankedResult` with optional `subqueryId` and
  `bundleId` fields. Consumers discriminate by presence.

Option A wins because:
- Binary-separable consumers. Downstream code (response builder, claim
  emitter, explainer) that does not handle bundles never sees a
  bundle type. Zero drift risk on legacy read-paths.
- Explicit carrier. `sharedBudgetUsage` has nowhere natural to live on
  `RankedResult`; stuffing it there would leak selector concerns into
  the single-candidate model.
- Type narrowing by shape, not by sentinel field. `BundleRankedResult[]`
  vs `RankedResult[]` is a discrimination on the collection type, not
  a per-element undefined check.

A `BundleRankedResult` contains (schema: [`bundle-ranked-result.ts`](../../src/domain/response/model/bundle-ranked-result.ts)):

```ts
interface BundleRankedResult {
  readonly subqueryId: string;
  readonly bundleId: string;
  readonly ranked: RankedResult;
  readonly sharedBudgetUsage?: readonly {
    readonly resource: 'price_total' | 'time' | 'count';
    readonly currency?: 'KRW' | 'USD';
    readonly used: number;
    readonly max: number;
  }[];
}
```

### 4. BudgetLedger lifecycle move — pre-rank → post-assignment

The P1-C fix: callers no longer invoke `BudgetLedger.reserve(...)`
pre-rank. The graph-aware executor invokes it only for the candidates
that *win* a subquery slot after `chooseAssignment` returns. This is
not an API change on `BudgetLedger` itself — only the call-site moves.
Telemetry counter `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT`
is incremented if any caller attempts to reserve a candidate that is
not in the final assignment; the counter must remain 0 across every
bench scenario.

The BudgetLedger itself is not instantiated in the repository at HEAD
of PR4 — the P1-C fix is therefore *pre-emptive*: the call-site
convention is enforced in the executor rather than in a concrete
ledger. When the ledger lands as a concrete service, its implementation
will read the same counter contract, no further change required.

### 5. Trivial-graph pass-through parity

The graph-aware executor is a *strict* superset of the legacy
pass-through. For any `graph` where either:
- `graph === undefined` (flag `CONSTRAINT_GRAPH_EMIT=false`), or
- `graph.origin === 'deterministic_from_atoms'`, or
- `graphSubqueryNodes(graph).length <= 1`

the executor MUST delegate directly to `candidatePool.execute`/`generate`
without any translation. A regression test
([`graph-executor-passthrough.regression.test.ts`](../../test/regression/graph-executor-passthrough.regression.test.ts))
locks byte-identical output.

### 6. Feature flag: `BUNDLE_SELECTOR_ENABLED`

Env-var pattern matching `CONSTRAINT_GRAPH_EMIT` / `CONSTRAINT_GRAPH_TOPOLOGY_LLM`.
Default **off**. One-nightly shadow recommended before production flip.
When off, the executor takes the pass-through branch unconditionally
(byte-identical to pre-PR4).

## Fail-closed catalogue

| Reason | Trigger | Counter |
|---|---|---|
| `bundle_selector_fail_closed:k_exceeds_exact_limit` | K>5 subquery nodes | `BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT` |
| `bundle_selector_fail_closed:budget_infeasible` | Minimum cost assignment exceeds a `shares_budget` ceiling | `BUNDLE_SELECTOR_BUDGET_INFEASIBLE_COUNT` |
| `bundle_selector_fail_closed:empty_slot_pool` | A subquery has zero candidates | `BUNDLE_SELECTOR_EMPTY_SLOT_POOL_COUNT` |

All three return `{ assignments: [], bundleScore: 0, degradationReasons: [<reason>] }`
and the graph executor degrades to the pass-through output for the
surrounding query (the user sees a flat result list plus a
`routeDegradation` entry, not a hard error).

## Rollback

Three levels:

1. `BUNDLE_SELECTOR_ENABLED=false` — executor pass-through
   unconditionally. Byte-identical to pre-PR4.
2. `CONSTRAINT_GRAPH_TOPOLOGY_LLM=false` — no hybrid graphs. Selector
   never engages even with the flag on.
3. `CONSTRAINT_GRAPH_EMIT=false` — pre-ADR-010 flat behaviour.

## Consequences

- +1 service + 1 solver in `src/domain/retrieval/service/`.
- +1 executor wrapper in `src/application/search/`.
- +1 carrier model in `src/domain/response/model/`.
- 3 new telemetry counters.
- Reader allow-list expands to include the new files.
- Trivial-graph parity locked by regression; hybrid-graph behaviour is
  new territory gated on the flag until a nightly shadow compares clean.
