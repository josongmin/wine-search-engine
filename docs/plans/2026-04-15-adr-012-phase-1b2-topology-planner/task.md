# PR3 — ADR-012 Phase 1b.2: LLM-emitted graph topology planner

> **Scope envelope**: introduce an **optional** LLM-backed topology
> planner that emits graph nodes/edges/subqueries on top of the
> deterministic trivial projection from Phase 1a; bump graph envelope
> schema `v1 → v1.1` with replay metadata; compose via
> `ConstraintCompiler` behind a feature flag with a deterministic
> fallback.
>
> **Parent plan**: [2026-04-15-improvement.md](../2026-04-15-improvement.md)
> Axis 1 / Phase 1b.2. **Upstream**: [ADR-010](../../adr/010-constraint-graph-phase-1a.md),
> [ADR-011](../../adr/011-constraint-graph-phase-1b-first-reader.md).
> **This PR drafts ADR-012** (`docs/adr/012-constraint-graph-phase-1b2-topology-planner.md`).
>
> **Anchor commit**: PR2 HEAD. Depends on PR1 + PR2 landed.

---

## 1. Why this PR

Phase 1a's projector is **deterministic and trivial** — every atom
becomes a leaf node under a single AND root. This collapses real user
queries like "빨간 고기에는 레드, 생선에는 화이트" (XOR/subquery-pair)
into a flat AND that no downstream graph reader can distinguish from
a single-intent query.

Phase 1b.2 introduces an **LLM topology planner** that, given the atoms
produced by `ConstraintReasoner` and the `planDecompositionHint`, emits:
- Group structure (AND / OR / XOR).
- Subquery scoping (one query, one slot; multi-subquery pairing).
- Cross-subquery edges (`shares_budget`, `complements`, `depends_on`).
- Global budgets (`priceTotal`, `candidateCount`, `walltime`).

