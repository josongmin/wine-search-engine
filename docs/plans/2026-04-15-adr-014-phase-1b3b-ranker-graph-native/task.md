# PR5 — ADR-014 Phase 1b.3b: ranker & annotator graph-native

> **Scope envelope**: rewrite the ranker's hard/soft gate predicates
> from flat `ConstraintBundle` AND-all to **graph-aware** AND/OR/XOR
> root-satisfied semantics, preserve per-atom match records through
> retrieval annotation, and migrate specialized retrievers'
> constraint filter extraction from `plan.constraints` to graph slots
> when a graph is present.
>
> **Parent plan**: [2026-04-15-improvement.md](../2026-04-15-improvement.md)
> Axis 1 / Phase 1b.3b. **Upstream**: [ADR-011](../../adr/011-constraint-graph-phase-1b-first-reader.md)
> (PR1 landed), [ADR-012](../../adr/012-constraint-graph-phase-1b2-topology-planner.md) (PR3),
> [ADR-013](../../adr/013-bundle-selector-graph-aware-executor.md) (PR4).
> **This PR drafts ADR-014**.
>
> **Anchor commit**: PR1 required. PR3/PR4 parallel-safe when bench
> flags are coordinated.

---

## 1. Why this PR

PR1 (Phase 1b.3a) migrated `provenance-closure` and `decision-input` to
graph-aware coverage. The ranker and retrieval annotator still consume
flat `ConstraintBundle`:

