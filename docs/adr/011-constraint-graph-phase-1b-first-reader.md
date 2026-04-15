# ADR-011: ConstraintGraph Phase 1b.1 — First Reader Migration (provenance-closure)

## Status: Proposed — 2026-04-15

Phase 1b.1 of the [2026-04-15 improvement plan](../plans/2026-04-15-improvement.md)
Axis 1 (ConstraintGraph). Lands the first graph-aware reader and the
formal **graph coverage metric** with AND / OR / XOR group semantics.

Builds directly on [ADR-010 Phase 1a](010-constraint-graph-phase-1a.md)
(commit `c464992`) — the trivial graph projector.

## Context

Phase 1a landed the graph type, deterministic projector, and compiler
emission. All readers remain on `plan.constraints.hard` / `constraintAtoms`,
locked by
[`test/regression/constraint-graph-readers-unchanged.regression.test.ts`](../../test/regression/constraint-graph-readers-unchanged.regression.test.ts).

The first reader to migrate is the **provenance closure** stage —
[`search-usecase-provenance-closure.ts`](../../src/application/search/search-usecase-provenance-closure.ts).
It currently computes hard-constraint coverage as a flat attribute-set
operation over `plan.constraints.hard`. That shape cannot express:

- **XOR-grouped constraints** ("red OR white" — only one slot needs to match).
- **OR-grouped constraints** ("Bordeaux OR Burgundy" — at least one).
- **Group AND nesting** (subquery-scoped requirements).

Phase 1b.1 introduces a graph-aware coverage function that handles these
group semantics, migrates provenance-closure to use it when a graph is
present, and keeps the flat fallback for graph-absent paths.

Phase 1b.1 does **NOT** introduce LLM-emitted topology yet. The trivial
graph from Phase 1a is a single `group_and` root over slot children — so
AND semantics is the only active branch until Phase 1b.2. But the
coverage function MUST support OR / XOR from day one so Phase 1b.2 can
flip LLM emission on without touching the reader.

## Decision

### Graph coverage service (new, pure)

`src/domain/query/service/compute-graph-coverage.ts`

```typescript
export interface GraphCoverageResult {
  readonly matchedAttributes: readonly string[];
  readonly unmetAttributes: readonly string[];
  readonly matchedNodeIds: readonly string[];
  readonly unmetNodeIds: readonly string[];
  /** Share of *required* slot nodes satisfied under group semantics. */
  readonly coverageRatio: number;
  /** Whether the root group is satisfied (AND: all, OR: ≥1, XOR: exactly 1). */
  readonly rootSatisfied: boolean;
}

export function computeGraphCoverage(
  graph: ConstraintGraph,
  satisfiedAttributes: ReadonlySet<string>,
): GraphCoverageResult;
```

**Group semantics** (formal definition):

| Group kind  | Satisfied when |
|-------------|----------------|
| `group_and` | **all** children satisfied |
| `group_or`  | **at least one** child satisfied |
| `group_xor` | **exactly one** child satisfied |

**Slot satisfaction**: `slot` node is satisfied iff its `attribute` is in
the caller-supplied `satisfiedAttributes` set. Phase 1b.1 uses the same
flat attribute-match primitive the existing code uses (matched attributes
returned by the retrieval pipeline) — the upgrade is purely the
group-aware aggregation layer on top.

**`coverageRatio`**: `matchedNodeIds.length / (matchedNodeIds.length + unmetNodeIds.length)`.
For `group_xor`, only one slot contributes to the denominator (the
strongest match); for `group_or`, slots beyond the first required match
do not add to "unmet". For `group_and`, every child adds to both matched
and unmet sets. Precise algorithm is pinned by the regression tests.

### Provenance-closure migration

Extend both stage builders to accept an optional `ConstraintGraph`:

```typescript
export function buildHybridCandidateCoverageStage(
  plan: QueryPlanV1,
  candidates: readonly HybridCandidate[],
  policy: ProvenancePolicy,
  graph?: ConstraintGraph,
): ProvenanceCoverageStage;
```

- When `graph` is provided, compute `matchedConstraintAttributes` /
  `unmetConstraintAttributes` via `computeGraphCoverage`.
- When absent (feature flag off, or Phase 1a trivial-graph path disabled),
  fall back to the existing flat-bundle computation byte-for-byte.
- The response shape (`ProvenanceCoverageStage`) does **not** change —
  the flat `matched/unmetConstraintAttributes: readonly string[]` remains
  the wire contract. Graph is an internal implementation detail at this
  phase.

### CompiledWineQuery plumbing

Add an optional sibling to `CompiledWineQuery`:

