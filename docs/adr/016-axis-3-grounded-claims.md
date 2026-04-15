# ADR-016 — Axis 3: grounded claim emission in the V2 sidecar

**Status**: Accepted (PR7 of the ADR-011 seven-PR train).
**Date**: 2026-04-15.
**Upstream**: [ADR-009](./009-structured-evidence-carrier.md) (frame v1/v1.1
carries `toolCallId`), [ADR-010](./010-constraint-graph-phase-1a.md) &
[ADR-011](./011-constraint-graph-phase-1b-first-reader.md) (`ConstraintGraph`
available on `compiled`), [ADR-013](./013-constraint-graph-phase-1c-bundle-selector.md)
(BundleSelector `degradationReasons`), [ADR-015](./015-axis-2-retrieval-critic.md)
(critic `criticRewrites` + `criticRetriesExhausted`).
**Downstream**: future extractor-deletion PR; future `/v2/search/*`
non-sidecar wiring PR.

---

## 1. Problem

The V2 machine sidecar returns `results: RankedResult[]` with no structured
claim surface. Downstream faithfulness evaluation re-derives claims from
prose via the legacy regex-based `claim-extractor.ts`. That path is:

- **Lossy** — regex cannot recover tool-call-level provenance.
- **Brittle** — prose phrasing changes break extraction.
- **Unverifiable** — no per-claim schema, no per-claim category for
  per-type verifier dispatch.

We also now have four upstream signals that must become first-class in
the response envelope:

1. `ToolCallEvidenceFrame.toolCallId` (ADR-009) — stable provenance anchor.
2. `compiled.constraintGraph` (ADR-010/011) — authoritative constraint
   semantics, so claim verifiers can reference the same slot identity as
   the retriever and ranker.
3. `criticRewrites` / `criticRetriesExhausted` (ADR-015) — user-visible
   degradations the response must surface honestly.
4. BundleSelector `degradationReasons` (ADR-013) — identical reasoning.

---

## 2. Decision

Extend `SearchResponseV2Machine` with an **optional** `grounded` envelope:

```
grounded?: {
  proseSegments: ProseSegment[],
  claims: AtomicClaim[],
  degradationReasons?: string[],
  claimSchemaVersion: 'claim_schema_v1',
}
claimSchemaVersion?: 'claim_schema_v1'   // envelope-level mirror
```

V1 responses are **untouched**. V2 human responses are untouched. Only
the machine sidecar carries the grounded payload.

### 2.1 Dual classification on every `AtomicClaim`

Every claim carries **both** axes:

| Axis | Field | Cardinality | Source-of-truth module | Purpose |
|------|-------|-------------|------------------------|---------|
| Field-level | `type: AtomicClaimType` | 9 | `src/domain/response/model/atomic-claim-type.ts` | What kind of value (for UX, explanation, per-type verifier). |
| Routing | `category: ClaimCategory` | 5 | `src/domain/evaluation/model/claim.ts` (RFC-020) | How to verify (for claim-verifier-router dispatch). |

`AtomicClaimType` members: `entity_reference`, `attribute_assertion`,
`price_assertion`, `vintage_assertion`, `pairing_assertion`,
`comparative_assertion`, `drinking_window_assertion`, `style_assertion`,
`recommendation`.

The two classifications are **orthogonal** but correlated. The
9→5 default mapping is:

| 9-class `type` | 5-class `category` | Verifier file |
|----------------|---------------------|---------------|
| `entity_reference` | `identity_claim` | `entity-reference-verifier.ts` |
| `attribute_assertion` | `derived_structured_claim` | `attribute-assertion-verifier.ts` |
| `price_assertion` | `core_structured_claim` | `price-assertion-verifier.ts` |
| `vintage_assertion` | `core_structured_claim` | `vintage-assertion-verifier.ts` |
| `pairing_assertion` | `semantic_claim` | `pairing-assertion-verifier.ts` |
| `comparative_assertion` | `comparative_claim` | `comparative-assertion-verifier.ts` |
| `drinking_window_assertion` | `core_structured_claim` | `drinking-window-assertion-verifier.ts` |
| `style_assertion` | `derived_structured_claim` | `style-assertion-verifier.ts` |
| `recommendation` | `semantic_claim` | `recommendation-verifier.ts` (`NoopVerifier`) |

A Zod refine validates that every claim's `(type, category)` pair is a
member of this table. Drift → schema-level failure, fail-closed.

### 2.2 Per-claim `claimSchemaVersion`

