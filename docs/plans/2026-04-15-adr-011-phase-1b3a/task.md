# PR1 — ADR-011 Phase 1b.3a: first pre-rank & decision-input graph readers

> **Scope envelope**: thread `compiled.constraintGraph` into the two remaining
> small flat-bundle readers (pre-rank coverage call-site + decision-input),
> factor a shared graph-aware helper so provenance-closure / decision-input
> cannot drift in semantics, and lock trivial-graph parity.
>
> **Parent plan**: [2026-04-15-improvement.md](../2026-04-15-improvement.md)
> Axis 1 / Phase 1b. **Upstream**: [ADR-011](../../adr/011-constraint-graph-phase-1b-first-reader.md).
>
> **Anchor commit**: HEAD `7c7e6cf` (Phase 1b.1 landed).

---

## 1. Why this PR

Phase 1b.1 migrated **one** reader (`provenance-closure`) to consume
`compiled.constraintGraph`. Two smaller flat-bundle consumers remain that
are in the same critical path and would otherwise drift in XOR/OR
semantics against the migrated reader:

1. **Pre-rank coverage call-site** — [hybrid-candidates.ts:139-148](../../../src/application/search/search-usecase-hybrid-candidates.ts#L139-L148).
   `buildRetrievalCoverage` calls `buildHybridCandidateCoverageStage`
   without passing `compiled.constraintGraph`, so specialized retrieval
   paths use the flat coverage path even when a graph is present.
2. **Decision-input builder** — [search-usecase-decision-input.ts:118-128](../../../src/application/search/search-usecase-decision-input.ts#L118).
   Builds `matchedRequiredAttributes` / `unmetRequiredAttributes` from
   `plan.constraints.hard` directly, completely bypassing the graph.

If these stay flat while `provenance-closure` is graph-aware, the internal
decision surface develops a **semantics split** under XOR/OR groups:
provenance-closure says "satisfied (XOR: one matched)", decision-input
says "not satisfied (AND: not all matched)" → abstention / closure /
response trace all disagree. This PR closes that gap.

**Explicit non-scope** (deferred to Phase 1b.3b):
- Ranker scoring (`signal-computer.ts`, `ranker.ts`) — hard gate predicate
  rewrite is a separate change.
- Candidate-pool annotation (`candidate-pool.ts:728`,
  `candidate-constraint-evidence.ts:357`).
- Specialized retrievers (`browse-retriever.ts:51`,
  `compare-retriever.ts:81`).
- Bench `scrInferredGraph` / `csrInferredGraph` dual metric — its own PR
  per the reviewed plan (PR2 in the 7-PR train).

---

## 2. File-by-file change checklist

### 2.1 New files

| File | Purpose |
|------|---------|
| [src/domain/query/service/graph-required-attributes.ts](../../../src/domain/query/service/graph-required-attributes.ts) | Shared graph-vs-flat coverage helper. Single source of truth for "what attributes are required / matched / unmet" extraction. Wraps `computeGraphCoverage` and provides the flat fallback primitive. Imported by `provenance-closure`, `decision-input`, (eventually) Phase 1b.3b ranker gate rewrite. |

Exported surface (tight):

```ts
export interface RequiredAttributeResolution {
  readonly matched: readonly string[];
  readonly unmet: readonly string[];
  /** True when the graph (if present) reports the root group satisfied,
   *  OR when flat fallback reports zero unmet. Callers use this for
   *  `constraintEvidenceSatisfied` decisions under XOR/OR semantics. */
  readonly satisfied: boolean;
}

export function resolveRequiredAttributes(input: {
  readonly plan: QueryPlanV1;
  readonly graph?: ConstraintGraph | undefined;
  readonly satisfiedAttributes: readonly string[];
}): RequiredAttributeResolution;
```

### 2.2 Modified files

| File | Change |
|------|--------|
| [src/application/search/search-usecase-provenance-closure.ts](../../../src/application/search/search-usecase-provenance-closure.ts) | Refactor `computeMatchedAndUnmet` and both stage builders to delegate through `resolveRequiredAttributes`. **No behavioural change** (locked by existing Phase 1b.1 parity test); this is DRY so the shared helper is the authoritative logic. `constraintEvidenceSatisfied` uses `resolution.satisfied` not ad-hoc length math. |
| [src/application/search/search-usecase-decision-input.ts](../../../src/application/search/search-usecase-decision-input.ts) | Accept `graph` from the upstream `compiled.constraintGraph` (need to verify caller passes `compiled` — see §4). Replace lines ~118-130 flat `requiredConstraintAttributes`/`matchedRequiredAttributes`/`unmetRequiredAttributes` with `resolveRequiredAttributes(...)`. Plug resolved fields into the existing `provenanceContract.observed.*ConstraintAttributes`. **Do not change any downstream decision trace field names.** |
| [src/application/search/search-usecase-hybrid-candidates.ts](../../../src/application/search/search-usecase-hybrid-candidates.ts) | Line ~144: `buildHybridCandidateCoverageStage(plan, candidates, compiled.execution.provenancePolicy, compiled.constraintGraph)` — 1 new argument on the one call. **Pre-existing lint debt in this file** (see §6 Risk 1). |
| [test/regression/constraint-graph-readers-unchanged.regression.test.ts](../../../test/regression/constraint-graph-readers-unchanged.regression.test.ts) | Append to allow-list: `search-usecase-decision-input.ts`, `search-usecase-hybrid-candidates.ts`, `graph-required-attributes.ts`. Update docstring to name PR1 additions explicitly. Append-only — never delete this file. |

### 2.3 Files I explicitly do NOT touch

- `src/domain/ranking/service/signal-computer.ts` — Phase 1b.3b.
- `src/domain/ranking/service/ranker.ts` — Phase 1b.3b.
- `src/domain/retrieval/service/candidate-pool.ts` — Phase 1b.3b.
- `src/domain/retrieval/service/candidate-constraint-evidence.ts` — Phase 1b.3b.
- `src/domain/retrieval/service/browse-retriever.ts`, `compare-retriever.ts` — Phase 1b.3b.
- `test/benchmark/agent/constraint-metrics.ts` — PR2.

---

## 3. Test additions

All go under `test/regression/` per project convention (append-only).

| Test file | Cases | Locks |
|-----------|-------|-------|
| [test/regression/graph-required-attributes-shared-helper.regression.test.ts](../../../test/regression/graph-required-attributes-shared-helper.regression.test.ts) | ~8 | Shared helper semantics: trivial graph = flat fallback (byte-identical); XOR one-of matching; OR any-of; nested AND/OR; empty graph trivially satisfied; null/undefined candidates; empty satisfied set → all unmet. |
| [test/regression/decision-input-graph-migration.regression.test.ts](../../../test/regression/decision-input-graph-migration.regression.test.ts) | ~5 | Decision-input under graph: `matchedRequiredAttributes` under XOR (pick one); `unmetRequiredAttributes` under OR (none unmet when any-one satisfied); trivial graph parity with flat path (byte-identical); no graph passed → pre-PR behaviour byte-identical. |
| [test/regression/pre-rank-coverage-graph-migration.regression.test.ts](../../../test/regression/pre-rank-coverage-graph-migration.regression.test.ts) | ~3 | `buildRetrievalCoverage` (the wrapper in hybrid-candidates.ts) threads `compiled.constraintGraph` into the stage builder: XOR / OR scenarios return graph-aware coverage rather than flat. |

Parity test discipline (ADR-011 gate):
- Trivial graph (from `buildTrivialGraphFromAtoms(liftBundleToAtoms(bundle))`)
  MUST produce the same `ProvenanceCoverageStage` as the flat `bundle` path
  byte-for-byte. Already locked for provenance-closure by 1b.1; this PR
  adds the equivalent lock for decision-input.

---

## 4. Call-graph sanity checks (pre-coding)

Before editing `search-usecase-decision-input.ts`:

- [ ] Confirm `buildDecisionInput(...)` already has access to `compiled: CompiledWineQuery` (not just `plan: QueryPlanV1`). If only `plan` is threaded, the first change is widening the signature and updating callers.
- [ ] Grep every caller of `buildDecisionInput` to confirm they can pass `compiled`.
- [ ] Confirm `search-usecase-hybrid-candidates.ts::buildRetrievalCoverage` is the ONLY call-site of `buildHybridCandidateCoverageStage` without a graph arg at HEAD. The hybrid-ranking-pipeline call-site already passes the graph (done in 1b.1).

Bail early if any assumption breaks — expand scope via an ADR amendment, not silent widening.

---

## 5. Cutover gate

All four items green before commit:

1. **New regression tests pass**: ~16 new cases across the 3 new files (see §3).
2. **Phase 1a/1b.1 regressions still green**: 28 + 21 = 49 existing cases
   unchanged. Trivial-graph parity in provenance-closure still byte-identical.
3. **`pnpm run git:prepush` green**: typecheck + full unit lane + HTTP contract parity.
4. **Rollback verified**: with `CONSTRAINT_GRAPH_EMIT=false` set, a diff of
   decision-input output between HEAD `7c7e6cf` and this PR's HEAD is empty
   on the bench fixtures. (If a rollback fixture test doesn't exist yet,
   add a focused one in `decision-input-graph-migration.regression.test.ts`
   that instantiates the compiler with `CONSTRAINT_GRAPH_EMIT=false` and
   asserts `compiled.constraintGraph === undefined` + output matches flat.)

---

## 6. Risks & mitigations

### Risk 1 — Pre-existing lint debt in `search-usecase-hybrid-candidates.ts`
15 `@typescript-eslint/no-unnecessary-condition` errors already present on
main at HEAD (confirmed during Phase 1b.1 via stash experiment). lint-staged
husky hook runs on the file as soon as it's touched → blocks commit.

**Mitigation**: land a **separate pre-PR lint cleanup commit** on the same
branch before PR1 proper. Each cleanup is a 1-line revert of a stale
`!== undefined` check against a now-non-nullable type. Fully mechanical,
no behavioural change. If the cleanup pushes PR diff size over a
reviewable threshold, split into its own micro-PR.

*Do NOT* use `git commit --no-verify` — CLAUDE.md forbids it.
*Do NOT* scope the cleanup to only the lines this PR touches — the hook
runs on the entire staged file.

### Risk 2 — `buildDecisionInput` signature widening
If `compiled` isn't already threaded into decision-input, widening touches
N callers. Scope creep risk.

**Mitigation**: §4 pre-check. If scope would exceed ~3 call-sites, split
the signature widening into its own micro-PR (PR1-pre-b) with zero
behavioural change, then land PR1 proper on top. Do not bundle unless
the widening is ≤2 call-sites.

### Risk 3 — Decision-input output shape drift
`provenanceContract.observed.matchedConstraintAttributes` is read by
downstream policy/closure/explanation code. Silent re-ordering of the
matched/unmet arrays could break a replay-diff-based test.

**Mitigation**: `resolveRequiredAttributes` guarantees a deterministic
ordering spec (sorted or insertion-order per helper docstring). Lock it
in the shared-helper regression. Run a full bench replay diff locally
before committing — any delta must be explained by a graph-aware change
that also surfaces in `computeGraphCoverage` output (never a pure
ordering change).

### Risk 4 — Shared helper becomes a premature abstraction
If `provenance-closure` and `decision-input` diverge in what they mean by
"matched" (e.g. decision-input cares about `soft` tier too), the shared
helper becomes a leaky bag.

**Mitigation**: PR1 keeps both on hard-tier required attributes only —
the existing behaviour. Tier-aware resolution stays a Phase 1b.3b concern
when ranker soft/inferred semantics migrate. Document this in the helper
header so future hands don't grow it casually.

### Risk 5 — Lint rule `no-magic-numbers` / `consistent-type-assertions`
New helper must pass all lint rules for new src/ files (magic numbers,
console, as-casts on external data). Verify before the husky hook does.

**Mitigation**: lint the new file immediately after writing; fix inline.

---

## 7. Rollback plan

Identical to Phase 1a/1b.1 — `CONSTRAINT_GRAPH_EMIT=false` → graph
`undefined` everywhere → all migrated readers (provenance-closure,
decision-input, pre-rank coverage) take their flat fallback →
byte-identical to pre-PR1 behaviour. No schema migration, no code change.

Full rollback ≈ one environment-variable flip.

---

## 8. Checklist (execution order)

- [ ] §4 sanity check: `buildDecisionInput` callers, `buildRetrievalCoverage` call-sites.
- [ ] Lint cleanup for `search-usecase-hybrid-candidates.ts` 15 warnings (separate commit on branch).
- [ ] Write `graph-required-attributes.ts` (new helper).
- [ ] Write `graph-required-attributes-shared-helper.regression.test.ts` and run.
- [ ] Refactor `provenance-closure.ts` to delegate through the helper; verify 1b.1 parity tests still green.
- [ ] Write `decision-input-graph-migration.regression.test.ts` (fail first), migrate `decision-input.ts`, verify green.
- [ ] Update `hybrid-candidates.ts` 1-arg pass for `buildHybridCandidateCoverageStage`.
- [ ] Write `pre-rank-coverage-graph-migration.regression.test.ts`.
- [ ] Update reader allow-list regression (append-only).
- [ ] Run full Phase 1a + 1b.1 + 1b.3a regression lane.
- [ ] Run `pnpm run typecheck && pnpm run lint:file -- <changed>`.
- [ ] Run `pnpm run git:prepush`.
- [ ] Commit as one focused commit.

---

## 9. Commit message draft

```
feat(adr-011-phase-1b.3a): decision-input + pre-rank coverage graph readers

Closes the semantics split between provenance-closure (migrated in 1b.1)
and the two remaining flat-bundle readers on the same critical path:
pre-rank coverage wrapper in hybrid-candidates.ts and decision-input.

Introduces shared helper `resolveRequiredAttributes` so both migrated
readers go through one coverage extraction path — prevents XOR/OR
semantics drift between provenance-closure and decision-input.

- New src/domain/query/service/graph-required-attributes.ts
- Provenance-closure refactored to delegate through the helper (no
  behavioural change; 1b.1 parity test still green)
- Decision-input accepts `compiled.constraintGraph` when present; flat
  fallback byte-identical for trivial graphs
- Pre-rank coverage call-site threads `compiled.constraintGraph`
- 3 new append-only regression files (~16 cases): shared-helper
  semantics, decision-input migration, pre-rank coverage migration
- Reader allow-list expanded for PR1 authorised files

Rollback: `CONSTRAINT_GRAPH_EMIT=false` — byte-identical to pre-PR1.
```
