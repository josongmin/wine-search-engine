# ADR-015: Axis 2 — Executor-Internal Self-Critique RAG

## Status: Proposed — 2026-04-15

Axis 2 of the
[2026-04-15 improvement plan](../plans/2026-04-15-improvement.md).
Rides on top of:
- [ADR-009](./009-structured-evidence-carrier.md) — `ToolCallEvidenceFrame`
- [ADR-011](./011-constraint-graph-phase-1b-first-reader.md) — graph-aware coverage
- [ADR-013](./013-constraint-graph-phase-1c-bundle-selector.md) — graph-aware
  executor wrapper (the seam that this ADR extends)

## Context

The agent layer already owns one budget / self-correction loop: step-budget
([step-budget.ts](../../src/domain/agent/service/step-budget.ts),
adaptive-budget). That loop is purpose-built for the **between-tool-calls**
decision: "should the agent ask another question or stop?". It does not
observe the *inside* of a single retrieval call. When
`candidatePool.execute` returns a low-coverage or degraded pool, the agent
has already paid for the call and the only recourse is to try an entirely
new tool call — expensive, slow, and often loses the refinement signal
(the agent does not know *why* the retrieval was poor).

Axis 2 operates **one layer down**, inside the executor, between "retrieve
candidates" and "hand to ranker". When the retrieval result fails a
deterministic coverage / degradation predicate, the executor itself rewrites
the retrieval input and retries, without ever bubbling the low-quality
pool up to the agent. The agent-layer step-budget is **untouched** — the
two loops are composable: the agent may still decide to call another tool
after the critic returns its best-effort pool, but the critic's retries
never consume agent steps.

### Why now

- ADR-013 just landed the graph-aware executor wrapper
  (`search-usecase-graph-executor.ts`). That wrapper is the natural seam
  for a retry loop: it already intercepts `candidatePool.execute`.
