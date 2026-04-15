# PR4 — ADR-013 Phase 1c: BundleSelector + graph-aware executor

> **Scope envelope**: introduce a **subquery-to-candidate assignment
> stage** (Hungarian-style exact solver for K≤5) between per-subquery
> retrieval and the ranker, wrap `candidatePool.execute` in a graph-aware
> executor, and move `BudgetLedger.reserve` from pre-rank to
> post-assignment. Trivial graphs are pass-through; hybrid graphs with
> `subqueries.length > 1` take the new path.
>
> **Parent plan**: [2026-04-15-improvement.md](../2026-04-15-improvement.md)
> Axis 1.5 / Phase 1c. **Upstream**: [ADR-010](../../adr/010-constraint-graph-phase-1a.md),
> [ADR-012](../../adr/012-constraint-graph-phase-1b2-topology-planner.md).
> **This PR drafts ADR-013**.
>
> **Anchor commit**: PR3 (ADR-012) HEAD. **Hard dependency** — trivial
> graphs have no subquery nodes, so without 1b.2 the selector has
> nothing to assign.

---

## 1. Why this PR

Once the topology planner (PR3) emits multi-subquery graphs (e.g.
"meat course red + fish course white, shared ₩150k budget"), the
retrieval pool returns a flat candidate list that the ranker treats as
one pool. This drops the cross-slot assignment structure silently —
two great reds + two great whites rank as four reds because reds dominate
the scoring.

Phase 1c introduces:
- Per-subquery candidate pools (one pool per subquery node).
- An **exact** assignment solver (K≤5) that picks one candidate per
  subquery slot optimizing the bundle score subject to shared budgets.
- A graph-aware executor wrapper that pass-through for trivial graphs
  and engages the assignment path for hybrid graphs with >1 subquery.
- Relocation of `BudgetLedger.reserve` from pre-rank to
  post-assignment (the P1-C fix — previously, unselected candidates'
  reserved budget leaked).

**Explicit non-scope**:
- Ranker gate rewrite — PR5 (ADR-014).
- Retrieval critic — PR6 (ADR-015).
- Grounded claims — PR7 (ADR-016).
- Heuristic solver for K>5 — **explicitly deferred** per CLAUDE.md rule
  (no heuristic shortcuts without explicit user approval). K>5 returns
  `fail_closed` with `degradationReasons=['bundle_selector_k_exceeds_exact_limit']`.

---

## 2. File-by-file change checklist

### 2.1 New files

| File | Purpose |
|------|---------|
| [docs/adr/013-bundle-selector-graph-aware-executor.md](../../adr/013-bundle-selector-graph-aware-executor.md) | New ADR: problem statement, assignment-vs-ranking contract, K≤5 exact / K>5 fail-closed policy, budget-ledger relocation rationale, ranked-result contract decision (option A — `BundleRankedResult extends RankedResult`). |
| [src/domain/retrieval/service/bundle-selector.ts](../../../src/domain/retrieval/service/bundle-selector.ts) | `chooseAssignment(graph, candidatesBySubquery, opts): AssignmentSolution`. Inputs: `ConstraintGraph`, `Map<SubqueryId, readonly Candidate[]>`, opts include `budgetLedger`. Output: `AssignmentSolution { assignments, bundleScore, budgetUsage, degradationReasons, tieBreakReason }`. |
| [src/domain/retrieval/service/assignment-solver.ts](../../../src/domain/retrieval/service/assignment-solver.ts) | Pure exact Hungarian-style solver. `const K_EXACT_LIMIT = 5` at module scope. K>5 → returns `{ solved: false, reason: 'bundle_selector_k_exceeds_exact_limit' }`. No heuristic branch. Handles shared-budget constraint as a linear-programming side condition in the cost matrix. |
| [src/application/search/search-usecase-graph-executor.ts](../../../src/application/search/search-usecase-graph-executor.ts) | Wraps `ports.candidatePool.execute`. For `graph?.origin === 'trivial'` or `graph.nodes.filter(isSubqueryNode).length <= 1` → direct pass-through to existing executor path. For hybrid multi-subquery → per-subquery retrieval → `chooseAssignment` → emit `BundleRankedResult[]`. |
| [src/domain/response/model/bundle-ranked-result.ts](../../../src/domain/response/model/bundle-ranked-result.ts) | `interface BundleRankedResult extends RankedResult` adds `subqueryId: string`, `bundleId: string`, `sharedBudgetUsage?: readonly { currency; used; max }[]`. Zod schema with `.strict()`. |
| [test/benchmark/agent/scenarios.bundle.ts](../../../test/benchmark/agent/scenarios.bundle.ts) | **3 new bundle bench scenarios**: (1) 3-way pairing (appetizer/main/dessert each with its own wine), (2) XOR red-or-white ("취향에 따라 레드 또는 화이트"), (3) shared-price-budget gift set (two wines, total ≤₩150k). |
| [test/regression/bundle-selector-exact-solver.regression.test.ts](../../../test/regression/bundle-selector-exact-solver.regression.test.ts) | ~10 cases. See §3. |
| [test/regression/graph-executor-passthrough.regression.test.ts](../../../test/regression/graph-executor-passthrough.regression.test.ts) | Trivial graph → direct pass-through, byte-identical to pre-PR executor output. Hybrid single-subquery → also pass-through. |
| [test/regression/bundle-selector-budget-ledger-relocation.regression.test.ts](../../../test/regression/bundle-selector-budget-ledger-relocation.regression.test.ts) | Locks the P1-C fix: pre-rank `BudgetLedger.reserve` call count is 0; post-assignment call count equals `assignments.length`. Telemetry counter `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT` is 0 on all bench scenarios. |

