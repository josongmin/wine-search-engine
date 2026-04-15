# PR7 — ADR-016 Axis 3: grounded claim emission

> **Scope envelope**: extend `MachineResponseV2Machine` with a
> `grounded?: GroundedPayload` envelope carrying prose segments,
> atomic claims (9-class field-level type union), and provenance
> refs that point at `ToolCallEvidenceFrame.toolCallId`. Extend
> `claim-verifier-router.ts` with per-type verifier branches. Keep
> the legacy `claim-extractor.ts` alive in shadow mode; its deletion
> is CI-gated on gold set + two-nightly shadow green.
>
> **Parent plan**: [2026-04-15-improvement.md](../2026-04-15-improvement.md)
> Axis 3 / grounded claim emission. **Upstream**: [ADR-009](../../adr/009-structured-evidence-carrier.md)
> (`ToolCallEvidenceFrame`), [RFC-020](../../RFC-020.md) (`ClaimCategory`),
> [ADR-015](../../adr/015-axis-2-retrieval-critic.md) (frame schema v1.1).
> **This PR drafts ADR-016**.
>
> **Anchor commit**: PR1–PR6 all landed and green for two nightlies.
> **Strictly last** in the 7-PR train.

---

## 1. Why this PR

The machine response today returns `results: RankedResult[]` at
[search-response-v2.schema.ts:192](../../../src/domain/response/schema/search-response-v2.schema.ts#L192)
with no structured claim surface. Downstream consumers (explainer,
conversational agent, auditor) reconstruct claims by regex over
prose — the legacy [claim-extractor.ts](../../../src/domain/evaluation/service/claim-extractor.ts)
path. This is:
- **Lossy** — regex cannot recover provenance at the tool-call level.
- **Brittle** — prose phrasing changes break extraction.
- **Unverifiable** — no per-claim schema, no per-claim category for
  router dispatch.

Axis 3 emits claims directly from the response builder with:
- LLM-constrained JSON output (Anthropic `tool_use` primary; OpenAI
  `json_schema` via post-hoc Zod lax validation).
- Provenance refs pointing at `ToolCallEvidenceFrame.toolCallId` (from
  Axis 0, frame schema v1.1 from PR6).
- Two orthogonal classifications per claim:
  - `type: AtomicClaimType` (9-class field-level — what kind of value).
  - `category: ClaimCategory` (5-class routing from RFC-020 — how to verify).
- Per-claim `claimSchemaVersion` + envelope-level `claimSchemaVersion`
  for future migrations.

Legacy `claim-extractor.ts` stays alive in **shadow mode** — runs
in parallel, compared against LLM emission on a gold set — deletion
is CI-gated on `gold set ≥ 200 scenarios + 2 nightlies green + shadow
parity ≥ 0.95`.

**Explicit non-scope**:
- Per-claim remediation UX — out of scope for this PR.
- New `AtomicClaimType` classes beyond the 9 agreed.
- Response body shape beyond the new optional `grounded` field.

---

## 2. File-by-file change checklist

### 2.1 New files

| File | Purpose |
|------|---------|
| [docs/adr/016-axis-3-grounded-claim-emission.md](../../adr/016-axis-3-grounded-claim-emission.md) | New ADR: emission rationale, 9-class `AtomicClaimType` vs 5-class `ClaimCategory` coexistence, Anthropic-primary / OpenAI-fallback drift policy, shadow-mode gate, gold-set requirement, per-claim schema version policy, extractor-deletion CI gate. |
| [src/domain/response/model/grounded-claim.ts](../../../src/domain/response/model/grounded-claim.ts) | Types: `ProseSegment`, `AtomicClaim { type: AtomicClaimType; category: ClaimCategory; claimSchemaVersion: 'claim_schema_v1'; provenance: ProvenanceRef[] }`, `ProvenanceRef { toolCallId: string; evidencePath?: string }`, `AtomicClaimType` (9 classes — see below), `GroundedPayload`. Zod `.strict()`. |
| [src/domain/response/model/atomic-claim-type.ts](../../../src/domain/response/model/atomic-claim-type.ts) | Named-literal union `AtomicClaimType = 'varietal' \| 'producer' \| 'region' \| 'vintage' \| 'price' \| 'score' \| 'food_pairing' \| 'sensory' \| 'recommendation'`. Zod enum. SSoT. |
| [src/domain/response/service/grounded-claim-emitter.ts](../../../src/domain/response/service/grounded-claim-emitter.ts) | LLM-constrained emitter. Input: ranked results + evidence frames + graph + generated prose. Output: `GroundedPayload` or `null` on failure (fail-closed → empty payload + `degradationReasons`). Anthropic `tool_use` primary schema; post-hoc Zod lax for OpenAI. |
| [src/domain/response/service/prompts/grounded-claim-emit.prompt.ts](../../../src/domain/response/service/prompts/grounded-claim-emit.prompt.ts) | Frozen emitter prompt + `prompt_version='claim_emit_v1'`. |
| [src/domain/evaluation/service/verifiers/varietal-verifier.ts](../../../src/domain/evaluation/service/verifiers/varietal-verifier.ts) | Per-type verifier (identity-class). |
| [src/domain/evaluation/service/verifiers/producer-verifier.ts](../../../src/domain/evaluation/service/verifiers/producer-verifier.ts) | Per-type verifier. |
| [src/domain/evaluation/service/verifiers/region-verifier.ts](../../../src/domain/evaluation/service/verifiers/region-verifier.ts) | Per-type verifier. |
| [src/domain/evaluation/service/verifiers/vintage-verifier.ts](../../../src/domain/evaluation/service/verifiers/vintage-verifier.ts) | Per-type verifier. |
| [src/domain/evaluation/service/verifiers/price-verifier.ts](../../../src/domain/evaluation/service/verifiers/price-verifier.ts) | Structured-value verifier. |
| [src/domain/evaluation/service/verifiers/score-verifier.ts](../../../src/domain/evaluation/service/verifiers/score-verifier.ts) | Structured-value verifier. |
| [src/domain/evaluation/service/verifiers/food-pairing-verifier.ts](../../../src/domain/evaluation/service/verifiers/food-pairing-verifier.ts) | Semantic verifier. |
| [src/domain/evaluation/service/verifiers/sensory-verifier.ts](../../../src/domain/evaluation/service/verifiers/sensory-verifier.ts) | Semantic verifier. |
| [src/domain/evaluation/service/verifiers/noop-verifier.ts](../../../src/domain/evaluation/service/verifiers/noop-verifier.ts) | `NoopVerifier` for `'recommendation'` (no ground truth — pass-through, never fails). |
| [src/domain/evaluation/service/grounded-evidence-sidecar.ts](../../../src/domain/evaluation/service/grounded-evidence-sidecar.ts) | Frame-identity-preserving sidecar derived from evidence frames. Needed because [build-evidence-records-from-frames.ts:1](../../../src/domain/evaluation/service/build-evidence-records-from-frames.ts#L1) returns flat `EvidenceRecord` with no `toolCallId` preservation. The sidecar maps `provenanceRef.toolCallId` back to the frame. |
| [test/benchmark/agent/gold-claims/SCHEMA.md](../../../test/benchmark/agent/gold-claims/SCHEMA.md) | Describes the gold annotation shape. |
| [test/benchmark/agent/gold-claims/gold-claims.schema.ts](../../../test/benchmark/agent/gold-claims/gold-claims.schema.ts) | Zod schema for gold annotations. Committed empty — annotation task is separate work. |
| [test/benchmark/agent/gold-claims/gold-claims.empty.jsonl](../../../test/benchmark/agent/gold-claims/gold-claims.empty.jsonl) | Empty skeleton file. |
| [test/regression/grounded-claim-emitter.regression.test.ts](../../../test/regression/grounded-claim-emitter.regression.test.ts) | ~10 cases (see §3). |
| [test/regression/grounded-claim-schema-lock.regression.test.ts](../../../test/regression/grounded-claim-schema-lock.regression.test.ts) | Locks envelope shape, 9-class `AtomicClaimType`, 5-class `ClaimCategory` coexistence, per-claim + envelope `claimSchemaVersion`. |
| [test/regression/claim-verifier-router-branch-coverage.regression.test.ts](../../../test/regression/claim-verifier-router-branch-coverage.regression.test.ts) | Each of 9 `AtomicClaimType` values routes to its verifier; `recommendation` routes to NoopVerifier. |
| [test/regression/claim-shadow-parity.regression.test.ts](../../../test/regression/claim-shadow-parity.regression.test.ts) | Dual-path runner: legacy `claim-extractor.ts` vs LLM emitter on identical input; asserts per-field parity ≥ 0.95 on the gold set subset. |
| [test/regression/claim-extractor-deletion-guard.regression.test.ts](../../../test/regression/claim-extractor-deletion-guard.regression.test.ts) | CI guard: fails the PR if `claim-extractor.ts` file is absent AND (`gold-claims.empty.jsonl` has <200 entries OR shadow parity flag not set). |

### 2.2 Modified files

| File | Change |
|------|--------|
| [src/domain/response/schema/search-response-v2.schema.ts](../../../src/domain/response/schema/search-response-v2.schema.ts#L192) | Extend `MachineResponseV2Machine` Zod at [line 192](../../../src/domain/response/schema/search-response-v2.schema.ts#L192) with optional `grounded?: GroundedPayload` + `claimSchemaVersion?: 'claim_schema_v1'`. `.strict()` maintained. |
| [src/domain/response/service/machine-response-builder-v2.ts](../../../src/domain/response/service/machine-response-builder-v2.ts#L34) | Extend `MachineResponseBuildParamsV2` with optional `evidenceFrames?: readonly ToolCallEvidenceFrame[]`, `constraintGraph?: ConstraintGraph \| undefined`, `generatedProse?: string`. When all three present and `GROUNDED_CLAIM_EMIT` flag on → call emitter; attach output to `grounded`. |
| [src/interface/claude-tools/tool-executor.ts](../../../src/interface/claude-tools/tool-executor.ts#L95) | Pass `evidenceFrames` into `buildMachineResponseV2`. Currently the sidecar call-site — document in ADR-016 that `/v2/search/*` wiring (i.e. the non-sidecar path) is OUT OF SCOPE for PR7. The non-sidecar path gets claim emission in a future PR. |
| [src/domain/evaluation/service/claim-verifier-router.ts](../../../src/domain/evaluation/service/claim-verifier-router.ts#L37) | Extend type-based routing at [line 37](../../../src/domain/evaluation/service/claim-verifier-router.ts#L37) with 9 new branches, one per `AtomicClaimType`. `recommendation` → `NoopVerifier`. Each branch instantiates the verifier from the new files above. |
| [src/domain/evaluation/service/claim-level-evaluator.ts](../../../src/domain/evaluation/service/claim-level-evaluator.ts#L108-L110) | At [lines 108–110](../../../src/domain/evaluation/service/claim-level-evaluator.ts#L108-L110), dual-report evaluator metrics: WITH `status !== 'ok'` filter AND WITHOUT. Both reported in summary. Mitigates bias from a single filter choice. |
| [src/config/feature-flags.ts](../../../src/config/feature-flags.ts) | Add `GROUNDED_CLAIM_EMIT` (default off), `CLAIM_EXTRACTOR_SHADOW_MODE` (default on — runs extractor in parallel; deletion gate flips this off). |
| [src/config/composition-root.ts](../../../src/config/composition-root.ts) | Wire `grounded-claim-emitter`, sidecar builder, all 9 verifiers. |

### 2.3 Files I explicitly do NOT touch (in PR7)

- [src/domain/evaluation/service/claim-extractor.ts](../../../src/domain/evaluation/service/claim-extractor.ts) — stays alive in shadow mode. Deletion is a **separate future PR** gated on the CI guard passing.
- [src/domain/evaluation/service/build-evidence-records-from-frames.ts:1](../../../src/domain/evaluation/service/build-evidence-records-from-frames.ts#L1) — kept; the new sidecar is added alongside, not replacing.
- [src/domain/agent/model/tool-call-evidence-frame.ts](../../../src/domain/agent/model/tool-call-evidence-frame.ts) — already at v1.1 from PR6.
- `RFC-020.md` `ClaimCategory` taxonomy — frozen, imported from there.
- `/v2/search/*` non-sidecar wiring — deferred to follow-up PR.

---

## 3. Test additions

| Test file | Cases | Locks |
|-----------|-------|-------|
| [test/regression/grounded-claim-emitter.regression.test.ts](../../../test/regression/grounded-claim-emitter.regression.test.ts) | ~10 | Emitter returns valid `GroundedPayload` on happy input; malformed LLM JSON → fail-closed empty payload + `degradationReasons=['grounded_claim_emit_llm_error']`; per-claim `claimSchemaVersion='claim_schema_v1'`; provenance `toolCallId` references existing frame; unknown `toolCallId` → fail-closed per-claim drop; 9 `AtomicClaimType` values supported; `category` coexists with `type`; LLM number-as-string tolerated (rule 10); no claims → empty array, not null. |
| [test/regression/grounded-claim-schema-lock.regression.test.ts](../../../test/regression/grounded-claim-schema-lock.regression.test.ts) | ~6 | Envelope schema matches; 9-class type union frozen; 5-class category union frozen; both fields coexist on every claim; envelope + per-claim `claimSchemaVersion` both required; `.strict()` rejects extras. |
| [test/regression/claim-verifier-router-branch-coverage.regression.test.ts](../../../test/regression/claim-verifier-router-branch-coverage.regression.test.ts) | 9 | Each `AtomicClaimType` routes to its verifier; `recommendation` → `NoopVerifier`; unknown type throws loudly. |
| [src/domain/response/service/__tests__/machine-response-builder-v2.test.ts](../../../src/domain/response/service/__tests__/machine-response-builder-v2.test.ts) | +5 | Builder attaches `grounded` when evidence frames + graph + prose present; omits `grounded` when flag off; omits `grounded` when any input missing; emitter failure degrades gracefully; envelope `claimSchemaVersion` set. |
| [test/regression/claim-shadow-parity.regression.test.ts](../../../test/regression/claim-shadow-parity.regression.test.ts) | 2 gates | Shadow parity measured twice: on `status='ok'` subset AND on full set. Both reported; ≥0.95 on each. **This is the 5th gate added over the 4-gate plan**. |
| [test/regression/claim-extractor-deletion-guard.regression.test.ts](../../../test/regression/claim-extractor-deletion-guard.regression.test.ts) | 1 | CI guard (see §6 Risk 2). |

Per-verifier unit tests go under `src/domain/evaluation/service/verifiers/__tests__/*.test.ts` — one per verifier, ≥3 cases each (happy, mismatch, missing-evidence).

---

## 4. Call-graph sanity checks (pre-coding)

- [ ] Confirm `MachineResponseBuildParamsV2` at [machine-response-builder-v2.ts:34](../../../src/domain/response/service/machine-response-builder-v2.ts#L34) current shape is `{queryId, results}`; any hidden dependency on those fields alone must survive the widening.
- [ ] Confirm `tool-executor.ts:95` is the ONLY caller of `buildMachineResponseV2` currently. `/v2/search/*` non-sidecar path still uses... grep to verify. Deferred from this PR, but must not regress.
- [ ] Confirm [claim-verifier-router.ts:37](../../../src/domain/evaluation/service/claim-verifier-router.ts#L37) routing is type-based (not category-based). It is per user fact. Extension is 9 new branches; no category-based routing changes.
- [ ] Confirm RFC-020 `ClaimCategory` is exported from [src/domain/evaluation/model/claim.ts:14](../../../src/domain/evaluation/model/claim.ts#L14). Both taxonomies live in `src/domain/evaluation/model/` to keep SSoT.
- [ ] Confirm `ToolCallEvidenceFrame.toolCallId` is unique per tool call across a request. If not, provenance refs are ambiguous — emitter must fail loudly.
- [ ] Confirm Anthropic `tool_use` schema-forcing is supported on the current SDK version. If not, fall back to `json_schema` with post-hoc Zod.

Bail early if any assumption breaks.

---

## 5. Cutover gate

All items green before commit:

1. **Gold annotation**: ≥200 scenario annotations in `test/benchmark/agent/gold-claims/gold-claims.jsonl` (committed empty in this PR; annotation work is separate but must complete before the extractor-deletion gate).
2. **Per-claim `claim_schema_version`** set on every emitted claim (locked by `grounded-claim-schema-lock`).
3. **Shadow parity ≥ 0.95** measured on status='ok' subset AND full set — both reported (**5th gate**).
4. **Evaluator-bias dual reporting** at [claim-level-evaluator.ts:108-110](../../../src/domain/evaluation/service/claim-level-evaluator.ts#L108-L110) with and without filter.
5. **All 9 verifier branches covered** by router regression.
6. **`pnpm run git:prepush` green**.
7. **Extractor stays alive** — `claim-extractor.ts` file exists at commit time; deletion guard test passes.
8. **Rollback verified**: `GROUNDED_CLAIM_EMIT=false` → `grounded` field absent from response → pre-PR7 shape. Legacy extractor path unchanged.

---

## 6. Risks & mitigations

### Risk 1 — Anthropic `tool_use` vs OpenAI `json_schema` drift
Anthropic enforces JSON shape via `tool_use`; OpenAI via `json_schema`.
Subtle semantic differences (optional-vs-required, additionalProperties)
cause emission drift across providers.

**Mitigation**: **Anthropic primary**. OpenAI support goes through
post-hoc Zod **lax** validation (accept extra fields, coerce
number-strings per rule 10). Both paths produce the same `GroundedPayload`
shape. Regression test case #4 in emitter covers the OpenAI number-as-string.

### Risk 2 — `claim-extractor.ts` deletion is catastrophic if premature
Premature deletion loses the legacy extraction capability with no
ground truth to compare. The CI guard is the only safety net.

**Mitigation**: **Deletion is LAST, not first.** PR7 explicitly keeps
the file alive. A separate future PR deletes it after:
- Gold annotations reach ≥200 scenarios.
- 2 consecutive nightlies green with shadow parity ≥0.95.
- `CLAIM_EXTRACTOR_SHADOW_MODE` flag has been on for ≥1 week.

The deletion-guard regression test fails the PR if any condition unmet.

### Risk 3 — Evaluator-bias dual reporting confusion
Reporting metrics with AND without `status !== 'ok'` filter produces
two numbers. Readers may pick the favourable one.

**Mitigation**: summary table prints both labelled clearly. ADR-016
prescribes the **lower of the two** as the gate number. Documented
in the gold-annotation SCHEMA.md.

### Risk 4 — Provenance `toolCallId` drift
If emitter references a `toolCallId` that doesn't exist in the frame
set, provenance is broken silently.

**Mitigation**: emitter validates every `provenance.toolCallId` against
the input frame set; unknown IDs → drop the claim, add
`degradationReasons` entry. Locked by emitter regression case #4.

### Risk 5 — Two classifications per claim confuse consumers
`type` (9-class, what-the-value-is) and `category` (5-class, how-to-verify)
are orthogonal but may be confused.

**Mitigation**: ADR-016 has an explicit decision table mapping every
9-class type to its default 5-class category. Code enforces the mapping
at schema validation (Zod `.refine`). Docs and per-field schema comments
reference the table.

### Risk 6 — Router branch explosion
9 new verifier classes + router branches = 9 new files to maintain.

**Mitigation**: each verifier is 1 file, small (≤50 LOC typical), with
a shared `VerifierBase` interface. `NoopVerifier` handles the one
`recommendation` class that has no ground truth. Consistent file
layout lowers cognitive load.

### Risk 7 — Empty gold annotation file blocks progress
Committing `gold-claims.empty.jsonl` with zero entries means the
deletion guard will never fire unless annotations get added.

**Mitigation**: guard fires at PR-time only if extractor is deleted.
Extractor stays in this PR, so guard passes vacuously. Separate
follow-up work fills annotations over weeks — expected timeline.

### Risk 8 — LLM cost on every response
Claim emitter calls LLM per response. At scale this is significant.

**Mitigation**: `GROUNDED_CLAIM_EMIT` flag gates the whole path. Default
off. Traffic ramp controlled by flag rollout (0% → 10% → 50% → 100%).
ADR-016 documents expected latency p95.

---

## 7. Rollback plan

Three-level rollback:

1. **Fast**: `GROUNDED_CLAIM_EMIT=false` → builder skips emitter →
   `grounded` field absent from response → pre-PR7 envelope shape.
   Legacy extractor path untouched.
2. **Shadow-only**: `CLAIM_EXTRACTOR_SHADOW_MODE=true` (default) → both
   paths run; legacy is authoritative; LLM emission runs for parity
   measurement only.
3. **Full**: revert the PR. Schema extension is optional (backward
   compatible Zod), so stored responses under pre-PR7 shape continue
   to parse under the new schema and vice versa.

No data migration. The optional `grounded?` field is the only
envelope change.

---

## 8. Checklist (execution order)

- [ ] §4 sanity checks (consumers of `MachineResponseV2Machine`, `tool-executor.ts:95` callers, RFC-020 import paths, Anthropic `tool_use` SDK support).
- [ ] Draft [ADR-016](../../adr/016-axis-3-grounded-claim-emission.md) including type/category mapping table.
- [ ] Commit `atomic-claim-type.ts` + `grounded-claim.ts` model + schema-lock regression.
- [ ] Extend `search-response-v2.schema.ts` with optional `grounded`.
- [ ] Write emitter + prompt; 10-case emitter regression fail-first.
- [ ] Write 9 verifier files + 9 unit tests.
- [ ] Extend `claim-verifier-router.ts` with 9 branches; branch-coverage regression.
- [ ] Write sidecar `grounded-evidence-sidecar.ts`.
- [ ] Extend `machine-response-builder-v2.ts` with widened params + optional emitter call; 5 builder tests.
- [ ] Extend `claim-level-evaluator.ts:108-110` dual-reporting.
- [ ] Wire `tool-executor.ts:95` to pass evidence frames.
- [ ] Commit `gold-claims` schema + empty skeleton + SCHEMA.md.
- [ ] Shadow parity regression + deletion-guard regression.
- [ ] Add feature flags + composition-root wiring.
- [ ] Run bench once with `GROUNDED_CLAIM_EMIT=true` shadow; compute parity.
- [ ] `pnpm run typecheck && pnpm run lint`.
- [ ] `pnpm run git:prepush`.
- [ ] Commit.

---

## 9. Commit message draft

```
feat(adr-016-axis-3): grounded claim emission with dual classification

Extends MachineResponseV2Machine with an optional `grounded` envelope
carrying prose segments, atomic claims (9-class AtomicClaimType
field-level union), and provenance refs that point at
ToolCallEvidenceFrame.toolCallId (frame v1.1 from PR6). Each claim
also carries its RFC-020 ClaimCategory (5-class routing axis) — the
two classifications coexist.

Legacy claim-extractor.ts stays alive in shadow mode; deletion is a
future PR gated on gold set >= 200 scenarios + 2 nightlies green +
shadow parity >= 0.95 on BOTH status='ok' subset and full set.

- New ADR-016 with type/category mapping table and extractor-deletion
  CI gate policy
- New src/domain/response/model/{grounded-claim,atomic-claim-type}.ts
- New src/domain/response/service/grounded-claim-emitter.ts
  (Anthropic tool_use primary; OpenAI json_schema via Zod lax)
- Frozen prompt claim_emit_v1
- 9 new verifier classes under src/domain/evaluation/service/verifiers/
  + NoopVerifier for 'recommendation'
- claim-verifier-router.ts extended with 9 type-based branches
- claim-level-evaluator.ts:108-110 dual-reporting with AND without
  status filter (evaluator-bias mitigation)
- search-response-v2.schema.ts:192 optional grounded + claimSchemaVersion
- machine-response-builder-v2.ts:34 widened params; sidecar for
  frame-identity-preserving evidence derivation
- test/benchmark/agent/gold-claims/ skeleton + SCHEMA.md (annotations
  separate work)
- 5 new regression files (~30 cases) including extractor-deletion guard
- GROUNDED_CLAIM_EMIT + CLAIM_EXTRACTOR_SHADOW_MODE feature flags

Rollback: GROUNDED_CLAIM_EMIT=false -> grounded field absent -> pre-PR7
envelope shape. Legacy extractor path unchanged.
```
