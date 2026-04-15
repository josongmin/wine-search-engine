# PR2 — Bench graph-aware dual metric: `scrInferredGraph` / `csrInferredGraph`

> **Scope envelope**: add a parallel, graph-aware metric alongside the existing
> flat `scrInferred` / `csrInferred` in [constraint-metrics.ts](../../../test/benchmark/agent/constraint-metrics.ts)
> — **dual-emit, not replace**. Threaded through [scorer.ts](../../../test/benchmark/agent/scorer.ts)
> (ScenarioScores + summary types) and [runner.ts](../../../test/benchmark/agent/runner.ts)
> (score assembly + summary + CLI printout + `baseline.json`).
>
> **Parent plan**: [2026-04-15-improvement.md](../2026-04-15-improvement.md)
> Axis 1 bench instrumentation. **Upstream**: [ADR-011](../../adr/011-constraint-graph-phase-1b-first-reader.md).
>
> **Anchor commit**: PR1 HEAD. PR2 can merge immediately after PR1.

---

## 1. Why this PR

Flat `scrInferred` / `csrInferred` use **bucket-set equality** on expected
vs extracted inferred attributes ([constraint-metrics.ts:171, 388](../../../test/benchmark/agent/constraint-metrics.ts#L171)).
This metric cannot distinguish:

- XOR satisfaction (one of two branches matched) from AND failure (only
  one of two required matched).
- "Shared-budget" wine pairings where two slots share a price budget and
  only one side exercised the constraint.
- Subquery-scoped coverage once PR3 (topology planner) lands — the flat
  metric is structurally blind to multi-subquery graphs.

Dual-emit preserves historical comparability for the existing flat metric
while giving the rest of the 7-PR train (esp. PR5 ranker-graph-native and
PR4 BundleSelector) a numerical signal that understands AND/OR/XOR.

**Dual-emit contract**: both metrics are reported for every scenario and
every summary. Neither is derived from the other. They will diverge on
XOR / OR / subquery-bundled scenarios **by design** — that divergence is
the telemetry.

**Explicit non-scope**:
- Ranker gate rewrite — PR5 (ADR-014).
- BundleSelector assignment metric — PR4 (ADR-013).
- Graph replay stability metric — PR3 (ADR-012) owns it.

---

## 2. File-by-file change checklist

### 2.1 New files

| File | Purpose |
|------|---------|
| [test/benchmark/agent/graph-coverage-metric.ts](../../../test/benchmark/agent/graph-coverage-metric.ts) | Pure function `computeScrInferredGraph({ graph, extractedInferred, expectedInferred })` and `computeCsrInferredGraph(...)`. Delegates to `computeGraphCoverage` from [src/domain/query/service/graph-coverage.ts](../../../src/domain/query/service/graph-coverage.ts) (landed Phase 1b.1). Returns `null` when graph is absent (keeps historical flat path authoritative). |
| [test/regression/bench-graph-metric-dual-emit.regression.test.ts](../../../test/regression/bench-graph-metric-dual-emit.regression.test.ts) | Locks dual-emit: trivial graph → graph metric equals flat metric byte-identical; XOR graph with one branch matched → `scrInferredGraph=1.0` while flat `scrInferred≈0.5`; summary object carries both fields. |

### 2.2 Modified files

| File | Change |
|------|--------|
| [test/benchmark/agent/constraint-metrics.ts](../../../test/benchmark/agent/constraint-metrics.ts#L171) | Extend `ExtractionMetrics` interface with `scrInferredGraph: number \| null`. Extend `ConstraintCoverageMetrics` at [line 388](../../../test/benchmark/agent/constraint-metrics.ts#L388) with `csrInferredGraph: number \| null`. Populate via new helper; leave flat `scrInferred` / `csrInferred` computation untouched. Dual-emit only. |
| [test/benchmark/agent/scorer.ts](../../../test/benchmark/agent/scorer.ts#L145) | Extend `ScenarioScores` type at ~line 145 with `scrInferredGraph` / `csrInferredGraph`. Extend summary aggregation (`averageScenarioScores` or equivalent) to compute graph-aware averages across scenarios with `null`-safe mean. Weight unchanged — dual tracks, one for trend, one for legacy comparability. |
| [test/benchmark/agent/runner.ts](../../../test/benchmark/agent/runner.ts#L1320) | Score assembly (~line 1320): pass through new fields from scorer. Summary construction (~line 1410): include both metrics in printed table. CLI printout: new row `scr_inferred_graph` / `csr_inferred_graph` under existing "Constraint metrics" block. |
| [test/benchmark/agent/baseline.json](../../../test/benchmark/agent/baseline.json) | Bump `"baselineVersion"` from current (e.g. `"v3"`) to `"v4"`. Add `scrInferredGraph` / `csrInferredGraph` fields to every scenario baseline row with initial value `null` (first run populates; subsequent runs compare). Old format readers continue to work because reader uses `??` fallback — see §4. |
| [test/benchmark/agent/baseline-reader.ts](../../../test/benchmark/agent/baseline-reader.ts) | If this file exists: add `baselineVersion` check. `"v3"` reads without graph fields; `"v4"` reads both. One-release compatibility window. If the file does NOT exist (grep-verify in §4), reader behaviour lives directly in `runner.ts` — extend there. |

### 2.3 Files I explicitly do NOT touch

- All `src/` files — this is a bench-only PR, no runtime code change.
- [test/benchmark/agent/scorer.ts](../../../test/benchmark/agent/scorer.ts) scoring weights — dual-emit does not rebalance scoring.
- Any other ranking/retrieval metric — separate PRs.

---

## 3. Test additions

| Test file | Cases | Locks |
|-----------|-------|-------|
| [test/regression/bench-graph-metric-dual-emit.regression.test.ts](../../../test/regression/bench-graph-metric-dual-emit.regression.test.ts) | ~8 | Trivial graph parity (graph metric == flat metric); XOR one-branch-matched (graph ≈ 1.0, flat ≈ 0.5); OR any-of matched; nested AND/OR; empty graph → `null`; no-graph-passed → `null`; summary carries both fields; `null`-safe mean on mixed-scenario summary. |
| [test/regression/bench-baseline-version-compat.regression.test.ts](../../../test/regression/bench-baseline-version-compat.regression.test.ts) | ~3 | `"v3"` baseline JSON still parses (backward compatibility); `"v4"` baseline parses with graph fields; unknown version fails loudly (fail-closed). |

Parity discipline:
- Trivial graph path (from `buildTrivialGraphFromAtoms`) MUST yield the
  **exact same number** as the flat bucket-set computation. Divergence is
  a regression — lock with a single high-fidelity fixture.

---

## 4. Call-graph sanity checks (pre-coding)

Before editing:

- [ ] Grep `rg "baselineVersion" test/benchmark/` — confirm current version
  string and whether a dedicated `baseline-reader.ts` exists.
- [ ] Confirm `computeGraphCoverage` is exported from the Phase 1b.1
  landing site at [src/domain/query/service/graph-coverage.ts](../../../src/domain/query/service/graph-coverage.ts).
- [ ] Grep every consumer of `ScenarioScores` / `ExtractionMetrics` to
  ensure optional new fields do not break deserialisation (`exactOptionalPropertyTypes`
  is on — use `scrInferredGraph: number | null` not `?:`).
- [ ] Confirm `test/benchmark/agent/scenarios.ts` scenario fixtures can
  thread a `constraintGraph?` from their compiled query — the metric is
  computed per-scenario, not globally.

Bail early if any assumption breaks — widen only via an explicit scope edit.

---

## 5. Cutover gate

All items green before commit:

1. **New regression tests pass**: ~11 new cases across 2 new files.
2. **Existing bench lane green**: `pnpm run test:heavy` scenario pass rate
   unchanged (dual-emit is purely additive).
3. **`pnpm run git:prepush` green**.
4. **Baseline migration verified**: run the bench once locally with the
   new dual fields populated; confirm the printed table shows both
   columns and the summary JSON contains both keys.
5. **Old baseline compatibility**: on a branch with `"v3"` baseline left
   intact, reader fails closed with a clear error (or reads silently per
   design). No silent data-loss path.

---

## 6. Risks & mitigations

### Risk 1 — Baseline JSON format drift
`baseline.json` format change is an implicit contract with every
downstream CI artifact and dashboard scraping the file.

**Mitigation**: explicit `baselineVersion` string bump; one-release
compatibility window where `"v3"` still reads (graph fields absent →
summary reports `null`). Document the cutover in the PR description.

### Risk 2 — `null`-safe mean regression
Dual-emit with mixed graph/no-graph scenarios means summary averages
must skip `null`s. A naive `.reduce((a,b)=>a+b)/n` divides by the wrong
denominator.

**Mitigation**: explicit `compact(xs.filter(x => x !== null))` then
`xs.length === 0 ? null : sum/n`. Regression test covers mixed-scenario
summary.

### Risk 3 — Divergence alarmism
When XOR/OR scenarios show large graph-vs-flat divergence, readers of
the summary table may interpret that as a regression in the flat metric.

**Mitigation**: in the runner CLI printout, put the two metrics in
adjacent columns with a header note: "graph-aware value; flat value is
legacy bucket-set equality". Document in the bench README.

### Risk 4 — Metric drift between PR2 and PR5
PR5 (ranker graph-native) will change which candidates pass the hard
gate on graph-aware scenarios. If PR2 metric is in place first, PR5
results show a large swing — that's the intended signal, not a regression.

**Mitigation**: document the expected swing direction in PR5 cutover
gate; PR2's own baseline commits the pre-PR5 numbers as a fixed point.

### Risk 5 — `noUncheckedIndexedAccess` on summary iteration
Averaging across scenarios iterates arrays; `strict` + `noUncheckedIndexedAccess`
means `arr[i]` is `T | undefined`. A naive `.reduce` over `readonly T[]`
needs an explicit guard.

**Mitigation**: use `for...of` not indexed access; `null`-aware accumulator.

---

## 7. Rollback plan

Pure-additive bench change. Rollback = revert the PR; no schema, no
runtime impact. `baseline.json` reverts to `"v3"`. No product traffic
affected.

---

## 8. Checklist (execution order)

- [ ] §4 sanity checks (baseline reader, `computeGraphCoverage` export, consumer grep).
- [ ] Write `graph-coverage-metric.ts` (new helper); lint + type-check.
- [ ] Write `bench-graph-metric-dual-emit.regression.test.ts`; run, confirm fail.
- [ ] Extend `constraint-metrics.ts` with dual-emit fields + population.
- [ ] Extend `scorer.ts` `ScenarioScores` + summary aggregation.
- [ ] Extend `runner.ts` score assembly + summary + CLI printout.
- [ ] Bump `baseline.json` version to `"v4"`; add `null` placeholders.
- [ ] Write `bench-baseline-version-compat.regression.test.ts`.
- [ ] Run full bench once locally, commit regenerated baseline numbers.
- [ ] `pnpm run typecheck && pnpm run lint:file -- <changed>`.
- [ ] `pnpm run git:prepush`.
- [ ] Commit as one focused commit.

---

## 9. Commit message draft

```
feat(bench): dual-emit scrInferredGraph / csrInferredGraph graph-aware metrics

Adds a parallel graph-aware constraint metric alongside the existing flat
scrInferred / csrInferred bucket-set metrics. Both are reported per
scenario and per summary — flat for historical comparability, graph-aware
for the AND/OR/XOR-sensitive signal the remaining 7-PR train needs.

- New test/benchmark/agent/graph-coverage-metric.ts helper (delegates to
  src/domain/query/service/graph-coverage.ts from Phase 1b.1)
- constraint-metrics.ts, scorer.ts, runner.ts dual-emit plumbing
- baseline.json version "v3" → "v4" with graph fields; one-release
  backward compatibility in reader
- 2 new regression files (~11 cases): dual-emit semantics + baseline
  version compat

No src/ changes. Rollback: revert.
```
