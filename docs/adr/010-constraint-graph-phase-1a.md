# ADR-010: ConstraintGraph Phase 1a — Deterministic Projector

## Status: Proposed — 2026-04-15

Phase 1a of the [2026-04-15 improvement plan](../plans/2026-04-15-improvement.md)
Axis 1 (ConstraintGraph). Phase 1a introduces the graph type and a
deterministic atom → trivial-graph projector. Phase 1b (LLM planner) and
Phase 1c (BundleSelector) ride on top of the contract landed here.

## Context

The 2026-04-15 plan rev 2 re-scan surfaced that
[`QueryPlanV2`](../../src/domain/query/model/query-plan.ts#L126) and
[`ConstraintAtom`](../../src/domain/shared/types/constraint-atom.ts#L17)
already exist. The missing piece is not the IR — it is the **topology**
over the IR:

- `ConstraintAtom[]` is a flat list. It cannot express:
  - "3 sub-queries sharing a 150k KRW budget" (multi-course pairing)
  - "this constraint XORs with that one" (user picks one of two)
  - "resolve the anchor entity first, then anchor-scoped retrieval" (depends_on)
  - "these two complement each other as a pairing set" (pairing complementarity)

Phase 1a lands the smallest possible step that unblocks Phase 1b/c:

1. Define the graph type + closed schema.
2. Provide a deterministic projector that turns existing atoms into a
   "trivial graph" (one AND group, all atoms as slot nodes, no edges, no
   shared budget). This gives every existing request a graph emission
   without any planner-layer change.
3. Add the graph as an optional sibling on `QueryPlanV2` and on
   `ConstraintCompilerResult`.
4. Leave **all downstream readers unchanged** — they continue reading
   `bundle.hard / soft / inferred` and `constraintAtoms`. Graph-aware
   readers are added in Phase 1b onward.

## Decision

### Graph type

```typescript
export const CONSTRAINT_GRAPH_SCHEMA_VERSION = 'constraint_graph_v1';

export interface ConstraintGraph {
  readonly graphSchemaVersion: 'constraint_graph_v1';
  readonly rootNodeId: string;
  readonly nodes: readonly ConstraintGraphNode[];
  readonly edges: readonly ConstraintGraphEdge[];
  readonly globalBudgets: GlobalBudgetSet;
  /**
   * Phase 1a projector origin. `'deterministic_from_atoms'` flags that the
   * graph was synthesised from a flat atom list without planner-level
   * topology — i.e. all slots are AND-composed under the root. Phase 1b
   * will introduce `'planner_emitted'` and `'hybrid'` origins.
   */
  readonly origin: ConstraintGraphOrigin;
}

export type ConstraintGraphOrigin =
  | 'deterministic_from_atoms'
  | 'planner_emitted'      // Phase 1b
  | 'hybrid';              // Phase 1b

export type ConstraintGraphNode =
  | SlotNode
  | SubqueryNode
  | GroupAndNode
  | GroupOrNode
  | GroupXorNode;

export interface SlotNode {
  readonly kind: 'slot';
  readonly nodeId: string;           // stable hash of (attribute, operator, value, tier)
  readonly atomRef: string;          // index into QueryPlanV2.constraintAtoms
  readonly attribute: string;
  readonly operator: ConstraintOperator;
  readonly value: SlotValue;
  readonly sourceTier: ConstraintTier;
  readonly sourceKind: ConstraintSourceKind;
  readonly confidence: number;       // [0, 1] — carries atom.confidence
}

export interface SubqueryNode {
  readonly kind: 'subquery';
  readonly nodeId: string;
  readonly purpose: string;          // e.g. 'appetiser', 'main_course'
  readonly targetCardinality: number;
}

export interface GroupAndNode {
  readonly kind: 'group_and';
  readonly nodeId: string;
  readonly children: readonly string[];
}
export interface GroupOrNode {
  readonly kind: 'group_or';
  readonly nodeId: string;
  readonly children: readonly string[];
}
export interface GroupXorNode {
  readonly kind: 'group_xor';
  readonly nodeId: string;
  readonly children: readonly string[];
}

export type ConstraintGraphEdge =
  | { readonly kind: 'shares_budget'; readonly from: string; readonly to: string; readonly resource: BudgetResource }
  | { readonly kind: 'complements'; readonly from: string; readonly to: string; readonly reason: ComplementReason }
  | { readonly kind: 'depends_on'; readonly from: string; readonly to: string };

export type BudgetResource = 'price_total' | 'time' | 'count';
export type ComplementReason = 'meal_course' | 'pairing' | 'variety';

export interface GlobalBudgetSet {
  readonly priceTotal?: { readonly currency: 'KRW' | 'USD'; readonly max: number };
  readonly candidateCount?: number;
  readonly walltime?: number;
}

export type SlotValue =
  | string
  | number
  | ReadonlyArray<string>
  | { readonly min: number; readonly max: number };
```

### Deterministic projector

```typescript
buildTrivialGraphFromAtoms(atoms: readonly ConstraintAtom[]): ConstraintGraph
```

Invariants:
- The returned graph has exactly one `group_and` root, holding every atom
  as a `slot` child.
- `slot.nodeId` is a deterministic hash of the atom's identifying fields
  so two runs on the same input produce byte-identical graphs.
- `slot.atomRef` is the stringified index into the caller's atom array —
  callers should keep the atom ordering stable.
- `globalBudgets` is **always empty** for the trivial projection. Phase 1b
  extracts `priceTotal` from hard price constraints.
- `origin = 'deterministic_from_atoms'`.

Phase 1a explicitly does **not** attempt to infer XOR groups, shared
budgets, or subquery decomposition. Those are signal-rich LLM territory.

### Field placement

- **`QueryPlanV2.constraintGraph?: ConstraintGraph | undefined`** — new optional
  field. Populated by `ConstraintCompiler.compile()` whenever it produces atoms.
- **`ConstraintCompilerResult.constraintGraph?: ConstraintGraph | undefined`** —
  sibling field alongside the existing `bundle`, `reasonerOutput`,
  `retrievalPlan`. Bridges the compiler → planner-adapter seam.

Downstream readers (`provenance-closure`, `decision-input`, ranker input):
**unchanged in Phase 1a**. They continue reading `bundle.hard` and
`constraintAtoms`. The graph is additive until Phase 1b, which migrates the
first reader (`provenance-closure`) to consume graph topology where present.

### Feature flag

`CONSTRAINT_GRAPH_EMIT` (env-driven, default `true`). Flag off suppresses
graph projection at the compiler seam — `constraintGraph` becomes
`undefined` everywhere and readers continue with atoms/bundle only. Fully
reversible without schema migration.

## Implementation scope

| File | Change |
|------|--------|
| `src/domain/query/model/constraint-graph.ts` | New — type + Zod schema |
| `src/domain/query/service/build-trivial-graph-from-atoms.ts` | New — deterministic projector |
| `src/domain/query/service/constraint-compiler.ts` | `ConstraintCompilerResult.constraintGraph` sibling + projector call |
| `src/domain/query/model/query-plan.ts` | `QueryPlanV2.constraintGraph?` new optional field |
| **Regression tests** | 6+ new files locking schema, projector determinism, parity |

`ConstraintBundle`, `ConstraintAtom`, `liftBundleToAtoms`, readers (7
call sites of `plan.constraints.hard`) — **unchanged**.

## Cutover gate for Phase 1a

- Trivial graph emitted on ≥99% of bench scenarios (measured via new
  `constraintGraphEmissionRate` in bench summary — follows the evidence
  frame coverage pattern from Phase 0).
- Regression tests green on two consecutive nightly runs.
- Zero behavioural regression on the existing `scrInferred` /
  `csrInferred` / ELA metrics (graph is additive; readers untouched).

Phase 1b (LLM-emitted graph topology + XOR / budget extraction) begins
only after Phase 1a gate holds.

## Rollback plan

1. Set `CONSTRAINT_GRAPH_EMIT=false` → `ConstraintCompiler` stops
   projecting the graph; `constraintGraph` becomes `undefined` on every
   plan and compiler result.
2. Readers are unchanged — flag off restores byte-identical pre-Phase-1a
   behaviour.
3. Schema files remain on disk but are unreferenced. No migration.

Full rollback ≈ one environment-variable flip.

## Alternatives considered

### Alt A — Replace `ConstraintAtom` with graph slot nodes

"Promote SlotNode to be the authoritative atom." Rejected: breaks every
current `constraintAtoms` consumer. Phase 1a must ship without touching
that contract.

### Alt B — Build graph only when LLM emits topology

"Skip the trivial projector; graph exists only when Phase 1b lands."
Rejected: downstream readers in Phase 1b/c would need a two-branch code
path (graph-present vs atoms-only) forever. The trivial projector lets
every request emit a graph immediately so the downstream surface is
uniform.

### Alt C — Put graph on `CompiledWineQuery` instead of `QueryPlanV2`

"The compiled query is the thing execution consumes." Rejected: the
planner produces topology; the compiler produces execution strategy. The
topology belongs on the planner output and flows through the compiler.
`CompiledWineQuery` already derives `query: QueryUnderstandingSnapshot`
from `QueryPlanV2` — graph follows the same path.

## Open questions (Phase 1a only)

1. **atomRef stability under re-ordering**: atoms have no intrinsic ID
   today. Phase 1a uses the index in `constraintAtoms` as the ref.
   Acceptable because the array is produced deterministically by
   `liftBundleToAtoms`, but we should revisit if atoms ever get shuffled.
2. **Graph serialisation for replay**: the graph is part of
   `QueryPlanV2`, which is serialised in some test fixtures but not in
   the wire response. Replay fixture schema may need extension in
   Phase 1b before the graph becomes semantically meaningful.
3. **Graph coverage metric**: `scrInferred` / `csrInferred` definitions
   assume flat buckets. Phase 1b needs to redefine these against graph
   nodes. Phase 1a does not touch them.

## References

- [2026-04-15 plan rev 2](../plans/2026-04-15-improvement.md) §Axis 1
- [ADR-009 Phase 0](009-structured-evidence-carrier.md) — the evidence
  carrier this plan builds on
- [constraint-atom.ts](../../src/domain/shared/types/constraint-atom.ts)
  — existing atom IR
- [query-plan.ts](../../src/domain/query/model/query-plan.ts) — V2 shape
  this ADR extends