Non-optional on `AtomicClaim`. Optional on the envelope (backward-compat
for consumers that don't read individual claims yet). This is a
**blocking cutover gate** — when `claim_schema_v2` ships, every claim is
upgraded or dropped; downstream code can branch on the per-claim field
directly without re-fetching metadata.

### 2.3 LLM topology: Anthropic primary, OpenAI fallback

- **Anthropic** (primary): `tool_use` with a frozen Zod-derived JSON
  Schema. Temperature 0, seed pinned, `prompt_version='claim_emit_v1'`.
- **OpenAI** (fallback): `json_schema` mode with post-hoc Zod **lax**
  validation. Lax accepts `number`-as-`string` (CLAUDE.md rule on LLM
  JSON output), rejects unknown `claim.type` values. Both paths produce
  the same `GroundedPayload`.

Both code paths live; the composition root picks one based on
`GCE_LLM_PROVIDER` (default `anthropic`).

### 2.4 Fail-closed policy

Any emitter failure → **empty payload** with
`degradationReasons: ['grounded_claim_emission_failed']`. The response
is still valid; consumers see "no grounded claims" rather than
malformed data.

Unknown `toolCallId` in a provenance ref → **drop that claim only**,
append `degradationReasons: ['provenance_tool_call_id_unknown']`. The
remaining claims are preserved.

### 2.5 Upstream-signal surfacing

| Signal | How surfaced in `grounded` |
|--------|-----------------------------|
| `criticRetriesExhausted=true` | `degradationReasons` includes `critic_retries_exhausted` **and** an `AtomicClaim { type: 'recommendation', text: '검색 조건을 완화했습니다', … }`. |
| `criticRewrites[]` | Each rewrite → `AtomicClaim { type: 'recommendation', text: 'we relaxed X', … }` with provenance pointing at the rewrite's source frame. |
| BundleSelector `degradationReasons` | Merged into `grounded.degradationReasons` verbatim. |

### 2.6 Legacy extractor lifecycle

`claim-extractor.ts` stays alive in **shadow mode**. Deletion is **NOT
this PR**. It is a separate future PR, guarded by
`test/regression/claim-extractor-deletion-guard.regression.test.ts`,
which fails unless:

- Gold annotation file has ≥ 200 entries.
- Shadow parity proof file records ≥ 2 consecutive nightly greens at
  parity ≥ 0.95.

The guard **passes vacuously** in this PR because the extractor still
exists on disk.

### 2.7 Feature flags

| Flag | Default | Effect |
|------|---------|--------|
| `GCE_SHADOW_EMIT` | off | When on, the emitter runs and `grounded` is attached to V2 machine responses. Verification still uses legacy extractor. |
| `GCE_PRIMARY` | off | When on **and** `GCE_SHADOW_EMIT=on`, the grounded payload becomes the source of truth for the claim-level evaluator. |
| `GCE_LLM_PROVIDER` | `anthropic` | `anthropic` | `openai`. Provider drift policy in §2.3. |

All three are raw `process.env.*` reads; see `grounded-claim-emitter.ts`
and `machine-response-builder-v2.ts`.

### 2.8 Evaluator-bias dual reporting

The pre-PR7 `claim-level-evaluator.ts` aggregated only `status === 'ok'`
verifications in denominators. This is one of two defensible choices —
the other is "include all, treat skipped as `not_entailed`". PR7 reports
**both** values (`faithfulnessScoreAll`, `faithfulnessScoreOk`) and
documents the **lower of the two** as the effective gate number. This
prevents cherry-picking.

---

## 3. Cutover gates (blocking)

1. **Gold annotation** ≥ 200 scenarios in
   `test/benchmark/agent/gold-claims/gold-claims.jsonl` (this PR commits
   the empty skeleton + schema; annotation is future work).
2. **Per-claim `claimSchemaVersion`** on every emitted claim
   (lint-equivalent: `.strict()` + refine fires at schema level).
3. **Shadow parity ≥ 0.95** measured twice — once on `status='ok'`
   subset, once on full set. The **lower** is the gate.
4. **Evaluator-bias dual reporting** implemented and ADR-documented.

These four gates are checked in the deletion-guard regression test.
This PR ships gates 2 + 4 green; gates 1 + 3 ship in follow-ups.

---

## 4. Shadow parity harness

Layout:

```
test/benchmark/agent/gold-claims/
  README.md             (human notes, annotator instructions)
  schema.ts             (Zod for a single annotation row)
  gold-claims.jsonl     (annotations — EMPTY in this PR)
  shadow-parity-proof.json  (ASCII report; written nightly; tracked)
```

Each annotation row: `{ queryId, rankedResultsRef, expectedClaims: AtomicClaim[] }`.
The parity harness runs the emitter + legacy extractor over the
identical ranked-result set and compares per-field: entity coverage,
type coverage, text similarity ≥ 0.85 (edit-distance floor — same as
RFC-020 semantic matcher).

---

## 5. Rollback

Three levels:

1. **Fast**: `GCE_SHADOW_EMIT=false` → `grounded` field absent →
   response envelope is bit-compatible with pre-PR7.
2. **Shadow-only**: `GCE_SHADOW_EMIT=true, GCE_PRIMARY=false` → emitter
   runs, legacy extractor is authoritative. Default.
3. **Full revert**: schema extension is a pure-optional Zod widening;
   pre-PR7 responses still parse under the new schema.

No data migration. No schema breakage.

---

## 6. Risks

- **LLM cost** — emitter call per response. Default-off flag + ramp.
- **Provider drift** — Anthropic `tool_use` vs OpenAI `json_schema`.
  Zod lax on the OpenAI path normalises; both live.
- **Two classifications confuse consumers** — Zod refine + table in §2.1
  enforces the mapping.
- **`toolCallId` drift** — emitter validates against frame-set, drops
  unknown IDs with explicit degradation reason.
- **Extractor deletion premature** — CI guard blocks until gate 1 + 3
  green.

---

## 7. References

- RFC-020 (claim categories).
- ADR-009 (evidence frames v1.1).
- ADR-015 (critic signals).
- CLAUDE.md rules 10, 12 (LLM number-as-string, `JSON.parse` hygiene).
