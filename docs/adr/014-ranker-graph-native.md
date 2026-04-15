# ADR-014: ConstraintGraph Phase 1b.3b — Ranker & Retrieval Annotator Graph-Native

## Status: Proposed — 2026-04-15

Phase 1b.3b of the [2026-04-15 improvement plan](../plans/2026-04-15-improvement.md)
Axis 1 (ConstraintGraph). Migrates the **ranker hard/soft gate predicates**
and the **retrieval annotator per-atom match records** from flat
`ConstraintBundle` semantics to graph-native AND / OR / XOR semantics.

Anchor: [ADR-011 Phase 1b.1](011-constraint-graph-phase-1b-first-reader.md),
[ADR-011 Phase 1b.3a](011-constraint-graph-phase-1b-first-reader.md#phase-1b3a)
(PR1 — `decision-input` + pre-rank coverage).

Upstream PRs this train: PR3 (topology planner, ADR-012), PR4 (bundle
selector, ADR-013). This ADR is parallel-safe with PR3/PR4 when bench
flags are coordinated.

## Context

PR1 (Phase 1b.3a) migrated `provenance-closure` and `decision-input` to
graph-aware coverage via the shared helper `resolveRequiredAttributes`.
The following plane still reads flat `ConstraintBundle` / `plan.constraints`:

| File | Reader | Semantic |
|------|--------|----------|
| [`signal-computer.ts:168`](../../src/domain/ranking/service/signal-computer.ts#L168) | `evaluateHardConstraints` | flat AND-all over `constraints.hard` |
| [`signal-computer.ts:201`](../../src/domain/ranking/service/signal-computer.ts#L201) | `computeSoftConstraint` | flat confidence-weighted average |
| [`candidate-constraint-evidence.ts:357`](../../src/domain/retrieval/service/candidate-constraint-evidence.ts#L357) | `annotateCandidateConstraintEvidence` | flat `{hard, soft, inferred}` bucket sets without `atomRef` |
| [`ranker.ts:629`](../../src/domain/ranking/service/ranker.ts#L629) | ranked-result constraint state | flat attribute names |
| [`browse-retriever.ts:51`](../../src/domain/retrieval/service/browse-retriever.ts#L51) | filter extraction | `constraints.hard` |
| [`compare-retriever.ts:81`](../../src/domain/retrieval/service/compare-retriever.ts#L81) | filter extraction | `constraints.hard` |

Under a graph with OR / XOR branches, flat AND-all:
- incorrectly **gates out** candidates that satisfy exactly one branch of
  an OR (e.g. "Bordeaux OR Burgundy" — a Bordeaux fails the gate because
  `burgundy` is "unmet").
- incorrectly **accepts** candidates that satisfy more than one XOR
  branch (e.g. "red XOR white" — a sparkling rosé that matches both
  passes when it should fail).

This is **not** a reader migration like PR1: it is a **gate predicate
rewrite**. The hard gate determines which candidates reach ranking at
all; changing it can change which results are shown for any query whose
graph encodes disjunctive constraints.

## Decision

### 1. Hard gate predicate (NEW: `evaluateGraphHardGate`)

`src/domain/ranking/service/graph-hard-gate.ts`

```typescript
export function evaluateGraphHardGate(input: {
  readonly graph: ConstraintGraph;
  readonly matchedAttributes: ReadonlySet<string>;
}): boolean;
```

Delegates to `computeGraphCoverage` on the hard-tier subgraph and returns
`rootSatisfied`. Attribute satisfaction is still the unit primitive
(caller supplies the set); the helper adds AND / OR / XOR composition.

### 2. Soft weight helper (NEW: `computeGraphSoftWeight`)

`src/domain/ranking/service/graph-soft-weight.ts`

```typescript
export function computeGraphSoftWeight(input: {
  readonly graph: ConstraintGraph;
  readonly matchedAttributes: ReadonlySet<string>;
}): number;
```

Returns the coverage ratio of the soft-tier subgraph under the same
AND / OR / XOR composition rules. On a trivial graph this collapses to
"matched soft slots / required soft slots", matching the pre-PR5
`computeSoftConstraint` output for boost-less plans.

The ranker's `computeSoftConstraint` retains its existing retrievalPlan
boost-weighted path when boosts are present — the graph helper is a
**fallback for graph-aware branch semantics**, not a replacement for the
per-attribute confidence weighting.

### 3. Signal-computer widening

```typescript
evaluateHardConstraints(
  candidate, constraints,
  matchedSet?, graph?: ConstraintGraph | undefined,
): boolean;

computeSoftConstraint(
  candidate, constraints,
  retrievalPlan?, precomputedMatchedSet?,
  graph?: ConstraintGraph | undefined,
): number;
```

Semantics:
- **Graph present** → delegate hard gate to `evaluateGraphHardGate`;
  soft weight to `computeGraphSoftWeight` (when no structured boosts are
  active for that tier).
- **Graph absent** → existing flat path, byte-identical to pre-PR5.

### 4. Annotator per-atom records (NEW: `matchedAtomRefs`)

`annotateCandidateConstraintEvidence` accepts an optional `graph` and
emits a new `matchedAtomRefs` / `unmetAtomRefs` pair on the annotated
`HybridCandidate`. Each record keys to the graph's `SlotNode.atomRef`, so
"same attribute satisfied via slot A vs slot B" is distinguishable
downstream. The flat `matchedConstraints` / `unmetHardConstraints` fields
are retained for backward compatibility (no consumer drift in PR5).

When the graph is absent, no `atomRef` fields are set — strict
`exactOptionalPropertyTypes` compatibility.

### 5. Ranker ranked-result widening

`RankedResult` gains optional `matchedAtomRefs?: readonly string[]` and
`unmetAtomRefs?: readonly string[]`. The flat
`matchedConstraints` / `unmetConstraints` arrays remain for backward
compatibility. Removal is deferred to a future cleanup PR gated on all
consumers migrating.

### 6. Specialized retriever graph-slot filter extraction

`browseProducer`, `browseRegion`, `compareAgainstAnchor` accept an
optional `graph` arg. When present, filter tokens are derived from the
hard-tier slot subgraph — trivial-graph emission is byte-identical to the
current `hardConstraintsToSparseFilterTokens(constraints.hard)` path.
Hybrid graphs flatten OR/XOR disjunctions to the union of their slot
attribute-values (Vespa filter tokens are AND-of-ORs by construction).

## Parity contract (trivial graph)

**Byte-identical** ranked output is a **build-breaker gate** on trivial
graphs. This is tightened from the task doc's original ±1pp wording —
trivial-graph parity is enforced exactly to avoid silent drift over the
two-nightly shadow window.

Concretely, for any query whose graph is the Phase-1a trivial projection
(single `group_and` root, every atom as a slot child), the following
must be pairwise-equal pre- and post-PR5:

- Hard-gate pass set (entity IDs)
- Ranked-result order
- Each `RankedResult.finalScore`
- Each `RankedResult.componentScores`

Locked by [`test/regression/ranker-trivial-graph-parity.regression.test.ts`](../../test/regression/ranker-trivial-graph-parity.regression.test.ts).

## Feature flags

- `CONSTRAINT_GRAPH_EMIT` (pre-existing, default behaviour inherited
  from ADR-010/ADR-011) — when `false`, no graph is projected and every
  widened function takes the flat fallback → byte-identical to pre-PR5.
- `RANKER_GRAPH_NATIVE_SHADOW` (new) — when `true`, bench harness emits
  both flat and graph-aware results side-by-side without affecting
  production. Two-nightly green shadow run required before production
  flip.

No new default-on flag in PR5. The graph-aware path becomes default only
when `CONSTRAINT_GRAPH_EMIT=true` AND the compiled query has a non-empty
graph — the gate is entirely data-driven.

## Breaking-change boundary

Consumers of `RankedResult[]` who gate on `matchedConstraints` as a flat
attribute set continue to work (field preserved). Consumers that
reconstruct hard-gate semantics from the flat list (historically there
were none — the authoritative gate has always been inside the ranker)
would observe graph-aware pass/fail under OR/XOR queries. PR5 keeps the
hard gate authoritative in the ranker; no downstream caller needs to
change to obtain correct semantics.

## Specialized-retriever extraction decision table

| Graph shape | `browseProducer` / `browseRegion` / `compareAgainstAnchor` filter emission |
|-------------|----------------------------------------------------------------------------|
| Trivial (AND-all over slots) | byte-identical to `hardConstraintsToSparseFilterTokens(constraints.hard)` |
| OR-rooted (all children under `group_or`) | union of each branch's slot tokens |
| XOR-rooted | union of each branch's slot tokens (filter cannot express XOR; downstream ranker applies the true XOR gate) |
| Nested AND/OR/XOR | hard-tier leaves extracted recursively; subquery boundaries ignored at filter emission (planner handles per-subquery dispatch) |

The table is locked by
[`test/regression/specialized-retriever-graph-slot-extraction.regression.test.ts`](../../test/regression/specialized-retriever-graph-slot-extraction.regression.test.ts).

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Hard gate flips on any query with disjunctive constraints | Trivial-graph parity byte-identical; 10-case `ranker-graph-hard-gate.regression.test.ts`; two-nightly shadow bench. |
| `matchedConstraints` consumer drift over time | Keep both fields; cleanup deferred to future PR gated on consumer migration. |
| Annotator deduplication semantic change | `matchedConstraints` retains pre-PR5 dedup; `matchedAtomRefs` is a new non-deduplicated field. |
| `noUncheckedIndexedAccess` breakage on `atomRefs[i]` | Helpers iterate via `for…of`; no indexed access. |

## Rollback plan

- **Fast rollback**: set `CONSTRAINT_GRAPH_EMIT=false`. Graphs become
  `undefined` everywhere; every widened function takes the flat fallback.
  Byte-identical to pre-PR5.
- **Shadow flip-back**: set `RANKER_GRAPH_NATIVE_SHADOW=true` and keep
  serving flat path in production while debugging — no code revert needed.

## Consequences

- Ranker, annotator, and specialized retrievers now share a single
  semantic vocabulary for constraint satisfaction (graph root-satisfied).
- `matchedAtomRefs` unlocks downstream explainability — "matched via
  slot A vs slot B" is now observable.
- `matchedConstraints` becomes a legacy compatibility surface; a future
  cleanup PR will remove it once all consumers migrate.
- Retrieval plane constraint-semantic drift is eliminated: PR1 + PR5
  together complete the ranker/annotator side of Phase 1b.