### 2.2 Modified files

| File | Change |
|------|--------|
| [src/domain/retrieval/service/budget-ledger.ts](../../../src/domain/retrieval/service/budget-ledger.ts) | No API change. Lifecycle migration only: callers no longer invoke `reserve` pre-rank. Method unchanged but callers drop the pre-rank call-site. |
| [src/application/search/search-usecase-hybrid-candidates.ts](../../../src/application/search/search-usecase-hybrid-candidates.ts#L499) | At [line 499](../../../src/application/search/search-usecase-hybrid-candidates.ts#L499) (pre-candidate-pool.execute area): route through `search-usecase-graph-executor.ts` rather than calling `ports.candidatePool.execute` directly. Single-line delegation. |
| [src/config/feature-flags.ts](../../../src/config/feature-flags.ts) | Add `BUNDLE_SELECTOR_ENABLED` flag (default off; one-nightly shadow then flip). |
| [src/config/composition-root.ts](../../../src/config/composition-root.ts) | Instantiate `BundleSelector` + `GraphExecutor`; inject into hybrid-candidates use-case. |
| [src/observability/silent-skip-counters.ts](../../../src/observability/silent-skip-counters.ts) | Add `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT`, `BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT` counters. |

### 2.3 Files I explicitly do NOT touch

- [src/domain/ranking/service/signal-computer.ts](../../../src/domain/ranking/service/signal-computer.ts#L168) — PR5.
- [src/domain/ranking/service/ranker.ts](../../../src/domain/ranking/service/ranker.ts#L629) — PR5.
- [src/domain/retrieval/service/candidate-pool.ts](../../../src/domain/retrieval/service/candidate-pool.ts#L728) annotator — PR5.
- [src/domain/agent/service/step-budget.ts](../../../src/domain/agent/service/step-budget.ts) — agent-layer guard, out of scope.

---

## 3. Test additions

| Test file | Cases | Locks |
|-----------|-------|-------|
| [test/regression/bundle-selector-exact-solver.regression.test.ts](../../../test/regression/bundle-selector-exact-solver.regression.test.ts) | ~10 | Empty input → empty assignment; K=1 → trivial one-slot one-candidate; K=2 → optimal 2x2 matching; K=5 → optimal 5x5 matching (worst-case exact); K=6 → fail-closed with `bundle_selector_k_exceeds_exact_limit`; shared-budget binding (optimum forced to cheaper pair); shared-budget non-binding (optimum identical to unconstrained); tie-breaking deterministic (by entityId); assignment preserves `subqueryId` mapping; solver is pure (same input → same output across 100 calls). |
| [test/regression/graph-executor-passthrough.regression.test.ts](../../../test/regression/graph-executor-passthrough.regression.test.ts) | ~4 | Trivial graph → direct pass-through; hybrid 1-subquery → pass-through; hybrid 2-subquery → bundle path; no-graph (`CONSTRAINT_GRAPH_EMIT=false`) → pass-through. |
| [test/regression/bundle-selector-budget-ledger-relocation.regression.test.ts](../../../test/regression/bundle-selector-budget-ledger-relocation.regression.test.ts) | ~3 | Pre-rank `reserve` count is 0 under bundle path; post-assignment count equals `assignments.length`; unselected candidates do not reserve. Telemetry counter `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT == 0`. |
| [test/benchmark/agent/scenarios.bundle.ts](../../../test/benchmark/agent/scenarios.bundle.ts) | 3 | 3-way pairing; XOR red-or-white; shared-price-budget gift set. Targets: `scrInferred ≥ 80%`, `csrInferred ≥ 70%`. |

---

## 4. Call-graph sanity checks (pre-coding)

- [ ] Confirm `candidatePool.execute` signature at [candidate-pool.ts:728](../../../src/domain/retrieval/service/candidate-pool.ts#L728) — the executor wrapper must match its input/output so the trivial pass-through is a direct delegate, not a translation shim.
- [ ] Grep `BudgetLedger.reserve(` call-sites. Expected: pre-rank reserve lives in one place (the hybrid-candidates use-case). If it's called from multiple places, each must be audited.
- [ ] Confirm `isSubqueryNode` helper is available on `ConstraintGraph` (likely needs adding — node has a `kind` discriminator in [constraint-graph.ts](../../../src/domain/query/model/constraint-graph.ts)).
- [ ] Bench harness can pass `constraintGraph` from a scenario's compiled query into the executor — verify via one smoke scenario.
- [ ] Confirm `RankedResult` type location and whether `BundleRankedResult` can extend without touching downstream consumers that discriminate on type.
- [ ] `K_EXACT_LIMIT = 5`: verify no bench scenario currently has >5 subqueries. If found, the ADR must document it or scope creep.

---

## 5. Cutover gate

All items green before commit:

1. **3 new bundle scenarios pass** with `scrInferred ≥ 80%`, `csrInferred ≥ 70%` on `situation_based + extreme` category.
2. **Solver regression**: 10 new cases green; K>5 fail-closed never fires on bench (if it does, scope creep — document and re-scope).
3. **Telemetry**: `BUNDLE_SELECTOR_BUDGET_UNSELECTED_RESERVED_COUNT == 0` across all bench scenarios.
4. **Shadow-mode**: one nightly run with `BUNDLE_SELECTOR_ENABLED=true` in shadow emission only (no user-visible traffic affected); compare against flag-off run for unexpected divergence.
5. **Trivial-graph parity preserved**: hybrid-candidates.ts:499 path with `BUNDLE_SELECTOR_ENABLED=false` is byte-identical to pre-PR4.
6. **`pnpm run git:prepush` green**.

---

## 6. Risks & mitigations

### Risk 1 — BudgetLedger relocation is a behavioural change
Moving `reserve` from pre-rank to post-assignment means candidates that
were previously excluded by pre-rank budget pressure may now survive
into the ranker.

**Mitigation**: shadow-mode flag for one nightly; compare result sets.
Telemetry counter tracks any candidate that would have been
pre-rank-reserved under the old path. Regression test locks the new
ordering.

### Risk 2 — K>5 fail-closed hits in production
If a real user query produces >5 subqueries (e.g. an ambitious
7-course pairing), the executor returns fail-closed and the user
sees a degradation.

**Mitigation**: telemetry counter `BUNDLE_SELECTOR_K_EXCEEDS_EXACT_LIMIT_COUNT`
tracks occurrences. If non-zero on one nightly of real traffic, we
either bump K (and pay the 2^K factorial cost explicitly) OR explicitly
approve a greedy heuristic via a new ADR per CLAUDE.md rule. Do **not**
silently ship a heuristic now.

### Risk 3 — Hungarian-style solver correctness
Exact 5x5 assignment is textbook but easy to mis-implement around the
shared-budget side condition.

**Mitigation**: encode shared budgets as penalty cells in the cost
matrix with a unit test that brute-forces 5! = 120 permutations on a
small instance and compares to solver output. Non-trivial — budget
the engineering time.

### Risk 4 — BundleRankedResult downstream consumers
Response builder, claim emitter, explainer all consume `RankedResult[]`.
`BundleRankedResult extends RankedResult` is binary compatible but
consumers that discriminate by shape may break.

**Mitigation**: consumers use a duck-type check on `subqueryId` field.
No type narrowing by `instanceof`. Regression test on a consumer
(e.g. response builder) with a `BundleRankedResult[]` input.

### Risk 5 — Tie-breaking non-determinism
When multiple assignments yield identical `bundleScore`, non-deterministic
picks break replay.

**Mitigation**: tie-break by sorted `(subqueryId, entityId)` tuple
lex order. Locked by solver regression test case #8.

### Risk 6 — Scenarios bench file split
`scenarios.bundle.ts` is a new file; runner must discover it.

**Mitigation**: grep the runner for its scenario import strategy
(scenarios.ts vs glob); if glob-based, drop the file and it loads
automatically; if explicit list, add the import.

---

## 7. Rollback plan

Three-level rollback:

1. **Fast**: `BUNDLE_SELECTOR_ENABLED=false` → graph-executor takes
   pass-through branch unconditionally → byte-identical to pre-PR4.
2. **Deeper**: `CONSTRAINT_GRAPH_TOPOLOGY_LLM=false` (PR3 flag) → no
   hybrid graphs → selector never engages.
3. **Full**: `CONSTRAINT_GRAPH_EMIT=false` → pre-ADR-010 flat behaviour.

Budget-ledger relocation is a code move, not a data migration — rollback
requires restoring the pre-rank reserve call-site (handled by flag
branch, not a separate revert).

---

## 8. Checklist (execution order)

- [ ] §4 sanity checks (call-sites, `isSubqueryNode`, executor signature, K distribution on bench).
- [ ] Draft [ADR-013](../../adr/013-bundle-selector-graph-aware-executor.md).
- [ ] Write `assignment-solver.ts` (pure); 10-case regression test first (fail-first).
- [ ] Write `bundle-selector.ts` orchestrator.
- [ ] Write `search-usecase-graph-executor.ts` wrapper.
- [ ] Write `bundle-ranked-result.ts` (model + Zod).
- [ ] Add 3 bench scenarios to `test/benchmark/agent/scenarios.bundle.ts`.
- [ ] Write passthrough regression + budget-relocation regression.
- [ ] Relocate `BudgetLedger.reserve` call-site in hybrid-candidates.ts.
- [ ] Add silent-skip counters.
- [ ] Wire composition root + feature flag.
- [ ] Run bench shadow + compare with flag off.
- [ ] `pnpm run typecheck && pnpm run lint`.
- [ ] `pnpm run git:prepush`.
- [ ] Commit.

---

## 9. Commit message draft

```
feat(adr-013-phase-1c): BundleSelector + graph-aware executor wrapper

Introduces per-subquery candidate retrieval, a Hungarian-style exact
assignment solver (K<=5), and a graph-aware executor wrapper between
retrieval and ranking. K>5 returns fail-closed per CLAUDE.md heuristic
policy — no silent greedy fallback.

- New ADR-013 with K<=5 exact / K>5 fail-closed policy and
  budget-ledger relocation rationale
- New src/domain/retrieval/service/{bundle-selector,assignment-solver}.ts
- New src/application/search/search-usecase-graph-executor.ts wrapper
  (trivial + hybrid-single-subquery pass-through; hybrid multi-subquery
  engages bundle path)
- New BundleRankedResult model extending RankedResult
- BudgetLedger.reserve relocated from pre-rank to post-assignment
  (P1-C fix; telemetry counter locked at 0)
- 3 new bench scenarios (3-way pairing, XOR red-or-white, shared-budget
  gift set) in test/benchmark/agent/scenarios.bundle.ts
- 3 new regression files (~17 cases)
- BUNDLE_SELECTOR_ENABLED feature flag (default off; nightly shadow)

Rollback: BUNDLE_SELECTOR_ENABLED=false — byte-identical to pre-PR4.
```
