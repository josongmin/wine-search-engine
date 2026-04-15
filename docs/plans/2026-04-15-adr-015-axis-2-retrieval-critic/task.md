# PR6 — ADR-015 Axis 2: executor-internal self-critique RAG

> **Scope envelope**: introduce a **deterministic-first** retrieval
> critic and query rewriter inside the executor (not the agent), with
> a type-level retry cap of 3 and a `ToolCallEvidenceFrame` schema
> v1 → v1.1 bump that adds `retryCount` to prevent `observationHash`
> collisions on byte-identical internal retries.
>
> **Parent plan**: [2026-04-15-improvement.md](../2026-04-15-improvement.md)
> Axis 2 / self-critique RAG. **Upstream**: [ADR-009](../../adr/009-structured-evidence-carrier.md)
> (`ToolCallEvidenceFrame`), [ADR-013](../../adr/013-bundle-selector-graph-aware-executor.md)
> (graph executor wrapper — shared surface).
> **This PR drafts ADR-015**.
>
> **Anchor commit**: PR4 (ADR-013) HEAD preferred. If PR4 has not
> landed, this PR creates the executor wrapper itself (see §4).

---

## 1. Why this PR

The agent layer has its own budget and self-correction loop
([step-budget.ts:16-49](../../../src/domain/agent/service/step-budget.ts#L16),
adaptive-budget.ts). These are **untouched** — Axis 2 operates one
layer down, inside the executor, between "retrieve candidates" and
"hand to ranker".

The point insertion is [search-usecase-hybrid-candidates.ts:499](../../../src/application/search/search-usecase-hybrid-candidates.ts#L499) —
just before `ports.candidatePool.execute(retrievalInput)`. The critic
examines the retrieval outcome (coverage, degradation reasons) and
optionally rewrites the sub-query and retries, up to `CRITIC_RETRY_MAX = 3`.

**Day-1 semantics are deterministic-first**:
- Critic decides retry from `computeGraphCoverage` + existing
  `degradation_reasons` signals. **No LLM call on day 1.**
- Rewriter applies `relax` / `decompose` / `expand_synonym` via the
  existing [constraint-relaxation.ts](../../../src/domain/query/service/constraint-relaxation.ts).
  Only `reformulate` requires an LLM.

This isolates LLM latency to one rewrite type and keeps the retry
loop pure in the common case.

**Explicit non-scope**:
- Agent-layer budget/step-budget changes — out of scope.
- Ranker gate rewrite (PR5).
- Grounded claims (PR7).
- New retrieval channels — critic loops over existing channels only.

---

## 2. File-by-file change checklist

### 2.1 New files

| File | Purpose |
|------|---------|
| [docs/adr/015-axis-2-retrieval-critic.md](../../adr/015-axis-2-retrieval-critic.md) | New ADR: executor-layer vs agent-layer boundary, deterministic-first rationale, retry-cap constant policy (type-level not env-var), frame schema v1.1 bump, failure semantics (retries exhausted → counter + graceful handoff to ranker with degradation reason). |
| [src/domain/retrieval/service/retrieval-critic.ts](../../../src/domain/retrieval/service/retrieval-critic.ts) | Pure service `shouldRetry({ graph, coverage, degradationReasons, retryCount, criticRetryMax }): CriticDecision`. CriticDecision is `{ retry: false } \| { retry: true; rewriteType: 'relax' \| 'decompose' \| 'expand_synonym' \| 'reformulate'; subqueryId: string }`. No LLM calls. |
| [src/domain/retrieval/service/query-rewriter.ts](../../../src/domain/retrieval/service/query-rewriter.ts) | Applies a rewrite. Deterministic branches (`relax` / `decompose` / `expand_synonym`) delegate to existing [constraint-relaxation.ts](../../../src/domain/query/service/constraint-relaxation.ts). `reformulate` branch calls `ChatLlmPort` with a frozen prompt `prompt_version='critic_reformulate_v1'`. Returns a new compiled sub-query or `null` on failure (triggers retries-exhausted handoff). |
| [src/domain/retrieval/service/prompts/critic-reformulate.prompt.ts](../../../src/domain/retrieval/service/prompts/critic-reformulate.prompt.ts) | Frozen reformulate prompt + `prompt_version`. |
| [test/regression/retrieval-critic-decision.regression.test.ts](../../../test/regression/retrieval-critic-decision.regression.test.ts) | ~8 cases. See §3. |
| [test/regression/query-rewriter-deterministic.regression.test.ts](../../../test/regression/query-rewriter-deterministic.regression.test.ts) | ~6 cases. |
| [test/regression/retrieval-critic-retry-cap.regression.test.ts](../../../test/regression/retrieval-critic-retry-cap.regression.test.ts) | Locks `CRITIC_RETRY_MAX = 3` at type level — test imports the constant and asserts it equals 3. Also asserts the loop terminates after 3 retries with `RETRIEVAL_CRITIC_RETRIES_EXHAUSTED` counter incremented. |
| [test/regression/tool-call-evidence-frame-v1-to-v1-1-migration.regression.test.ts](../../../test/regression/tool-call-evidence-frame-v1-to-v1-1-migration.regression.test.ts) | Locks frame schema v1 → v1.1: v1 frames still parse (no `retryCount` field); v1.1 frames include `retryCount`; byte-identical internal retries produce distinct `observationHash` values because `retryCount` is part of hash input. |

### 2.2 Modified files

| File | Change |
|------|--------|
| [src/domain/agent/model/tool-call-evidence-frame.ts](../../../src/domain/agent/model/tool-call-evidence-frame.ts) | **Schema v1 → v1.1 bump**. Add optional `retryCount?: number` field. Update `observationHash` computation to include `retryCount` in its input (documented in ADR-009 addendum). Zod `.optional()`. Backward-compat: v1 frames (no `retryCount`) still parse; hash uses `retryCount ?? 0` sentinel. |
| [src/domain/agent/service/build-tool-call-evidence-frame.ts](../../../src/domain/agent/service/build-tool-call-evidence-frame.ts) | Accept `retryCount` in builder input; thread into output. |
| [src/application/search/search-usecase-graph-executor.ts](../../../src/application/search/search-usecase-graph-executor.ts) | Extend with critic retry loop around `candidatePool.execute`. Layout: `for (let retryCount = 0; retryCount < CRITIC_RETRY_MAX; retryCount++) { ... if (!decision.retry) break; const rewritten = await rewriter.apply(decision, ...); if (!rewritten) break; retrievalInput = rewritten; }`. Emit `criticRewrites` trace entry on each retry. On exhaustion, increment `RETRIEVAL_CRITIC_RETRIES_EXHAUSTED` counter and hand off the last retrieval result to the ranker with a degradation reason. **If PR4 has not landed**, this file is created new here. |
| [src/application/search/search-usecase-decision-input.ts](../../../src/application/search/search-usecase-decision-input.ts) | Extend decision trace with optional `criticRewrites?: readonly { subqueryId; type; rewriteTraceRef }[]`. |
| [src/config/feature-flags.ts](../../../src/config/feature-flags.ts) | Add `RETRIEVAL_EXECUTOR_CRITIC` flag (default off). |
| [src/observability/silent-skip-counters.ts](../../../src/observability/silent-skip-counters.ts) | Add `RETRIEVAL_CRITIC_RETRIES_EXHAUSTED`, `RETRIEVAL_CRITIC_RETRY_COUNT` counters. |

### 2.3 Files I explicitly do NOT touch

- [src/domain/agent/service/step-budget.ts](../../../src/domain/agent/service/step-budget.ts) — agent-layer guard.
- `adaptive-budget.ts` — agent-layer.
- [src/application/agent/agent-orchestrator.ts](../../../src/application/agent/agent-orchestrator.ts) — agent layer, no retry-loop change.
- Ranker (PR5).
- Grounded claims (PR7).

---

## 3. Test additions

| Test file | Cases | Locks |
|-----------|-------|-------|
| [test/regression/retrieval-critic-decision.regression.test.ts](../../../test/regression/retrieval-critic-decision.regression.test.ts) | ~8 | coverage=0 → `shouldRetry=true`; coverage=1 → `shouldRetry=false`; degradation_reasons includes `'sparse_pool'` → retry with `relax`; includes `'no_matches'` → retry with `expand_synonym`; mixed coverage 0.5 with degradation reasons → decision tree fully covered; `retryCount >= CRITIC_RETRY_MAX` → no retry; rewriter returns null → no retry; critic is pure (same input → same output across 100 calls). |
| [test/regression/query-rewriter-deterministic.regression.test.ts](../../../test/regression/query-rewriter-deterministic.regression.test.ts) | ~6 | `relax` deterministic + idempotent; `decompose` deterministic; `expand_synonym` deterministic; `reformulate` calls LLM (mocked — deterministic output under temperature 0); null on malformed LLM output; null on unknown rewrite type. |
| [test/regression/retrieval-critic-retry-cap.regression.test.ts](../../../test/regression/retrieval-critic-retry-cap.regression.test.ts) | ~4 | `CRITIC_RETRY_MAX` exported constant equals 3 (type-level lock); loop terminates after exactly 3 retries; counter `RETRIEVAL_CRITIC_RETRIES_EXHAUSTED` incremented once on exhaustion; no 4th iteration under any degraded state. |
| [test/regression/tool-call-evidence-frame-v1-to-v1-1-migration.regression.test.ts](../../../test/regression/tool-call-evidence-frame-v1-to-v1-1-migration.regression.test.ts) | ~5 | v1 JSON parses under v1.1 Zod; v1.1 frames include `retryCount`; byte-identical tool calls with different `retryCount` produce different `observationHash`; `retryCount` absent → hash uses `0` sentinel deterministically; unknown schema version fails closed. |

---

## 4. Call-graph sanity checks (pre-coding)

- [ ] Confirm PR4 landing status. If PR4 landed, extend `search-usecase-graph-executor.ts`. If not, create it here — ensure the retry loop wraps `candidatePool.execute` and the pass-through branch (trivial graph) still bypasses the loop entirely.
- [ ] Grep every consumer of `ToolCallEvidenceFrame` to confirm optional `retryCount` addition does not break deserialization (`exactOptionalPropertyTypes`).
- [ ] Grep `observationHash` consumers — most compare-by-equality; additive hash input must not break equality on pre-PR6 frames (v1 sentinel `retryCount=0` keeps existing hashes stable).
- [ ] Confirm [constraint-relaxation.ts](../../../src/domain/query/service/constraint-relaxation.ts) exports the helpers `relax`, `decompose`, `expandSynonym` (names approximate — confirm). If not, extract from there into the rewriter.
- [ ] Confirm `computeGraphCoverage` signature returns enough signal (root-satisfied + per-node satisfaction) for the critic to make retry decisions without another graph traversal.
- [ ] Confirm `ChatLlmPort` is already in composition-root scope (it is — used by LlmNLMapper).

Bail early if any assumption breaks.

---

## 5. Cutover gate

All items green before commit:

1. **Retry-cap lock**: `CRITIC_RETRY_MAX = 3` imported and asserted in test. No env-var override.
2. **Frame schema v1 → v1.1 migration**: both versions parse; `observationHash` preserves pre-PR behaviour when `retryCount=0`.
3. **`contextRecall ≥ 70%`** on bench — target from improvement plan.
4. **`TOOL_DUPLICATE_CALLS ≤ 5%`** — measurable via agent-orchestrator tool-call trace (re-uses existing metric).
5. **Deterministic retry path**: bench replay produces identical critic decisions across two runs (lock via replay-determinism test).
6. **`pnpm run git:prepush` green**.
7. **Rollback verified**: `RETRIEVAL_EXECUTOR_CRITIC=false` → retry loop skipped; frame schema v1.1 still parses v1 frames and is inert without critic calls.

---

## 6. Risks & mitigations

### Risk 1 — Loop termination bug
A retry loop without a hard type-level cap is a catastrophic latency
risk. Env-var-controlled caps can be accidentally bumped or disabled.

**Mitigation**: `const CRITIC_RETRY_MAX = 3` at module scope,
imported directly by regression test. Loop uses `for (let i = 0; i < CRITIC_RETRY_MAX; i++)`
with no mutable reference. Counter `RETRIEVAL_CRITIC_RETRIES_EXHAUSTED`
triggers an alert if > threshold in production.

### Risk 2 — `observationHash` collision on internal retries
Byte-identical retries (same input to `candidatePool.execute`) produce
identical `observationHash` values → evidence-frame deduplication
silently drops the second retry's frame → the trace lies about what
happened.

**Mitigation**: frame schema v1 → v1.1 adds `retryCount` to hash input.
Schema bump MUST land in the same PR as the critic loop (not a separate
follow-up) because the collision is the silent bug mode.

### Risk 3 — LLM cost on `reformulate`
`reformulate` calls the LLM up to 3x per query under worst case.

**Mitigation**: critic's decision tree prefers `relax` / `decompose` /
`expand_synonym` (deterministic, no LLM) over `reformulate`. Only
when all three deterministic paths exhaust or are inapplicable does
the critic choose `reformulate`. Documented in ADR-015 decision table.

### Risk 4 — Deterministic-first but LLM-eventual drift
Shipping deterministic day 1, then adding LLM critic later, means the
behaviour shifts silently if the flag is flipped.

**Mitigation**: `RETRIEVAL_EXECUTOR_CRITIC` flag governs the whole
loop, including `reformulate`. Future LLM-critic upgrade will be a
new feature flag, not a silent swap. Documented in ADR-015.

### Risk 5 — Retries-exhausted graceful handoff
When 3 retries don't achieve acceptable coverage, handing off a
low-coverage retrieval to the ranker may produce poor results without
a user-visible signal.

**Mitigation**: `degradationReasons` includes `'critic_retries_exhausted'`;
decision-trace records the attempted rewrites. Response builder can
surface the degradation to the user (PR7 will emit a claim; until
then it's trace-only).

### Risk 6 — Rewriter returning null mid-loop
If `reformulate` LLM errors, rewriter returns null. Loop must break,
not continue with stale input.

**Mitigation**: loop check `if (!rewritten) break;` + test case #7
in query-rewriter regression + test case #7 in critic-decision
regression.

---

## 7. Rollback plan

Two-level rollback:

1. **Fast**: `RETRIEVAL_EXECUTOR_CRITIC=false` → executor bypasses the
   retry loop entirely → byte-identical to pre-PR6 behaviour. Frame
   schema v1.1 still parses v1 frames; hash stable via `retryCount=0`
   sentinel.
2. **Schema rollback**: frame schema v1.1 is a pure superset of v1.
   Reverting the schema requires removing the optional field — no
   data migration. Stored frames with `retryCount` still decode under
   v1 (ignored field if Zod is non-strict, fail-loud if strict —
   strictness decision documented in ADR).

---

## 8. Checklist (execution order)

- [ ] §4 sanity checks (PR4 status, `observationHash` consumers, relaxation helpers, graph-coverage signal shape).
- [ ] Draft [ADR-015](../../adr/015-axis-2-retrieval-critic.md).
- [ ] **Bump frame schema v1 → v1.1 first** (schema migration test fail-first, then fix).
- [ ] Write `retrieval-critic.ts` (pure, no LLM); 8-case regression fail-first.
- [ ] Write `query-rewriter.ts`; 6-case regression fail-first.
- [ ] Write `prompts/critic-reformulate.prompt.ts` (frozen version).
- [ ] Extend `search-usecase-graph-executor.ts` with retry loop.
- [ ] Write `retrieval-critic-retry-cap.regression.test.ts`.
- [ ] Add silent-skip counters + feature flag.
- [ ] Extend `search-usecase-decision-input.ts` trace fields.
- [ ] Run bench with critic on + off; compare contextRecall + TOOL_DUPLICATE_CALLS.
- [ ] `pnpm run typecheck && pnpm run lint`.
- [ ] `pnpm run git:prepush`.
- [ ] Commit.

---

## 9. Commit message draft

```
feat(adr-015-axis-2): executor-internal self-critique retrieval RAG

Introduces a deterministic-first retrieval critic and query rewriter
inside the executor layer (between candidatePool.execute and the
ranker). CRITIC_RETRY_MAX = 3 enforced at type level. Frame schema
v1 -> v1.1 adds retryCount to prevent observationHash collisions on
byte-identical internal retries.

- New ADR-015 with deterministic-first vs LLM-eventual policy and
  executor-layer boundary rationale
- New src/domain/retrieval/service/{retrieval-critic,query-rewriter}.ts
  (critic pure; rewriter deterministic for relax/decompose/
  expand_synonym, LLM only for reformulate)
- ToolCallEvidenceFrame schema v1 -> v1.1 (retryCount added; hash
  input updated; backward-compat via retryCount=0 sentinel)
- Executor retry loop wraps candidatePool.execute with hard cap
- Decision-input trace extended with criticRewrites
- 4 new regression files (~23 cases): critic decisions, rewriter
  determinism, retry-cap type lock, frame schema migration
- RETRIEVAL_EXECUTOR_CRITIC feature flag (default off)

Rollback: RETRIEVAL_EXECUTOR_CRITIC=false -> byte-identical to pre-PR6.
Frame schema v1.1 is a pure superset; no data migration on rollback.
```