- Hard gate at [signal-computer.ts:168](../../../src/domain/ranking/service/signal-computer.ts#L168)
  is `constraints.hard.every(c => matches(c, candidate))` — flat AND-all.
  Under a graph with OR/XOR branches, this incorrectly rejects candidates
  that satisfy one branch of a disjunctive constraint.
- Soft/inferred weighting at [signal-computer.ts:201](../../../src/domain/ranking/service/signal-computer.ts#L201)
  has the same shape.
- Annotator at [candidate-constraint-evidence.ts:357](../../../src/domain/retrieval/service/candidate-constraint-evidence.ts#L357)
  emits `{hard, soft, inferred}` bucket sets with no `atomRef` — same
  attribute matched via slot A vs slot B is indistinguishable downstream.
- Ranked-result constraint state at [ranker.ts:629](../../../src/domain/ranking/service/ranker.ts#L629)
  records `matchedConstraints` as flat attribute names — same issue.
- Specialized retrievers ([browse-retriever.ts:51](../../../src/domain/retrieval/service/browse-retriever.ts#L51),
  [compare-retriever.ts:81](../../../src/domain/retrieval/service/compare-retriever.ts#L81))
  extract filter input from `plan.constraints` directly, bypassing the
  graph. With graph-aware OR/XOR slots, their filter emission drifts.

This is **NOT** a reader migration like PR1 — it's a **gate predicate
rewrite**. It is the highest-risk migration in the 7-PR train because
it changes which candidates pass the hard gate.

**Explicit non-scope**:
- Adding new scoring signals — this PR preserves scoring math.
- BundleSelector integration — PR4 owns assignment; PR5's ranker receives
  whatever the executor emits (single list or `BundleRankedResult[]`).
- Retrieval critic — PR6.
- Grounded claims — PR7.

---

## 2. File-by-file change checklist

### 2.1 New files

| File | Purpose |
|------|---------|
| [docs/adr/014-ranker-graph-native.md](../../adr/014-ranker-graph-native.md) | New ADR: hard-gate semantic change (flat AND-all → graph root-satisfied), annotator per-atom record preservation, specialized-retriever graph-slot extraction, trivial-graph parity contract, rollback via `CONSTRAINT_GRAPH_EMIT=false`. |
| [src/domain/ranking/service/graph-hard-gate.ts](../../../src/domain/ranking/service/graph-hard-gate.ts) | Pure helper `evaluateGraphHardGate({ graph, matchedAtomRefs }): boolean`. Delegates to `computeGraphCoverage` hard-tier subgraph `rootSatisfied`. |
| [src/domain/ranking/service/graph-soft-weight.ts](../../../src/domain/ranking/service/graph-soft-weight.ts) | Pure helper `computeGraphSoftWeight({ graph, matchedAtomRefs }): number` — soft-tier subgraph partial-satisfaction ratio for scoring (preserves existing weight semantics on trivial graphs). |
| [test/regression/ranker-graph-hard-gate.regression.test.ts](../../../test/regression/ranker-graph-hard-gate.regression.test.ts) | ~10 cases. See §3. |
| [test/regression/ranker-graph-soft-weight.regression.test.ts](../../../test/regression/ranker-graph-soft-weight.regression.test.ts) | ~6 cases. |
| [test/regression/candidate-annotator-atom-ref-preservation.regression.test.ts](../../../test/regression/candidate-annotator-atom-ref-preservation.regression.test.ts) | ~5 cases: same attribute matched via two slots → two distinct `atomRef` records; trivial graph atom-ref layout matches flat bucket output; atom-ref ordering deterministic. |
| [test/regression/specialized-retriever-graph-slot-extraction.regression.test.ts](../../../test/regression/specialized-retriever-graph-slot-extraction.regression.test.ts) | ~4 cases: browse-retriever extracts filters from graph slots when graph present; compare-retriever same; trivial graph → byte-identical to `plan.constraints` extraction; XOR slot → one-of filter emission. |
| [test/regression/ranker-trivial-graph-parity.regression.test.ts](../../../test/regression/ranker-trivial-graph-parity.regression.test.ts) | Strict parity: on trivial-graph bench scenarios, ranked result order + hard-gate pass set + scores are byte-identical pre- and post-PR5. |

### 2.2 Modified files

| File | Change |
|------|--------|
| [src/domain/ranking/service/signal-computer.ts](../../../src/domain/ranking/service/signal-computer.ts#L168) | `evaluateHardConstraints(candidate, constraints, graph?)`: when `graph` present, delegate to `evaluateGraphHardGate`; when absent, keep flat AND-all. Same for soft at [line 201](../../../src/domain/ranking/service/signal-computer.ts#L201) via `computeGraphSoftWeight`. Function signatures widened optionally — `graph?: ConstraintGraph \| undefined`. |
| [src/domain/retrieval/service/candidate-constraint-evidence.ts](../../../src/domain/retrieval/service/candidate-constraint-evidence.ts#L357) | Extend `MatchRecord` shape with `atomRef?: string` (nodeId from graph). Populate when graph present. Existing `{hard, soft, inferred}` bucket sets remain for backward compat. |
| [src/domain/retrieval/service/candidate-pool.ts](../../../src/domain/retrieval/service/candidate-pool.ts#L728) | `annotateCandidateConstraintEvidenceBatch` threads `graph?` from compiled query into the annotator. |
| [src/domain/ranking/service/ranker.ts](../../../src/domain/ranking/service/ranker.ts#L629) | Ranked-result constraint state gains `matchedAtomRefs?: readonly string[]`, `unmetAtomRefs?: readonly string[]`. Existing `matchedConstraints` / `unmetConstraints` stay for backward compat (do not delete — downstream response builder still reads them; removal deferred to a later cleanup PR). |
| [src/domain/retrieval/service/browse-retriever.ts](../../../src/domain/retrieval/service/browse-retriever.ts#L51) | Filter extraction: when graph present, read slots from graph nodes (one per subquery scope); when absent, keep current `plan.constraints` path. |
| [src/domain/retrieval/service/compare-retriever.ts](../../../src/domain/retrieval/service/compare-retriever.ts#L81) | Same pattern as browse-retriever. |
| [src/domain/response/model/ranked-result.ts](../../../src/domain/response/model/ranked-result.ts) | Extend type with optional `matchedAtomRefs` / `unmetAtomRefs`. Zod schema `.optional()`. |

### 2.3 Files I explicitly do NOT touch

- [src/domain/ranking/service/stable-comparator.ts](../../../src/domain/shared/utils/stable-comparator.ts) — SSoT, no change.
- BundleSelector / GraphExecutor (PR4).
- Retrieval critic (PR6).
- Response builder beyond ranked-result type widening.

---

## 3. Test additions

Every touched file gets its own parity regression. This is the critical
mitigation for the highest-risk migration.

| Test file | Cases | Locks |
|-----------|-------|-------|
| [test/regression/ranker-graph-hard-gate.regression.test.ts](../../../test/regression/ranker-graph-hard-gate.regression.test.ts) | ~10 | XOR gate: candidate satisfying branch A passes; candidate satisfying branch B passes; candidate satisfying neither fails. OR gate: any-one satisfied passes. Nested AND/OR/XOR. Trivial graph parity (identical pass set to flat AND-all). Shared-atomRef deduplication. Graph absent → flat fallback byte-identical. |
| [test/regression/ranker-graph-soft-weight.regression.test.ts](../../../test/regression/ranker-graph-soft-weight.regression.test.ts) | ~6 | Soft tier partial-satisfaction weighting unchanged on trivial graphs; XOR soft branch → one-branch weight only; nested soft OR. |
| [test/regression/candidate-annotator-atom-ref-preservation.regression.test.ts](../../../test/regression/candidate-annotator-atom-ref-preservation.regression.test.ts) | ~5 | Same attribute value matched via two atomRefs → two distinct records; trivial graph atomRefs align 1:1 with atom index; ordering deterministic; no graph → no atomRef field set (exactOptionalPropertyTypes). |
| [test/regression/specialized-retriever-graph-slot-extraction.regression.test.ts](../../../test/regression/specialized-retriever-graph-slot-extraction.regression.test.ts) | ~4 | browse-retriever filter parity on trivial; browse-retriever XOR slot extraction; compare-retriever same cases; absent graph → `plan.constraints` path unchanged. |
| [test/regression/ranker-trivial-graph-parity.regression.test.ts](../../../test/regression/ranker-trivial-graph-parity.regression.test.ts) | 1 gate | Trivial-graph bench scenarios byte-identical ranked output. |

---

## 4. Call-graph sanity checks (pre-coding)

- [ ] Grep every caller of `evaluateHardConstraints` and `computeSoftConstraint`. Widening signature with optional `graph?` does not break call-sites, but each must be audited to confirm graph threading through.
- [ ] Confirm `MatchRecord` shape at [candidate-constraint-evidence.ts](../../../src/domain/retrieval/service/candidate-constraint-evidence.ts) is not used in JSON serialization with exact-field contracts (no `as MatchRecord` casts on JSONB).
- [ ] Confirm the ranker's ranked-result emission at [ranker.ts:629](../../../src/domain/ranking/service/ranker.ts#L629) flows into a single downstream consumer (response builder); if it splits, each consumer must be audited for optional-field handling.
- [ ] Grep `matchedConstraints` across src/ — confirm no consumer treats it as required. Widening requires optional additions only.
- [ ] Bench scenarios: confirm `CONSTRAINT_GRAPH_EMIT=true` is the default for bench runs (otherwise parity tests test only the flat path).

Bail early if any assumption breaks.

---

## 5. Cutover gate

All items green before commit:

1. **All flat readers in ranker + annotator + specialized retrievers now graph-aware** with trivial-graph parity locked byte-identical.
2. **Flat bench metrics unchanged** on trivial-graph scenarios: `scrInferred` / `csrInferred` within ±1pp.
3. **Graph-aware metrics improve** (from PR2): target to be set pre-PR5 (reference baseline from one nightly pre-PR5).
4. **Shadow-mode bench**: run TWO nightlies with PR5 changes gated by a
   shadow flag `RANKER_GRAPH_NATIVE_SHADOW=true`. Side-by-side flat-vs-graph
   numbers in the summary. Only flip to production after both nightlies show
   no flat-metric regression.
5. **`pnpm run git:prepush` green**.
6. **Rollback verified**: `CONSTRAINT_GRAPH_EMIT=false` → graph everywhere `undefined` → flat fallback → byte-identical to pre-PR5.

---

## 6. Risks & mitigations

### Risk 1 — Hard gate semantics change is THE highest risk in the train
A candidate that passed the hard gate on flat AND-all may fail under
graph root-satisfied (or vice versa for XOR/OR).

**Mitigation**: trivial-graph parity regression is **byte-identical**,
not statistical. Any divergence on trivial-graph bench is a build-breaker.
For hybrid graphs, the parity contract is "semantically correct under
graph root-satisfied", locked by the 10-case `ranker-graph-hard-gate`
regression. Two-nightly shadow-mode bench before production flip.

### Risk 2 — `matchedConstraints` consumer drift
Response builder / policy / explainer consume `matchedConstraints` as
flat attribute names. Adding `matchedAtomRefs` without removing the
flat field means two-way drift risk over time.

**Mitigation**: PR5 keeps both. Removal is a future cleanup PR, gated
on all consumers migrating to `matchedAtomRefs` (tracked in ADR-014 as
follow-up). This PR does not delete.

### Risk 3 — Specialized-retriever filter extraction drift
browse / compare retrievers read `plan.constraints` today. If graph
slots don't 1:1 align with plan.constraints entries (they should on
trivial graphs; they may not on hybrid), filter emission drifts.

**Mitigation**: on trivial graphs, the extraction must be byte-identical
to pre-PR5. Locked by the 4-case specialized-retriever regression.
On hybrid graphs, document which extraction rules apply to which
subquery scope (ADR-014 has a decision table).

### Risk 4 — Annotator per-atom deduplication
Same attribute matched via two atomRefs could be reported as two
separate matches or deduplicated. Downstream scoring expects the
pre-PR5 behaviour — one match per attribute per tier.

**Mitigation**: annotator keeps the pre-PR5 dedup semantics for
`matchedConstraints`; `matchedAtomRefs` is a separate, non-deduplicated
field. Locked by the 5-case annotator regression test.

### Risk 5 — Shadow-mode flag proliferation
PR3, PR4, PR5 each add their own flag. Bench matrix combinatorics grow.

**Mitigation**: document the flag matrix in ADR-014. Recommended
shadow mode combination: PR3 on + PR4 on + PR5 shadow. Bench runner
prints all three flag states in the summary header.

### Risk 6 — `noUncheckedIndexedAccess` on atomRef arrays
Iterating `atomRefs[i]` with strict mode needs guards.

**Mitigation**: use `for...of` not indexed access. Lint-enforced.

---

## 7. Rollback plan

Two-level rollback:

1. **Fast**: `CONSTRAINT_GRAPH_EMIT=false` → graph everywhere `undefined`
   → every widened function takes its flat fallback → byte-identical
   to pre-PR5 behaviour.
2. **Shadow-only flip back**: `RANKER_GRAPH_NATIVE_SHADOW=true` mode
   emits both flat and graph-aware results for bench but serves flat
   to production. Revert to this during investigation without
   a code revert.

No data migration — the extra `matchedAtomRefs` fields are optional
and gracefully absent under rollback.

---

## 8. Checklist (execution order)

- [ ] §4 sanity checks (callers, MatchRecord consumers, bench flag defaults).
- [ ] Draft [ADR-014](../../adr/014-ranker-graph-native.md).
- [ ] Write `graph-hard-gate.ts`, `graph-soft-weight.ts` helpers.
- [ ] Write `ranker-graph-hard-gate.regression.test.ts` (~10 cases, fail-first).
- [ ] Write `ranker-graph-soft-weight.regression.test.ts` (~6).
- [ ] Migrate `signal-computer.ts` hard + soft gates.
- [ ] Write `candidate-annotator-atom-ref-preservation.regression.test.ts` (~5).
- [ ] Migrate `candidate-constraint-evidence.ts` + `candidate-pool.ts`.
- [ ] Write `specialized-retriever-graph-slot-extraction.regression.test.ts` (~4).
- [ ] Migrate `browse-retriever.ts` + `compare-retriever.ts`.
- [ ] Widen `ranker.ts` ranked-result emission; widen `ranked-result.ts` type.
- [ ] Write `ranker-trivial-graph-parity.regression.test.ts` byte-identical gate.
- [ ] Run two-nightly shadow bench; side-by-side flat vs graph summary.
- [ ] `pnpm run typecheck && pnpm run lint`.
- [ ] `pnpm run git:prepush`.
- [ ] Commit.

---

## 9. Commit message draft

```
feat(adr-014-phase-1b.3b): ranker & annotator graph-native gates

Rewrites the hard gate predicate at signal-computer.ts:168 from flat
AND-all to graph root-satisfied semantics; preserves per-atom match
records through retrieval annotation; migrates browse/compare
specialized retrievers to extract filters from graph slots when a
graph is present. Trivial-graph parity locked byte-identical.

This is the highest-risk migration in the 7-PR train — two nightlies
of shadow-mode bench required before production flip.

- New ADR-014 rationale + trivial-graph parity contract + decision
  table for specialized-retriever extraction rules
- New src/domain/ranking/service/graph-hard-gate.ts, graph-soft-weight.ts
- signal-computer.ts, candidate-constraint-evidence.ts,
  candidate-pool.ts, ranker.ts, browse-retriever.ts, compare-retriever.ts
  widened to optional graph arg; trivial path preserved
- Ranked result gains matchedAtomRefs / unmetAtomRefs (additive;
  matchedConstraints flat field stays for backward compat; removal
  deferred to cleanup PR)
- 5 new regression files (~26 cases), trivial-graph parity is
  byte-identical gate

Rollback: CONSTRAINT_GRAPH_EMIT=false → byte-identical to pre-PR5.
```
