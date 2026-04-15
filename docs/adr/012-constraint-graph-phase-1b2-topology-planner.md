# ADR-012: ConstraintGraph Phase 1b.2 — LLM Topology Planner

## Status: Proposed — 2026-04-15

Phase 1b.2 of the [2026-04-15 improvement plan](../plans/2026-04-15-improvement.md)
Axis 1. Introduces an **optional LLM-backed topology planner** on top of
the Phase 1a deterministic trivial projector. Builds on
[ADR-010 Phase 1a](010-constraint-graph-phase-1a.md) and
[ADR-011 Phase 1b.1/1b.3a](011-constraint-graph-phase-1b-first-reader.md).

## Context

Phase 1a's projector collapses every atom into a single `group_and` root.
That shape cannot express:
- **XOR disjunctions**: "빨간 고기에는 레드, 생선에는 화이트" — two
  mutually exclusive wine types.
- **OR alternatives**: "보르도 아니면 부르고뉴".
- **Subquery scoping**: "메인 + 디저트 페어링".
- **Cross-subquery budgets**: "3병 합해서 15만원" — shared resource.

`ConstraintReasoner` ([constraint-reasoner.ts:120](../../src/domain/query/service/constraint-reasoner.ts#L120))
is a pure O(n²) pairwise in-process service — **not LLM-backed** — and
stays that way. Phase 1b.2 introduces a **NEW service** that follows the
same `ChatLlmPort` seam as
[LlmNLMapper](../../src/domain/attribute/service/llm-nl-mapper.ts#L420).

## Decision

### Graph envelope schema `v1 → v1.1`

Add three optional replay-metadata fields. Backward-compatible via Zod
`.optional()` — v1 JSON parses unchanged under v1.1 Zod (no required new
field). v1 literal stays accepted; v1.1 adds a sibling literal so the
schema-version union is `'constraint_graph_v1' | 'constraint_graph_v1.1'`.

```ts
readonly promptVersion?: string;   // e.g. 'ctg_topology_v1'
readonly generatedAt?: string;     // ISO-8601, excluded from replay hash
readonly llmModel?: string;        // e.g. 'claude-opus-4-6'
```

Deterministic graphs from the trivial projector stay on `v1` unchanged —
only graphs that carry LLM-sourced topology bump to `v1.1`. Rollback is
pure Zod version-pin (no data migration; every v1.1 envelope remains
valid under the v1.1 Zod forever).

### `ConstraintTopologyPlanner` (new service)

```ts
export class ConstraintTopologyPlanner {
  constructor(private readonly chatLlm: ChatLlmPort) {}

  async plan(input: {
    readonly atoms: readonly ConstraintAtom[];
    readonly normalizedQuery: string;
    readonly decompositionHint?: QueryDecompositionHint;
    readonly abortSignal?: AbortSignal;
  }): Promise<ConstraintGraph | null>;
}
```

Contract:
- **Pure wrt external state**: no DB, no cache, no logging side-effects
  beyond telemetry counters.
- **Failure semantics**: any error — LLM timeout, invalid JSON, Zod
  rejection, namespace collision with trivial nodes — returns `null`.
  Caller (ConstraintCompiler) falls back to the trivial graph.
- **Determinism**: temperature 0, frozen prompt, sorted JSON output.
  Identical `{atoms, normalizedQuery}` produces identical topology bytes
  (modulo `generatedAt` which is excluded from the replay hash).
- **Intent gate**: the planner **opts out** when the caller hasn't
  flagged multi-subquery or XOR-smell. See §Intent gate below.

### `mergeTopologyIntoTrivial` (new pure function)

Merges the LLM-emitted topology with the deterministic trivial graph:

```ts
export function mergeTopologyIntoTrivial(
  trivial: ConstraintGraph,
  topology: ConstraintGraph,
): ConstraintGraph | null;
```

Invariants:
- **Disjoint node-id namespaces**: trivial slot nodes use
  `slot-<hash>`; topology must use `topology/*` prefix. Collision →
  merge returns `null` (fail-closed).
- **Slot nodes anchored to atoms**: the merge cannot rewrite or drop
  trivial slot nodes — only add group/subquery/edge structure on top.
- **Root reassignment**: topology can designate a new root (typically a
  group node wrapping trivial slots), but the original trivial root
  must be discoverable as a descendant.
- **Idempotent**: `merge(trivial, merge(trivial, t)) ===
  merge(trivial, t)` byte-for-byte.
- **Origin**: output `origin: 'hybrid'`.

### Intent gate

LLM latency on every compile is a p99 killer. The planner is **only
invoked** when one of:

1. `decompositionHint.subQueryCount > 1` —
   [query-decomposition.ts:15](../../src/domain/query/model/query-decomposition.ts#L15).
2. `normalizedQuery` matches a minimal XOR-smell regex —
   `TOPOLOGY_INTENT_GATE_KEYWORDS` SSoT constant. Initial set:
   - Korean: `각각`, `따로`, `반반`, `또는`.
   - English: `\beither\b`, `\bone .* other\b`, `\bor\b` (word-bounded
     per Unicode-safe regex discipline).

Single-intent queries take the pure-trivial fast path. Intent gate
keyword list is a SSoT constant and adding to it requires an ADR
amendment — drift-proof against ad-hoc keyword grooming.

### Feature flag

`CONSTRAINT_GRAPH_TOPOLOGY_LLM` — env flag, default **off**. Read once
at compiler construction time (not per request). Off → the compiler
never constructs the planner branch and falls through to trivial.

Coexists with `CONSTRAINT_GRAPH_EMIT`: `EMIT=false` suppresses graph
entirely, `TOPOLOGY_LLM=false` suppresses only LLM topology but keeps
trivial. Two-level rollback.

### Prompt versioning

Frozen prompt in
[constraint-graph-topology.prompt.ts](../../src/domain/query/service/prompts/constraint-graph-topology.prompt.ts)
with `promptVersion: 'ctg_topology_v1'`. The version is part of the
graph envelope so bench replays detect drift. Vendor-side behaviour
drift (Anthropic / OpenAI model updates) is surfaced by replay
regression failing — at which point the ADR requires a bump to
`ctg_topology_v2`, NOT silent swap.

## Implementation scope

| File | Change |
|------|--------|
| `src/domain/query/model/constraint-graph.ts` | Schema v1.1 union; `promptVersion?`/`generatedAt?`/`llmModel?` optional fields; Zod `.optional()`. |
| `src/domain/query/service/constraint-topology-planner.ts` | **NEW** — planner service. |
| `src/domain/query/service/merge-topology-into-trivial.ts` | **NEW** — pure merge. |
| `src/domain/query/service/prompts/constraint-graph-topology.prompt.ts` | **NEW** — frozen prompt. |
| `src/domain/query/service/constraint-compiler.ts` | Constructor widens: optional `topologyPlanner`; hot path gated on env flag + intent gate. |
| `src/domain/query/service/planner.ts` | Forward planner instance. |
| `src/config/container-core-builders.ts` | Flag-gated instantiation from `ChatLlmPort`. |
| **Regression tests** | Schema migration, planner semantics, replay stability. |

## Cutover gate

1. Trivial graph parity preserved (`TOPOLOGY_LLM=false` → byte-identical
   to pre-PR3). Locked by regression.
2. Replay stability: ≥3 scenarios identical across runs.
3. On XOR subset of bench, `scrInferredGraph` (PR2 dual metric)
   improves ≥5pp vs trivial baseline.
4. `pnpm run git:prepush` green.
5. Flag off → compiler never imports planner class beyond the branch
   condition (lint-enforced dead-code check).

## Rollback

- Fast: `CONSTRAINT_GRAPH_TOPOLOGY_LLM=false` → planner never called.
- Full: `CONSTRAINT_GRAPH_EMIT=false` → graph not emitted at all.

Schema v1.1 envelopes remain valid forever (pure superset).

## Open questions deferred

1. **Multi-vendor schema enforcement**: Anthropic `tool_use` vs OpenAI
   `json_schema` enforcement strength — this PR uses post-hoc Zod
   validation as the single strength boundary.
2. **Subquery budget post-assignment** — PR4 BundleSelector.
3. **Critic retry on failed topology** — PR6 Axis 2.
4. **Intent gate keyword list growth** — requires ADR amendment, not
   ad-hoc edit.

## References

- [ADR-010 Phase 1a](010-constraint-graph-phase-1a.md)
- [ADR-011 Phase 1b.1/1b.3a](011-constraint-graph-phase-1b-first-reader.md)
- [PR3 task.md](../plans/2026-04-15-adr-012-phase-1b2-topology-planner/task.md)
- [LlmNLMapper precedent](../../src/domain/attribute/service/llm-nl-mapper.ts#L420)
