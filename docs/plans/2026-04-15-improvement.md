# 2026-04-15 Improvement Plan — Planner / Execution / Provenance Contract Migration

> **Status**: Draft. Supersedes the rough `ADR-009 Grounded Claim Emission` sketch from 2026-04-14.
>
> **Why this is NOT "evaluator redesign"**: the reviewer was correct. The 2026-04-14 RCA named the evaluator as the surface bug, but the structural blockers live one layer up — **the planner, the execution pipeline, and the provenance carriers are flat, and the V1 response envelope is frozen.** Fixing the evaluator without touching these is a dead end. This plan therefore reframes the work as a **contract migration** across the planner → execution → provenance → response chain, with the evaluator replacement riding on top.
>
> **Scope rule**: everything referenced by file:line is verified against HEAD (commit `c90e635`) on 2026-04-15.

---

## 0. Why the previous draft was wrong

The 2026-04-14 RCA produced a 3-axis sketch:

1. **Axis 1** — Grounded Claim Emission (evaluator replacement)
2. **Axis 2** — ConstraintGraph (constraint-compiler rewrite)
3. **Axis 3** — Self-critique RAG loop (agent-layer retries)

The reviewer raised five P1/P2 findings that each invalidate a piece of the above. Summarised:

| # | Finding | Implication for draft |
|---|---------|----------------------|
| P1-A | `SearchResponseV1` is the engine-decision envelope, frozen by `ResponseBuilder` main-runtime lock. GCE shape `{ prose, atomic_claims, decision_trace }` implies a V1 schema change. | Axis 1 is not an evaluator swap — it is a wire-contract migration touching V1 and the V2 sidecar builders. |
| P1-B | `QueryPlanV1.constraints: ConstraintBundle` is **field-frozen** (E1-U9 comment at [query-plan.ts:29-37](../../src/domain/query/model/query-plan.ts#L29-L37)). Downstream readers (`provenance-closure`, `decision-input`, ranker) all consume flat `hard/soft/inferred` attribute arrays. | ConstraintGraph cannot replace the compiler output — it must live in a new V2 planner plane alongside the frozen V1 bundle. |
| P1-C | `BudgetLedger.reserve(subqueryId, candidates)` cuts raw-candidate budget before ranking chooses a result. Current pipeline ranks first, judges constraint-coverage on `topResult` only ([search-usecase-provenance-closure.ts:61-66](../../src/application/search/search-usecase-provenance-closure.ts#L61-L66)). Deducting budget from unselected candidates can evict valid bundles. | Multi-query execution needs a **bundle-selection / assignment** stage between retrieval and ranking. `ConstraintGraph` alone is not enough. |
| P2-A | Agent layer already has `adaptive-budget.ts` + `step-budget.ts` that per-tool cap and trigram-Jaccard block near-duplicate reformulations ([step-budget.ts:16-49](../../src/domain/agent/service/step-budget.ts#L16-L49)). Self-critique retry at the agent step layer would either be blocked or bypass the guard. | Self-critique must live **inside the retrieval executor**, not in the agent loop. |
| P2-B | Evidence is reconstructed from raw observation strings by [`evidence-parser.ts`](../../src/domain/evaluation/service/evidence-parser.ts) (regex over pipe-delimited lines). `provenanceRef.resultId/toolCallId/passageSpan` cannot be reliably restored from that carrier. | GCE needs a **structured evidence carrier** upstream before the evaluator can consume provenance at all. |

Plus two things the draft left as "open questions" that should be cutover gates:

- **Gold atomic_claim annotation**: `aggregate()` at [claim-level-evaluator.ts:108-110](../../src/domain/evaluation/service/claim-level-evaluator.ts#L108-L110) already excludes `status !== 'ok'` from faithfulness denominators. Grading a new evaluator with a new evaluator therefore self-biases. A human-annotated claim gold set is **not** a later concern — it is the gate that authorises cutover.
- **Claim ontology versioning**: `pairing_assertion` / `style_assertion` / `recommendation` carry the highest schema-drift risk. The ontology must carry an explicit `claim_schema_version` field from v1 so that replay and bench comparisons across revisions stay sound.

The reviewer's one-liner: "방향은 맞는데, ADR 제목이 '평가/생성 재설계'인 것보다 실제론 'planner/execution/provenance contract migration'에 더 가깝습니다."

**Adopted.** This document uses that frame.

---

## 1. Re-scoped axes

Four axes, ordered by dependency:

| Order | Axis | Depth | What it actually migrates |
|-------|------|-------|---------------------------|
| **0** | Structured Evidence Carrier | prerequisite | tool-call return type, agent-step record shape |
| **1** | ConstraintGraph (V2 planner plane) | largest | `QueryPlanV2`, `CompiledWineQuery`, constraint-compiler additive output, provenance-closure read path, ranker input, `BundleSelector` new stage |
| **2** | Self-critique RAG loop (executor-internal) | medium | retrieval executor internal retry, **not** the agent loop |
| **3** | Grounded Claim Emission (V2 builder + V1 optional sidecar) | wire-contract + evaluator | `MachineResponseBuilderV2` extension, new atomic-claim schema, type-dispatched verifiers, **NOT** a V1 schema change |

The reviewer's concluded order (축 2 → 축 3 → 축 1) maps onto Axes 1 → 2 → 3 in this plan. Axis 0 is the new prerequisite that the draft missed.

---

## Axis 0 — Structured Evidence Carrier (prerequisite for Axis 3)

### What's broken

Evidence lives in two forms, neither of which is typed as a first-class carrier:

1. Raw tool observation strings (typically `search_wines` returning a pipe-delimited human-readable list).
2. `EvidenceRecord` objects reconstructed by [`evidence-parser.ts:45-55`](../../src/domain/evaluation/service/evidence-parser.ts#L45-L55) from those strings via brittle regexes (`LABEL_LINE_RE`, `ENTITY_ID_PAREN_RE`, `PRICE_KRW_RE`, etc.).

The pipeline loses the native structured result the engine already has (`ResultItem[]` on `SearchResponseV1`) by collapsing it into text, then asks the evaluator to parse text back into records. That's the structural root of P2-B.

### What to build

A **dual-channel tool contract**: every agent tool call emits both a human-readable observation AND a typed `ToolCallEvidenceFrame`:

```typescript
interface ToolCallEvidenceFrame {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly invokedAt: string;                   // ISO-8601
  readonly request: ToolCallRequest;
  readonly structuredOutput: ToolCallStructuredOutput;
  readonly observationSnapshot: string;         // what the LLM saw, byte-equivalent
  readonly observationHash: string;             // SHA-256 over observationSnapshot
  readonly schemaVersion: 'tool_evidence_v1';
}

interface ToolCallStructuredOutput {
  readonly kind: 'search_result_set' | 'entity_detail' | 'tool_error' | 'no_op';
  readonly resultSet?: readonly ResultItem[];     // reuses domain ResultItem — SSoT
  readonly entityDetail?: EntityDetailRecord;
  readonly errorEnvelope?: ToolErrorEnvelope;
}
```

Key invariants:

- `structuredOutput` reuses the existing `ResultItem` domain type — no new parser, no new schema for the same payload.
- `observationSnapshot` is the exact text the LLM received (byte-equivalent). The evaluator can still diff text for transparency, but it never parses it.
- `observationHash` makes replay deterministic.
- `schemaVersion` locked from v1 so future revisions are comparable (P2-B upgraded gate).

### Where it plugs in

| Touch point | File | Change |
|---|---|---|
| Tool dispatcher | `src/application/agent/agent-tools.ts` | After every tool call, build `ToolCallEvidenceFrame` alongside the observation string; attach to the agent step record. |
| Agent step record | `src/domain/agent/model/agent-step.ts` | Add `evidenceFrames: readonly ToolCallEvidenceFrame[]`. |
| Agent orchestrator | `src/application/agent/agent-orchestrator.ts` | Thread frames through the final agent return payload. |
| Bench harness | `test/benchmark/agent/runner.ts` | Prefer `evidenceFrames` over `observations` when present, fall back to legacy for regression. |
| Evidence parser | `src/domain/evaluation/service/evidence-parser.ts` | Deprecate `parseObservations` in favour of reading frames directly. Legacy path retained for pre-Axis-0 runs. |

### Cutover gate for Axis 0

- Every production tool call emits a valid `ToolCallEvidenceFrame`.
- Bench runner reports `evidenceFrameCoverage >= 0.99` across the nightly profile for two consecutive runs.
- `evidence-parser.ts` consumer count in production code path goes to 0 (remains only for legacy bench runs).

---

## Axis 1 — ConstraintGraph (V2 planner plane)

### What's broken

Per P1-B: QueryPlanV1 is field-frozen, and the compiler's `ConstraintBundle` is flat (`hard / soft / inferred` attribute lists — [constraint-compiler.ts:19-31](../../src/domain/query/service/constraint-compiler.ts#L19-L31)). Downstream readers including [search-usecase-provenance-closure.ts:15-17](../../src/application/search/search-usecase-provenance-closure.ts#L15-L17) call `plan.constraints.hard.map(c => c.attribute)` — they assume flat. A replace-in-place of `ConstraintBundle` breaks every one of those readers.

### What to build

A **new V2 planner output** carried through the already-intended migration route (QueryPlanV1 → QueryPlanV2 → ExecutionCompiler → CompiledWineQuery):

```typescript
interface ConstraintGraph {
  readonly graphSchemaVersion: 'constraint_graph_v1';
  readonly nodes: readonly ConstraintNode[];
  readonly edges: readonly ConstraintEdge[];
  readonly rootNodeId: string;
  readonly globalBudgets: GlobalBudgetSet;
  /** Round-trip bridge: a deterministic projection of this graph into the
   *  legacy flat ConstraintBundle. Downstream readers that haven't migrated
   *  yet read from this projection. */
  readonly legacyBundle: ConstraintBundle;
}

type ConstraintNode =
  | { kind: 'slot'; slotId: string; attribute: SlotAttribute; op: Operator; value: SlotValue; confidence: number; origin: 'explicit' | 'inferred' | 'default' }
  | { kind: 'subquery'; subqueryId: string; purpose: string; targetCardinality: number }
  | { kind: 'group_and'; children: readonly string[] }
  | { kind: 'group_or'; children: readonly string[] }
  | { kind: 'group_xor'; children: readonly string[] };

type ConstraintEdge =
  | { kind: 'shares_budget'; from: string; to: string; resource: 'price_total' | 'time' | 'count' }
  | { kind: 'complements'; from: string; to: string; reason: 'meal_course' | 'pairing' | 'variety' }
  | { kind: 'depends_on'; from: string; to: string };

interface GlobalBudgetSet {
  readonly priceTotal?: { currency: 'KRW' | 'USD'; max: number };
  readonly candidateCount?: number;
  readonly walltime?: number;
}
```

**The `legacyBundle` field is not optional.** It is the migration bridge that keeps every pre-Axis-1 reader working unchanged during rollout. Retirement of the bridge is a later phase (Axis 1.x cleanup).

### Where it plugs in

| Touch point | File | Change |
|---|---|---|
| Planner V2 output | `src/domain/query/model/query-plan.ts` (adjacent `QueryPlanV2`) | Add `constraintGraph: ConstraintGraph` field. V1 stays frozen. |
| Constraint compiler | `src/domain/query/service/constraint-compiler.ts:19` | `ConstraintCompilerResult` gains a sibling `constraintGraph` alongside existing `bundle`. Bundle stays authoritative until every reader has been migrated. |
| Execution compiler | `src/domain/query/service/execution-compiler.ts` | Project the graph into `CompiledWineQuery`. |
| Provenance closure (reader) | `src/application/search/search-usecase-provenance-closure.ts:15-17` | Accept either `constraintGraph` or `bundle`; prefer graph when available. |
| Decision input builder | `src/application/search/search-usecase-decision-input.ts:254` | Same reader migration. |
| Ranker input | `src/domain/ranking/model/ranking-input.ts` | Add optional `constraintGraph`, keep flat fields for V1 compatibility. |
| **NEW**: BundleSelector | `src/domain/retrieval/service/bundle-selector.ts` | New service — see Axis 1.5 below. |

### Axis 1.5 — BundleSelector (answer to P1-C)

The reviewer's P1-C is the deepest finding. Shared-budget graphs (3-way pairing under a single price ceiling) need a stage that **assigns** winning candidates across subqueries before top-result ranking sees them. Simply deducting raw-candidate budget is wrong — a candidate the ranker would have discarded should not consume budget.

The new stage:

```
ConstraintGraphExecutor
  ├─ for each subqueryId in topoOrder:
  │    raw_candidates[subqueryId] = candidatePool.execute(subquery_input)
  ├─ BundleSelector.chooseAssignment(graph, raw_candidates) → Assignment
  │    ├─ for each valid assignment permutation:
  │    │    check globalBudgets (priceTotal etc.)
  │    │    score by Σ per-candidate relevance + shared-budget fit
  │    └─ return top-K assignments (usually K=1 for deterministic UX)
  └─ ranker.rankAssignment(assignment, graph)
```

Interface:

```typescript
interface BundleSelector {
  chooseAssignment(
    graph: ConstraintGraph,
    candidatesBySubquery: ReadonlyMap<string, readonly HybridCandidate[]>,
  ): Promise<AssignmentSolution>;
}

interface AssignmentSolution {
  readonly assignments: ReadonlyMap<string, HybridCandidate>; // subqueryId → chosen candidate
  readonly bundleScore: number;
  readonly budgetUsage: ReadonlyMap<string, number>;
  readonly degradationReasons: readonly string[];   // if relaxed
  readonly tieBreakReason: string | null;
}
```

Selection algorithm: **hungarian-style bipartite matching** with budget constraints as the first-class penalty, not a post-hoc filter. For trivial (single-subquery) graphs, the selector is a pass-through.

### Cutover gates for Axis 1

- `QueryPlanV2.constraintGraph` populated for ≥95% of bench scenarios.
- Legacy flat readers continue to pass all existing regression tests (the `legacyBundle` bridge holds).
- `BundleSelector` green on a new regression suite: 3-way pairing, 2-way comparison, XOR (red-or-white), shared-price-budget.
- Bench shows `scrInferred >= 80%` and `csrInferred >= 70%` on `situation_based` + `extreme` tiers.

---

## Axis 2 — Self-critique RAG loop (retrieval-executor-internal)

### What's broken (per P2-A)

[step-budget.ts:16-49](../../src/domain/agent/service/step-budget.ts#L16-L49) enforces:
- `MIN_PER_TOOL_CALL_CAP = 3` (scaled to max(3, ⌈maxSteps × 0.6⌉))
- Trigram-Jaccard near-duplicate detector: Korean ≥0.92, ASCII ≥0.85

These are correct defences at the agent layer. A naive self-critique "retry the search" loop at the agent level would either get blocked or require disabling the loop-detector — which would let the agent genuinely thrash on other scenarios.

### What to build

Self-critique lives **below** the agent. Specifically, inside the `ConstraintGraphExecutor`:

```
agent step: search_wines(rich_query)
    ↓
MultiQueryExecutor.executeGraph(graph)
    ├─ retrieval pass 1 per subquery
    ├─ RetrievalCritic.evaluate(graph, results)
    │    ├─ coverage per subquery
    │    ├─ provenance shortfall per subquery  
    │    └─ suggestedRewrites: { relax | reformulate | decompose | expand_synonym }
    ├─ if shouldRetry && retryBudget > 0:
    │    QueryRewriter.rewrite(subquery, critique) → new_input
    │    retrieval pass 2 (internal, agent-invisible)
    └─ BundleSelector → rank → return to agent as ONE tool call
```

**Critical**: the entire retry loop is encapsulated in the executor. The agent sees one tool call, one observation. `step-budget.ts` is undisturbed. Adaptive budget still applies to the agent's outer loop.

```typescript
interface RetrievalCritic {
  evaluate(
    graph: ConstraintGraph,
    result: ConstraintGraphResult,
  ): CritiqueReport;
}

interface CritiqueReport {
  readonly coverage: number;
  readonly precision: number;
  readonly missingSlots: readonly MissingSlot[];
  readonly suggestedRewrites: readonly QueryRewrite[];
  readonly shouldRetry: boolean;
  readonly retryBudget: number;    // internal retry budget, default 3
  readonly degradationTraceRef: string;
}

interface QueryRewrite {
  readonly type: 'relax' | 'reformulate' | 'decompose' | 'expand_synonym';
  readonly targetSubqueryId: string;
  readonly delta: Partial<HybridRetrievalInput>;
  readonly confidence: number;
  readonly rewriteTraceRef: string;
}
```

The deterministic parts of `RetrievalCritic` (coverage, provenance shortfall) reuse existing signals (`degradation_reasons`, `provenance_shortfall` — already propagated via the 2026-04-14 Wave 2 work). The LLM-assisted parts (`reformulate`) are gated by `critic.shouldRetry`.

### Where it plugs in

| Touch point | File | Change |
|---|---|---|
| Retrieval executor | `src/application/search/search-usecase-hybrid-candidates.ts` | Wrap `candidatePool.execute` call in the graph-executor with critic loop. |
| New: RetrievalCritic | `src/domain/retrieval/service/retrieval-critic.ts` | New service. |
| New: QueryRewriter | `src/domain/retrieval/service/query-rewriter.ts` | New service (LLM-backed). |
| Decision trace | `src/domain/decision/model/decision-trace.ts` | Record every internal retry for replay. |
| `step-budget.ts` | *unchanged* | Agent-layer guards stay as-is. |

### Cutover gates for Axis 2

- Internal retry bounded (default ≤3). Hard-capped in code, not config-default-only.
- Decision trace captures every rewrite with structured `rewriteTraceRef` — replayable.
- Bench shows `contextRecall >= 70%` on nightly profile.
- `TOOL_DUPLICATE_CALLS` rate on bench falls to ≤5% (currently ~15%).

---

## Axis 3 — Grounded Claim Emission (V2 builder + sidecar, NOT V1 schema change)

### What's broken

Per P1-A: `SearchResponseV1` is locked. GCE prose+claims does not fit. The [response-builder.ts:1-19](../../src/domain/response/service/response-builder.ts#L1-L19) comment literally warns: "Do NOT promote V2 builders to main runtime contract without an explicit migration epic that gates on eval regression results."

### What to build

GCE lives in the **V2 builder sidecar** that already exists (`MachineResponseBuilderV2`, `HumanResponseBuilderV2`):

```typescript
interface MachineResponseV2 /* extended */ {
  readonly schemaVersion: 'machine_response_v2';
  readonly queryType: 'search';
  readonly engineDecision: EngineDecision;         // unchanged
  readonly results: readonly ResultItem[];         // unchanged

  // NEW — Grounded Claim Emission
  readonly grounded?: GroundedPayload;
  readonly claimSchemaVersion?: 'claim_schema_v1'; // explicit from v1 (P2 gate)
}

interface GroundedPayload {
  readonly proseSegments: readonly ProseSegment[];   // prose chunks with span markers
  readonly atomicClaims: readonly AtomicClaim[];
  readonly claimSchemaVersion: 'claim_schema_v1';
}

interface ProseSegment {
  readonly text: string;
  readonly localeTag: 'ko' | 'en' | 'fr' | 'ja' | 'other';
  readonly inlineMarkers: readonly InlineMarker[]; // maps offsets → claimId
}

interface AtomicClaim {
  readonly claimId: string;
  readonly type: AtomicClaimType;
  readonly field: ClaimField;
  readonly value: unknown;
  readonly provenanceRef: ProvenanceRef;
  readonly polarity: 'asserts' | 'denies' | 'hypothesizes';
  readonly hedge: 'certain' | 'likely' | 'uncertain';
  readonly claimSchemaVersion: 'claim_schema_v1';  // per-claim version, not just envelope
}

type AtomicClaimType =
  | 'entity_reference'
  | 'attribute_assertion'
  | 'price_assertion'
  | 'vintage_assertion'
  | 'pairing_assertion'
  | 'comparative_assertion'
  | 'drinking_window_assertion'
  | 'style_assertion'
  | 'recommendation';

interface ProvenanceRef {
  readonly kind: 'tool_call_frame' | 'domain_knowledge' | 'hedged';
  readonly toolCallId?: string;                     // Axis 0 frame id
  readonly resultEntityId?: string;                 // a row inside frame.structuredOutput.resultSet
  readonly passageSpan?: { start: number; end: number };  // within frame.observationSnapshot
}
```

Note `provenanceRef.toolCallId` points at the **Axis-0 `ToolCallEvidenceFrame.toolCallId`**. Axis 3 literally cannot exist without Axis 0.

### Type-dispatched verifier

One verifier per claim type — regex-free.

```typescript
const VERIFIERS: Record<AtomicClaimType, ClaimVerifier> = {
  entity_reference:           new ExactEntityMatchVerifier(),    // against frame.structuredOutput.resultSet
  attribute_assertion:        new NumericRangeVerifier(),
  price_assertion:            new PriceToleranceVerifier(),      // ±10%
  vintage_assertion:          new ExactYearVerifier(),
  pairing_assertion:          new NliVerifier(),                 // LLM or small NLI model
  comparative_assertion:      new PairwiseVerifier(),
  drinking_window_assertion:  new WindowIntersectionVerifier(),
  style_assertion:            new EmbeddingSimilarityVerifier(), // threshold 0.7
  recommendation:             new NoopVerifier(),
};
```

`claim-extractor.ts` is **deleted** at the completion of Axis 3, not at the start — retention during shadow emit allows side-by-side comparison against the gold annotation set.

### Where it plugs in

| Touch point | File | Change |
|---|---|---|
| V2 builder | `src/domain/response/service/machine-response-builder-v2.ts` | Emit `grounded` payload. |
| LLM generation adapter | `src/application/agent/agent-prompt.ts`, `src/application/agent/agent-response-parser.ts` (new) | JSON-schema-constrained output for Anthropic; `tool_use` bridge for OpenAI. |
| V1 response | `src/domain/response/model/search-response.ts:41` | *unchanged* — no V1 breaking change. |
| New: verifier dispatcher | `src/domain/evaluation/service/claim-verifier-router.ts` | Replace regex extract + flat verify with type dispatch. |
| Legacy extractor | `src/domain/evaluation/service/claim-extractor.ts` | Retained for shadow comparison, deleted at cutover. |

### Cutover gates for Axis 3

The following four gates are ALL required. Any single failure keeps the legacy extractor live.

1. **Gold atomic_claim annotation set exists** — human-annotated, ≥200 scenarios, independent of engine output. Upgraded from open question to gate per reviewer.
2. **`claim_schema_version` header on every emitted claim** — per-claim, not just per-envelope. Replay / bench diffing must stay sound across ontology revisions. Upgraded from open question to gate per reviewer.
3. **Shadow-mode parity ≥0.95** — on the gold set, new verifier's per-type precision/recall matches or exceeds regex extractor, and the false-positive hardFail rate from the RCA collapses from 51% to <5%.
4. **Evaluator-on-evaluator bias audit** — aggregate score calculated both with and without `status !== 'ok'` exclusion at [claim-level-evaluator.ts:108-110](../../src/domain/evaluation/service/claim-level-evaluator.ts#L108-L110). Both numbers reported; drift between them flagged in the bench output. Self-bias visible instead of hidden.

---

## 2. Migration phases

Each phase is a standalone shippable PR train. Axis ordering is forced by the dependency DAG: **0 → 1 → 2 → 3**.

### Phase 0 — Structured Evidence Carrier

- `ToolCallEvidenceFrame` type + tool dispatcher + agent-step record + bench-runner consumption.
- Legacy `evidence-parser.ts` retained.
- **Cutover gate**: `evidenceFrameCoverage >= 0.99` two nightly runs in a row.

### Phase 1 — ConstraintGraph + BundleSelector (the biggest phase)

- `QueryPlanV2.constraintGraph` + `ConstraintCompilerResult.constraintGraph` + `legacyBundle` bridge.
- Provenance-closure, decision-input, ranker readers accept either form; prefer graph.
- `BundleSelector` new service + regression suite (3-way pairing, XOR, shared-budget).
- Shadow-mode: graph path runs in parallel with legacy for a rollout window, bench compares scores.
- **Cutover gate**: `scrInferred >= 80%` and `csrInferred >= 70%` on `situation_based` + `extreme` tiers.

### Phase 2 — Self-critique RAG (executor-internal)

- `RetrievalCritic` + `QueryRewriter` + executor-internal retry loop.
- Agent `step-budget.ts` unchanged.
- Internal retry bounded at ≤3. Decision trace captures every rewrite.
- **Cutover gate**: `contextRecall >= 70%`, `TOOL_DUPLICATE_CALLS <= 5%`.

### Phase 3 — Grounded Claim Emission

Only entered when Phases 0-2 are green.

- V2 builder extension.
- Type-dispatched verifiers.
- Legacy extractor retained in shadow mode.
- **Cutover gates (all four)**: gold annotation set, per-claim schema version, shadow parity ≥0.95, evaluator-bias dual reporting.

---

## 3. Cutover gates (consolidated)

These are **blocking**, not "nice to have". A PR that claims axis completion without satisfying its gates is not mergeable.

| Axis | Gate | Enforced by |
|------|------|-------------|
| 0 | Evidence frame coverage ≥0.99 | Bench runner assertion |
| 1 | Legacy readers unchanged + bundle selector green + inferred-constraint targets | Regression suite + bench tier thresholds |
| 2 | Internal retry bounded ≤3 + trace replay | Type-level constant + regression test |
| 2 | Context recall ≥70%, duplicate rate ≤5% | Bench nightly threshold |
| 3 | Gold atomic_claim annotation set ≥200 scenarios | Human-annotated file committed to repo |
| 3 | `claim_schema_version` on every claim | Zod schema + runtime assertion |
| 3 | Shadow parity ≥0.95 on gold set | Bench harness diff report |
| 3 | Evaluator-bias dual reporting in every bench summary | Bench summary format change |

---

## 4. Risk & rollback

Each phase has a feature flag and a forward-compatible schema strategy.

| Phase | Feature flag | Rollback route |
|---|---|---|
| 0 | `EVIDENCE_FRAME_EMIT` | Flag off → tool dispatcher emits only observation string; bench harness falls back to `parseObservations`. Fully reversible. |
| 1 | `CONSTRAINT_GRAPH_V2_EMIT` | Flag off → planner emits only `ConstraintBundle`, `legacyBundle` bridge disappears, all readers take the existing bundle path. Reversible **only** if no writer has committed to graph-only fields. |
| 2 | `RETRIEVAL_EXECUTOR_CRITIC` | Flag off → executor does single retrieval pass, no critic, no rewrite. Reversible. |
| 3 | `GCE_SHADOW_EMIT` (emit grounded but don't use for scoring) + `GCE_PRIMARY` (use grounded for scoring) | Two-stage: shadow mode runs parallel for a window, primary promotes after gates. Rollback by demoting primary. Hard to reverse once `claim-extractor.ts` is deleted — therefore deletion is **last**, not first. |

---

## 5. Open questions (actually open)

These are questions this plan does NOT yet answer, as opposed to the two previously-listed "open" items that have been promoted to cutover gates.

1. **Graph coverage metric definition**: the existing `scrInferred / csrInferred` calculation assumes flat buckets. Under the ConstraintGraph model, coverage = `|matched_slots| / |expected_slots|` where "expected" is the union of graph slot nodes. But slots may be nested under `group_xor` (pick one), so strict equality is the wrong operator. Needs a formal definition of graph-coverage with group semantics before Axis 1 cutover gates can be written precisely.

2. **Multi-vendor constrained decoding**: Anthropic `tool_use` and OpenAI `json_schema` have different enforcement strengths for nested discriminated unions. The GCE claim envelope has a discriminated `AtomicClaimType` union with per-type `field` constraints — not all vendors guarantee this. Open question: do we emit a laxer schema and validate-then-reject post-hoc, or do we pick one vendor as primary and treat others as fallback?

3. **BundleSelector complexity ceiling**: bipartite assignment with budget constraints is NP-hard in general. For K ≤ 5 subqueries it's trivial. For K > 5 we need a heuristic. Open question: what's the worst-case realistic K? A "gift set of 12 wines under a single budget" is rare but legitimate.

4. **`entity_snapshots` deprecation**: ADR-008 left this table alive (FK to entities dropped, archive retained). Under a fully grounded eval world, per-entity rollback is handled by pointer flip + composite-PK append-only history. `entity_snapshots` may be dead weight. Separate ADR.

5. **Latency budget under 4-axis pipeline**: worst case per-query = 1 planner-LLM + N subquery-retrievals + up-to-3 critic-retries + 1 GCE-LLM. Rough headline: current p95 = 29s; projection puts 4-axis p95 at ~45-60s without streaming. Streaming prose generation while claims are still being verified is a UX mitigation, but it changes the response contract. Open.

---

## 6. What this plan does NOT do

Listed explicitly to prevent scope drift:

- Does not change `SearchResponseV1`. V2 is where GCE lives.
- Does not remove the flat `ConstraintBundle`. It survives as `legacyBundle` until the last reader migrates.
- Does not touch agent `step-budget.ts` or `adaptive-budget.ts`. Those guards are correct at the agent layer.
- Does not revisit ADR-008 runtime plane composite PK work. That plane is stable; this plan builds on it.
- Does not commit to a specific LLM vendor or model version for any of the new LLM calls. That is a separate config decision.
- Does not address OpenAI `gpt-5.4-mini` rate-limit issues in the bench (RCA Cause #4). That is external.

---

## 7. Commit traceability (cited files)

This plan references the following lines at HEAD commit `c90e635`. Future reviewers: if any of these drift, the corresponding section of this plan must be re-verified.

- `src/domain/response/model/search-response.ts:31` (SearchResponseV1 definition)
- `src/domain/response/model/search-response.ts:41` (V1 structure)
- `src/domain/response/service/response-builder.ts:1-19` (E4-U1 main runtime lock)
- `src/domain/query/model/query-plan.ts:29-37` (E1-U9 field freeze)
- `src/domain/query/service/constraint-compiler.ts:19-31` (ConstraintCompilerResult)
- `src/application/search/search-usecase-provenance-closure.ts:15-17` (flat hard-attribute read)
- `src/application/search/search-usecase-provenance-closure.ts:61-66` (top-result-based coverage)
- `src/application/search/search-usecase-decision-input.ts:254` (flat constraint reader)
- `src/application/search/search-usecase-hybrid-ranking-pipeline.ts:408` (flat bundle reader)
- `src/domain/agent/service/adaptive-budget.ts:1` (adaptive step budget)
- `src/domain/agent/service/step-budget.ts:16-49` (per-tool cap + Jaccard guard)
- `src/domain/evaluation/service/claim-level-evaluator.ts:108-110` (status-filtered denominator)
- `src/domain/evaluation/service/claim-extractor.ts:224` (Korean over-extraction, RCA Cause #1)
- `src/domain/evaluation/service/evidence-parser.ts:45-55` (regex-based observation parsing)
- `src/domain/evaluation/service/claim-verifier-deterministic.ts:61` (flat entity record verifier)

---

## 8. Next steps

1. Merge this plan as `docs/plans/2026-04-15-improvement.md` (this document).
2. Publish ADR-009 (Phase 0 only) with the narrower scope: **"Structured Evidence Carrier"**.
3. Begin Phase 0 implementation. No Phase 1 work starts until Phase 0 gates are green.

The reviewer's one-liner remains the operating frame: **"방향은 맞는데, ADR 제목이 '평가/생성 재설계'인 것보다 실제론 'planner/execution/provenance contract migration'에 더 가깝습니다."**