```typescript
export interface CompiledWineQuery {
  readonly query: QueryUnderstandingSnapshot;
  readonly execution: EngineExecutionContract;
  readonly plannerTrace?: readonly PolicyDecisionRecord[] | undefined;
  /** Phase 1b.1: optional graph passthrough from QueryPlanV2.constraintGraph. */
  readonly constraintGraph?: ConstraintGraph | undefined;
}
```

Copied by `ExecutionCompiler.compile()` from `plan.constraintGraph` when
present. Absent otherwise. Consumers that haven't migrated simply ignore
the field.

### Reader allow-list update

[`constraint-graph-readers-unchanged.regression.test.ts`](../../test/regression/constraint-graph-readers-unchanged.regression.test.ts)
is append-only, but its `PHASE_1A_ALLOWLIST` expands to include:

- `src/domain/query/service/compute-graph-coverage.ts` (new coverage service)
- `src/domain/query/model/compiled-wine-query.ts` (passthrough field)
- `src/application/search/search-usecase-provenance-closure.ts` (first migrated reader)

The test docstring is updated to reflect Phase 1b.1 authorised readers,
but the test file itself is never deleted (append-only regression
discipline).

### Feature flag

`CONSTRAINT_GRAPH_EMIT` from Phase 1a remains the single switch. When
off, graph is `undefined` everywhere and provenance-closure takes the
flat fallback path — byte-identical behaviour to pre-Phase-1b.1.

No new flag is introduced; Phase 1b.1 rolls back through the same lever.

## Implementation scope

| File | Change |
|------|--------|
| `src/domain/query/service/compute-graph-coverage.ts` | New — pure AND/OR/XOR coverage function |
| `src/domain/query/model/compiled-wine-query.ts` | Add `constraintGraph?` optional passthrough |
| `src/domain/query/service/execution-compiler.ts` | Copy `plan.constraintGraph` into the compiled query |
| `src/application/search/search-usecase-provenance-closure.ts` | Accept optional graph, prefer graph path |
| `src/application/search/search-usecase-hybrid-ranking-pipeline.ts` | Pass `compiled.constraintGraph` to stage builders |

Specialized-retrieval call-sites in `search-usecase-hybrid-candidates.ts`
(producer/region/compare/browse) deliberately stay on the flat path for
Phase 1b.1 and will migrate in a later sub-phase — the
`ProvenanceCoverageStage` contract is unchanged, so the two paths
interop.
| `test/regression/constraint-graph-readers-unchanged.regression.test.ts` | Allow-list expansion (append-only edit) |
| **Regression tests** | New files locking coverage semantics (AND/OR/XOR), reader migration parity, CompiledWineQuery passthrough |

## Cutover gate for Phase 1b.1

1. `computeGraphCoverage` regression suite green on 12+ cases covering
   AND / OR / XOR / nested group combinations plus the empty-graph and
   single-slot edge cases.
2. Provenance-closure behavioural parity: with the trivial graph from
   Phase 1a, `matched/unmetConstraintAttributes` output is byte-identical
   to the flat-bundle path. Locked by a regression test.
3. `pnpm run git:prepush` green on two consecutive nightly runs.
4. `CONSTRAINT_GRAPH_EMIT=false` continues to produce the pre-Phase-1b.1
   result byte-for-byte.

Phase 1b.2 (LLM-emitted topology: XOR / shares_budget / subquery) begins
only after Phase 1b.1 gate holds.

## Rollback plan

Identical to Phase 1a: `CONSTRAINT_GRAPH_EMIT=false` → graph becomes
`undefined` → provenance-closure takes the flat fallback → behaviour is
byte-identical to pre-Phase-1b.1. No schema migration, no code change.

## Open questions deferred to Phase 1b.2

- **Shared-budget semantics in coverage**: `shares_budget` edges impose
  cross-slot resource constraints. Phase 1b.1 ignores edges entirely
  (node-kind only). Phase 1b.2 folds budget edges into coverage as
  "satisfied" ↔ "assigned within budget".
- **Subquery-scoped coverage**: multi-subquery graphs need per-subquery
  coverage decomposition. Phase 1b.1 uses a single root group only.
- **`depends_on` edges**: topological ordering of slot evaluation.
  Not material for coverage at this phase.

## References

- [ADR-010 Phase 1a](010-constraint-graph-phase-1a.md) — the graph type
  and projector this reader consumes.
- [2026-04-15 plan rev 2 Axis 1](../plans/2026-04-15-improvement.md#axis-1--constraintgraph-v2-planner-plane)
- [search-usecase-provenance-closure.ts](../../src/application/search/search-usecase-provenance-closure.ts) —
  the reader migrating.
- [compiled-wine-query.ts](../../src/domain/query/model/compiled-wine-query.ts) —
  the passthrough seam.