The planner is a **NEW pure service** — it does not modify
[constraint-reasoner.ts:120](../../../src/domain/query/service/constraint-reasoner.ts#L120)
(pairwise O(n²) pure in-process, stays deterministic). It follows the
[llm-nl-mapper.ts:170](../../../src/domain/query/service/llm-nl-mapper.ts#L170) `ChatLlmPort`
seam precedent.

**Explicit non-scope**:
- Ranker migration — PR5 (ADR-014).
- BundleSelector — PR4 (ADR-013).
- Retrieval critic — PR6 (ADR-015).
- Grounded claims — PR7 (ADR-016).
- Modifying `ConstraintReasoner` — stays pure in-process.

---

## 2. File-by-file change checklist

### 2.1 New files

| File | Purpose |
|------|---------|
| [docs/adr/012-constraint-graph-phase-1b2-topology-planner.md](../../adr/012-constraint-graph-phase-1b2-topology-planner.md) | New ADR: rationale, LLM seam, envelope v1.1, feature flag, rollout, determinism contract (temperature 0, fixed prompt), failure semantics (null → deterministic fallback). |
| [src/domain/query/service/constraint-topology-planner.ts](../../../src/domain/query/service/constraint-topology-planner.ts) | Pure service `ConstraintTopologyPlanner` with `plan(atoms, normalizedQuery, planDecompositionHint): Promise<ConstraintGraph \| null>`. Intent-gated (see §6 Risk 1). Returns `null` on any failure; caller falls back to trivial. |
| [src/domain/query/service/merge-topology-into-trivial.ts](../../../src/domain/query/service/merge-topology-into-trivial.ts) | Deterministic merge: anchor LLM groups/edges/subqueries to the trivial graph's atom-indexed slot nodes. Sets `origin: 'hybrid'`. Idempotent: `merge(trivial, merge(trivial, x)) === merge(trivial, x)`. |
| [src/domain/query/service/prompts/constraint-graph-topology.prompt.ts](../../../src/domain/query/service/prompts/constraint-graph-topology.prompt.ts) | Prompt string + `prompt_version: 'ctg_topology_v1'`. Stable, frozen. Future changes bump to `'ctg_topology_v2'`. |
| [test/regression/constraint-graph-schema-v1-to-v1.1-migration.regression.test.ts](../../../test/regression/constraint-graph-schema-v1-to-v1-1-migration.regression.test.ts) | Locks v1 → v1.1 migration: v1 JSON (no `prompt_version` / `generated_at` / `llm_model`) still parses under v1.1 Zod; v1.1 JSON with the new optional fields parses; unknown `graphSchemaVersion` fails closed. |
| [test/regression/constraint-topology-planner.regression.test.ts](../../../test/regression/constraint-topology-planner.regression.test.ts) | ~8 cases: intent gate skips single-intent query; XOR emits `origin='hybrid'` with OR/XOR group; subquery pair emits two subqueries with `shares_budget` edge when price budget is shared; planner returns `null` on malformed LLM output; fallback to trivial is byte-identical on null. |
| [test/regression/constraint-graph-replay-stability.regression.test.ts](../../../test/regression/constraint-graph-replay-stability.regression.test.ts) | Identical prompt + identical atoms → identical graph (sorted keys, temperature 0). Lock one XOR scenario and one shared-budget scenario. |

### 2.2 Modified files

| File | Change |
|------|--------|
| [src/domain/query/model/constraint-graph.ts](../../../src/domain/query/model/constraint-graph.ts#L139) | Bump `ConstraintGraphSchemaVersion` union to include `'constraint_graph_v1.1'`. Extend `ConstraintGraph` interface with optional `prompt_version?: string`, `generated_at?: string`, `llm_model?: string`. Extend Zod schema with `.optional()` on each (exactOptionalPropertyTypes: omit keys, do not assign `undefined`). |
| [src/domain/query/service/constraint-compiler.ts](../../../src/domain/query/service/constraint-compiler.ts#L58) | Constructor widens: `constructor(deps: { nlMapper: NLMapper; topologyPlanner?: ConstraintTopologyPlanner \| undefined; featureFlags: FeatureFlags })`. At [line 238](../../../src/domain/query/service/constraint-compiler.ts#L238) (trivial projector call site), after trivial graph is built, if `CONSTRAINT_GRAPH_TOPOLOGY_LLM` is on AND intent gate passes AND `topologyPlanner` is present → call `planner.plan(...)`, then `mergeTopologyIntoTrivial(trivial, topology)`. On `null` return, keep trivial. |
| [src/domain/query/service/planner.ts](../../../src/domain/query/service/planner.ts#L139) | Inject `topologyPlanner` into the `new ConstraintCompiler(...)` call. Wire from composition root (see §4). |
| [src/config/composition-root.ts](../../../src/config/composition-root.ts) | Instantiate `ConstraintTopologyPlanner` from `ChatLlmPort`. Flag-gated — pass `undefined` when `CONSTRAINT_GRAPH_TOPOLOGY_LLM=false`. |
| [src/config/feature-flags.ts](../../../src/config/feature-flags.ts) | Add `CONSTRAINT_GRAPH_TOPOLOGY_LLM` flag (default **off**). |
| [src/application/search/__tests__/planner-v2.test.ts](../../../src/application/search/__tests__/planner-v2.test.ts) | Add passthrough cases: with planner enabled and `origin='hybrid'` graph produced, the graph lives on `compiled.constraintGraph`; with planner disabled, trivial graph only. |
| [src/domain/query/service/__tests__/execution-compiler.test.ts](../../../src/domain/query/service/__tests__/execution-compiler.test.ts) | Compiled passthrough case for hybrid-origin graphs. |

### 2.3 Files I explicitly do NOT touch

- [src/domain/query/service/constraint-reasoner.ts](../../../src/domain/query/service/constraint-reasoner.ts#L120) — pure in-process, stays deterministic.
- [src/domain/ranking/service/signal-computer.ts](../../../src/domain/ranking/service/signal-computer.ts#L168) — PR5.
- [src/domain/retrieval/service/candidate-pool.ts](../../../src/domain/retrieval/service/candidate-pool.ts#L728) — PR5.
- Any file on the agent-budget critical path ([step-budget.ts](../../../src/domain/agent/service/step-budget.ts), `adaptive-budget.ts`).

---

## 3. Test additions

All under `test/regression/` (append-only) or the co-located
`__tests__/` directory as noted.

| Test file | Cases | Locks |
|-----------|-------|-------|
| [test/regression/constraint-graph-schema-v1-to-v1-1-migration.regression.test.ts](../../../test/regression/constraint-graph-schema-v1-to-v1-1-migration.regression.test.ts) | ~5 | v1 JSON reads under v1.1 Zod; v1.1 JSON reads; optional fields omitted cleanly (`exactOptionalPropertyTypes`); unknown version fails closed; round-trip preserves `prompt_version`. |
| [test/regression/constraint-topology-planner.regression.test.ts](../../../test/regression/constraint-topology-planner.regression.test.ts) | ~8 | Intent gate skip; XOR emission; shared-budget subquery pair; `null` on malformed LLM output; fallback byte-identical; `origin='hybrid'` set; deterministic sort-keys output at temperature 0; prompt uses frozen `prompt_version='ctg_topology_v1'`. |
| [test/regression/constraint-graph-replay-stability.regression.test.ts](../../../test/regression/constraint-graph-replay-stability.regression.test.ts) | ~3 | Identical atoms+prompt → identical graph bytes; `generated_at` excluded from replay hash; prompt_version drift breaks replay (fails loudly). |
| [src/application/search/__tests__/planner-v2.test.ts](../../../src/application/search/__tests__/planner-v2.test.ts) | +2 | `constraintGraph.origin='hybrid'` passthrough; planner disabled → `origin='trivial'` only. |
| [src/domain/query/service/__tests__/execution-compiler.test.ts](../../../src/domain/query/service/__tests__/execution-compiler.test.ts) | +2 | Hybrid graph preserved through `execution-compiler`. |

---

## 4. Call-graph sanity checks (pre-coding)

- [ ] Grep `new ConstraintCompiler(` across `src/` + tests. Every call-site
  needs to accept the widened constructor (optional arg, so old call-sites
  still compile — verify).
- [ ] Confirm `ChatLlmPort` is available in the composition root and that
  instantiating one more LLM-backed service does not trigger a circular
  import.
- [ ] Confirm `planDecompositionHint` is already threaded into
  `ConstraintCompiler` input (if not, widening is required — keep it
  optional on input type).
- [ ] Intent gate spec: only run the LLM planner when
  `queryDecomposition.subqueries.length > 1` **OR** a lightweight
  regex detects XOR keywords (Korean: `각각|따로|반반|또는`, English:
  `either|or|one ... other ...`). This list lives in a single SSoT
  constant `TOPOLOGY_INTENT_GATE_KEYWORDS`.
- [ ] Verify `computeGraphCoverage` (Phase 1b.1) handles `origin='hybrid'`
  graphs correctly — trivial and hybrid share node shape.

Bail early if any assumption breaks.

---

## 5. Cutover gate

All items green before commit:

1. **Trivial graph parity preserved**: with `CONSTRAINT_GRAPH_TOPOLOGY_LLM=false`,
   every bench scenario produces a byte-identical `compiled.constraintGraph`
   as HEAD pre-PR3.
2. **Replay stability**: ≥3 regression scenarios lock identical prompt
   + atoms → identical graph bytes.
3. **Coverage gate**: ≥90% of `situation_based` + `nested_condition`
   bench scenarios emit a valid Zod `origin='hybrid'` graph when the
   flag is on (measured once locally; documented as a target, not
   enforced in unit tests).
4. **XOR delta**: on the XOR subset of scenarios, `scrInferredGraph`
   (from PR2 dual metric) improves by ≥5pp vs the trivial-only baseline.
5. **`pnpm run git:prepush` green**.
6. **Rollback verified**: flag off → compiler does not import the
   planner class in its hot path beyond the branch condition.

---

## 6. Risks & mitigations

### Risk 1 — LLM latency on every compile
If the planner runs for every query, p99 compile latency blows up.

**Mitigation**: **intent gate** — only call the planner when the query
decomposer already signals multi-subquery, or the normalized query
matches an XOR-smell regex. Both conditions documented in the ADR and
locked by regression. Single-intent queries take the pure-trivial
fast path and never incur LLM cost.

### Risk 2 — Non-determinism on LLM output
Even at temperature 0, Anthropic/OpenAI responses can drift across
API revisions.

**Mitigation**: `prompt_version` + `llm_model` captured in graph envelope.
Replay test compares sorted-key JSON minus `generated_at`. When the
vendor-side drift is detected, ADR requires a prompt_version bump, not
a silent swap.

### Risk 3 — Merge collisions between trivial and hybrid
If the LLM emits a node whose `nodeId` collides with a trivial slot
node, the merge silently drops one.

**Mitigation**: merge function **asserts** disjoint node-id namespaces
— trivial uses `trivial/atom-N`, LLM output must use `topology/*`.
Collision → merge returns `null` (fail-closed). Locked by regression.

### Risk 4 — Frame observationHash collision
If the topology planner is called twice with identical inputs within
one request (retry), the `ToolCallEvidenceFrame.observationHash` values
collide — same issue Axis 2 (PR6) faces.

**Mitigation**: noted here but resolved in PR6 frame schema v1→v1.1
bump (adds `retryCount`). PR3 does not trigger the collision path in
production because the planner is called once per compile. Regression
test guards against accidental re-entry.

### Risk 5 — Feature flag stuck on partial rollout
Flag `CONSTRAINT_GRAPH_TOPOLOGY_LLM` half-rolled means different requests
get different graph origins.

**Mitigation**: flag is a single boolean at composition root, read once
at startup. No per-request branching. Documented in ADR.

### Risk 6 — ADR-012 drafting drift
ADR text and implementation drift during review cycle.

**Mitigation**: ADR sections link to specific line numbers in this PR's
diff; reviewer pass #1 is ADR-vs-code consistency only.

---

## 7. Rollback plan

Two-level rollback:

1. **Fast**: `CONSTRAINT_GRAPH_TOPOLOGY_LLM=false` → compiler never calls
   the planner → all graphs are trivial — byte-identical to pre-PR3
   behaviour. Readers (provenance-closure, decision-input, pre-rank
   coverage from PR1) see `origin='trivial'` and take the deterministic
   path.
2. **Full**: `CONSTRAINT_GRAPH_EMIT=false` → no graph at all → flat
   fallback everywhere (matches pre-ADR-010 behaviour).

Schema v1.1 is a pure superset of v1, so rolling back the envelope
schema only needs a Zod version pin; stored graphs from v1.1 still
parse under v1.1 forever. No data migration.

---

## 8. Checklist (execution order)

- [ ] §4 sanity checks (call-sites of `new ConstraintCompiler`, `ChatLlmPort` availability, intent gate keywords).
- [ ] Draft [ADR-012](../../adr/012-constraint-graph-phase-1b2-topology-planner.md); link to this task.md.
- [ ] Bump `constraint-graph.ts` Zod schema to v1.1 (optional fields).
- [ ] Write `constraint-graph-schema-v1-to-v1-1-migration.regression.test.ts`; run, confirm green.
- [ ] Write `constraint-topology-planner.ts` (service); lint + type-check.
- [ ] Write `merge-topology-into-trivial.ts` (pure merge); unit test idempotence.
- [ ] Write `prompts/constraint-graph-topology.prompt.ts`.
- [ ] Add feature flag `CONSTRAINT_GRAPH_TOPOLOGY_LLM`.
- [ ] Widen `ConstraintCompiler` constructor; wire from composition root.
- [ ] Write topology planner regression file (~8 cases); replay stability file (~3).
- [ ] Extend `planner-v2.test.ts`, `execution-compiler.test.ts` passthrough cases.
- [ ] Run bench once with flag on + once with flag off; diff graph outputs.
- [ ] `pnpm run typecheck && pnpm run lint`.
- [ ] `pnpm run git:prepush`.
- [ ] Commit.

---

## 9. Commit message draft

```
feat(adr-012-phase-1b.2): LLM topology planner with graph envelope v1.1

Introduces optional LLM-backed topology planner that emits AND/OR/XOR
group structure, subquery scoping, and cross-subquery edges on top of
the Phase 1a deterministic trivial projection. Behind the
CONSTRAINT_GRAPH_TOPOLOGY_LLM feature flag; default off.

- New ADR-012 rationale + replay determinism contract
- Graph envelope schema v1 → v1.1 (optional prompt_version /
  generated_at / llm_model, backward-compat via Zod .optional())
- New ConstraintTopologyPlanner service (intent-gated; single-intent
  queries skip the LLM call)
- New merge-topology-into-trivial (deterministic, idempotent,
  disjoint-namespace asserted)
- Frozen prompt ctg_topology_v1; replay stability locked
- 3 new regression files (~16 cases): schema migration, planner
  semantics, replay stability
- Feature flag + composition-root wiring

Rollback: CONSTRAINT_GRAPH_TOPOLOGY_LLM=false → byte-identical to
trivial-only; CONSTRAINT_GRAPH_EMIT=false → full flat fallback.
```