- PR4 delivered the wrapper as **library code** but did not wire it into
  the production hybrid candidates flow at
  [search-usecase-hybrid-candidates.ts:499](../../src/application/search/search-usecase-hybrid-candidates.ts#L499).
  Without wiring neither the BundleSelector nor the critic runs.
  This ADR's PR (PR6 in the 7-PR train) does both: the PR4 wiring AND
  the critic on top.

### Deterministic-first, LLM-eventual

Day 1 ships a **deterministic** critic. The decision to retry is computed
from signals already produced by the pipeline:

- `computeGraphCoverage.rootSatisfied` / `coverageRatio`
- `provenanceShortfall` (from `buildMissingProvenanceObligations`)
- `retrievalDegradationSignals` (from `CandidatePoolService`)

No LLM call is required to decide *whether* to retry. Three of the four
rewrite strategies — `relax`, `decompose`, `expand_synonym` — are also
deterministic (delegate to the existing
[constraint-relaxation.ts](../../src/domain/query/service/constraint-relaxation.ts)
helpers). Only `reformulate` requires a `ChatLlmPort` call; the critic's
decision tree prefers the three deterministic rewrites and only falls
back to `reformulate` when they are inapplicable.

This keeps the common-case retry path pure (≤100 µs CPU, no network)
and isolates LLM latency to the rewrite branch that genuinely benefits
from it.

## Decision

### 1. Executor-layer, not agent-layer

The critic is wired inside
[search-usecase-graph-executor.ts](../../src/application/search/search-usecase-graph-executor.ts).
The agent layer (`agent-orchestrator.ts`, `step-budget.ts`,
`adaptive-budget.ts`) is untouched. A retry inside the critic counts as
**one** tool call from the agent's perspective.

### 2. Type-level retry cap — NOT an env var

```ts
// src/domain/retrieval/service/retrieval-critic.ts
export const CRITIC_RETRY_MAX = 3 as const;
```

The cap is a module-scope `const`, imported directly by the executor and
by the regression test. It is **not** an env var. A loop without a
hard type-level cap is a catastrophic latency risk: env-var-controlled
caps can be bumped or disabled in production and drift silently. The
regression test asserts `CRITIC_RETRY_MAX === 3` to lock the value at
module-load time.

Loop contract:

```ts
for (let retryCount = 0; retryCount < CRITIC_RETRY_MAX; retryCount += 1) {
  // pre-flight: budget / feature-flag check
  // run retrieval
  // critic decides retry? rewriter builds new input? break on `null`.
}
```

- `retryCount` is a **local** `let` — not mutable from any other scope.
- The check is **pre-flight** (before the LLM / retrieval call) per
  rule 20 of CLAUDE.md's test discipline.
- `rewriter.apply(...)` returning `null` (e.g. LLM malformed JSON) is a
  hard `break` — the loop never continues with stale input.

### 3. Frame schema v1 → v1.1 (retryCount bump)

When the executor retries with byte-identical retrieval input (rewriter
returned the same input it received, or the critic fires twice on
identical low-coverage results), the `ToolCallEvidenceFrame` computed
from the retry would collide on `observationHash` with the previous
frame — evidence-frame deduplication would then silently drop the
retry's frame, and the decision trace would lie about what happened.

The fix is to extend the frame schema with an optional `retryCount`
field and include it in `observationHash` input:

```ts
export const TOOL_EVIDENCE_FRAME_SCHEMA_VERSION = 'tool_evidence_v1_1';

// New optional field, Zod `.optional()`.
readonly retryCount?: number | undefined;

// hash = sha256(observation ++ `|retry=${retryCount ?? 0}`)
```

**Backward compatibility:**

- v1 frames (no `retryCount`) still parse under v1.1 (`.optional()`).
- v1 hashes remain stable when `retryCount` is `undefined` or `0`: the
  hash input appends `|retry=0` in both cases, so a v1 frame re-hashed
  as v1.1 produces the same hex digest.
- A v1.1 frame with `retryCount=2` hashes differently from an otherwise
  identical `retryCount=0` frame — collision is broken.
- The schema version string bumps to `tool_evidence_v1_1` so replay
  harnesses can detect the change. Strict schema parse of a v1 payload
  under the v1.1 Zod schema succeeds because the only added field is
  optional.

### 4. Feature flag: `RETRIEVAL_EXECUTOR_CRITIC`

Default **off**. When off the executor runs exactly one `candidatePool.execute`
call — behaviour byte-identical to pre-PR6. When on, the retry loop
engages. The flag gates the entire loop, including `reformulate`; any
future LLM-critic upgrade will introduce a **new** feature flag rather
than silently changing behaviour under this one.

The flag is checked **once per retrieval**, not per retry. Flipping the
flag mid-flight cannot introduce a partial-loop state.

### 5. Decision table: when does the critic retry?

| `rootSatisfied` | `coverageRatio` | `degradationReasons` | Retry? | Rewrite |
|-----------------|-----------------|----------------------|--------|---------|
| `true`          | `1.0`           | —                    | ❌      | —       |
| `true`          | `≥ 0.8`         | empty                | ❌      | —       |
| `false`         | `0`             | empty                | ✅      | `relax` |
| `false`         | `< 0.5`         | `'no_matches'` present | ✅    | `expand_synonym` |
| `false`         | `0.5 – 0.8`     | any                  | ✅      | `decompose` (if multi-subquery graph) |
| `false`         | any             | all three deterministic inapplicable | ✅ | `reformulate` (LLM) |
| any             | any             | `retryCount ≥ CRITIC_RETRY_MAX` | ❌ | — (exhaustion) |

The rewriter may return `null` (e.g. `relax` on a bundle with only floor
attributes; `reformulate` on malformed LLM JSON). Returning `null` is a
hard `break` from the loop; the counter
`RETRIEVAL_CRITIC_RETRIES_EXHAUSTED` is incremented and the last
retrieval result is handed to the ranker with a
`'critic_retries_exhausted'` degradation reason.

### 6. Failure semantics: retries-exhausted graceful handoff

When all `CRITIC_RETRY_MAX` retries fail to achieve acceptable coverage,
the last retrieval result (whatever it is) is handed to the ranker with
`degradationReasons` containing `'critic_retries_exhausted'`. The
decision trace records the attempted rewrites. The response builder can
surface the degradation; until PR7 (GCE) emits a grounded claim for it,
the signal is trace-only.

### 7. Prompt freezing: `critic_reformulate_v1`

The single LLM-backed rewrite (`reformulate`) uses a **frozen** prompt at
`src/domain/retrieval/service/prompts/critic-reformulate.prompt.ts`.
`prompt_version='critic_reformulate_v1'` is recorded in the rewrite
trace. Changing the prompt requires bumping the version string
(breaking-change convention).

### 8. Deterministic replay

The critic is pure for identical inputs: same graph, same coverage, same
degradation reasons → same decision. Same retrieval input + same rewrite
type → same rewriter output (deterministic helpers). The only
non-determinism is the LLM `reformulate` branch, which is bounded by
`temperature: 0` + `seed` in the frozen prompt.

Bench replay produces identical critic decisions across two runs. This
is locked by a determinism regression test.

## Consequences

**Positive:**
- Executor-internal retries never consume agent step-budget.
- Deterministic day 1 means no LLM cost in the common case.
- Frame-schema fix closes a silent-bug mode (observation-hash collision).
- Fast rollback via `RETRIEVAL_EXECUTOR_CRITIC=false`.

**Negative / risks:**
- Up to 3× latency on worst-case retries (mitigated by deterministic cap).
- `reformulate` costs 1 LLM call per trigger (mitigated by decision-tree
  preference for deterministic rewrites).
- Frame schema v1 → v1.1 bump requires downstream replay harness update
  to recognise the new schema string. Pre-PR6 frames continue to parse
  (pure superset).

## Rollback

Two levels:

1. **Fast**: `RETRIEVAL_EXECUTOR_CRITIC=false` → executor runs one-shot,
   byte-identical to pre-PR6. Frame schema v1.1 still parses v1 frames
   because `retryCount` is optional.
2. **Schema rollback**: remove the optional `retryCount` field. v1
   payloads decode as before; stored v1.1 payloads with `retryCount`
   still decode under v1 (Zod `.strict()` would reject unknown keys,
   but rule 10 of CLAUDE.md's test discipline exempts schemas that may
   contain forward-compat fields; the parsing contract in
   `tool-call-evidence-frame.ts` keeps `.strict()` because `retryCount`
   becomes a known key post-PR6).

No data migration on either rollback.

## References

- [ADR-009 Structured Evidence Carrier](./009-structured-evidence-carrier.md)
- [ADR-013 BundleSelector + graph-aware executor](./013-constraint-graph-phase-1c-bundle-selector.md)
- [2026-04-15 improvement plan, Axis 2](../plans/2026-04-15-improvement.md)
