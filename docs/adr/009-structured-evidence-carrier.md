# ADR-009: Structured Evidence Carrier (Phase 0)

## Status: Proposed — 2026-04-15

This ADR captures Phase 0 of the
[2026-04-15 improvement plan](../plans/2026-04-15-improvement.md). Scope is
intentionally narrow: establish the typed evidence carrier that every
downstream axis (ConstraintGraph, self-critique RAG, Grounded Claim Emission)
will depend on.

## Context

The 2026-04-14 bench RCA surfaced a 51% `claimHardFail` rate, traced to the
agent pipeline reconstructing evidence from raw observation strings via regex
at [`evidence-parser.ts:45-55`](../../src/domain/evaluation/service/evidence-parser.ts#L45-L55).
The root cause is not the regex — it is that the engine collapses a native
structured result (`ResultItem[]`) into text, then asks the evaluator to parse
text back into records. The information is deliberately destroyed on the way
out and lossily reconstructed on the way in.

Every downstream axis in the improvement plan (Grounded Claim Emission's
`provenanceRef.toolCallId` / `passageSpan`, self-critique RAG's internal
coverage calculation, ConstraintGraph's assignment audit trail) needs a
trustworthy handle on **which tool call produced what structured output**.
The current `AgentToolResult = { observation: string; rawResult: unknown }`
contract does not provide that handle — `rawResult` is untyped and untraced.

## Decision

Introduce a typed **`ToolCallEvidenceFrame`** emitted alongside every tool
call. The frame is a sibling of the observation string — the observation
stays byte-equivalent to what the LLM saw (for prompt-audit transparency),
and the frame carries the same payload as typed structured data plus metadata
for replay.

```typescript
interface ToolCallEvidenceFrame {
  readonly frameSchemaVersion: 'tool_evidence_v1';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly invokedAt: string;                // ISO-8601
  readonly requestId: string;
  readonly request: ToolCallRequest;
  readonly structuredOutput: ToolCallStructuredOutput;
  readonly observationSnapshot: string;      // byte-equivalent LLM input
  readonly observationHash: string;          // sha256(observationSnapshot)
  readonly durationMs: number;
}
```

`ToolCallStructuredOutput` is a discriminated union:

```typescript
type ToolCallStructuredOutput =
  | { kind: 'search_result_set'; resultSet: readonly ResultItem[]; ... }
  | { kind: 'comparison_result'; response: ComparisonSearchResponse }
  | { kind: 'drinking_window'; entityId: CanonicalEntityId; window: DrinkingWindowBlock; ... }
  | { kind: 'food_pairing'; resultSet: readonly ResultItem[]; ... }
  | { kind: 'tool_error'; errorCode: string; message: string }
  | { kind: 'no_op'; reason: string };
```

The `kind` tag is closed — adding a new tool adds a new variant. This is a
compile-time guarantee that every tool has exactly one structured output shape.

### Invariants

1. **Reuses `ResultItem` as the SSoT**. No new parser, no shadow schema for
   the same payload. Whatever the agent sees, the evaluator gets the same
   object, not a regex-parsed echo.
2. **`observationSnapshot` is byte-equivalent** to what the LLM received.
   Enables prompt-replay audit.
3. **`observationHash`** makes replay deterministic. `observationSnapshot`
   drift between runs with the same snapshot+query produces a diff against
   the hash.
4. **`frameSchemaVersion` from v1**. Explicit from day one so that schema
   evolution does not silently break replay / bench comparability (P2 gate
   from the 2026-04-15 plan).
5. **Legacy evidence-parser stays**. `parseObservations` at
   [`evidence-parser.ts:45`](../../src/domain/evaluation/service/evidence-parser.ts#L45)
   is retained for pre-Phase-0 bench runs. New consumers prefer frames when
   present and fall back to parsing only when frames are absent.

## Implementation scope

Files touched:

| File | Change |
|------|--------|
| `src/domain/agent/model/tool-call-evidence-frame.ts` | New — type + Zod schema |
| `src/application/agent/agent-tools.ts` | `AgentToolResult` gains `structuredOutput`; each per-tool branch emits typed output; wrapper builds frame |
| `src/domain/agent/model/agent-step.ts` | `AgentStep` gains `evidenceFrames: readonly ToolCallEvidenceFrame[]` (optional during migration) |
| `src/domain/agent/model/agent-result.ts` | `AgentResult` gains `evidenceFrames` aggregate |
| `src/application/agent/agent-orchestrator.ts` | Thread frames from tool dispatch into agent-step records, aggregate into final result |
| `src/domain/evaluation/service/evidence-parser.ts` | Add `buildEvidenceRecordsFromFrames` path; legacy `parseObservations` retained for fallback |
| `test/benchmark/agent/runner.ts` | Prefer frames; emit `evidenceFrameCoverage` in bench summary |
| `src/domain/evaluation/model/bench-summary.ts` (or equivalent) | Add `evidenceFrameCoverage: number` field |
| **Regression tests** | 5+ new tests locking the contract |

The V1 response envelope (`SearchResponseV1`), the planner (`QueryPlanV1`),
the constraint compiler, and the runtime plane (ADR-008) are all **unchanged**
in Phase 0.

## Feature flag

`EVIDENCE_FRAME_EMIT` (env-driven, default `true` in development and CI,
required in production after cutover). Flag off restores the pre-ADR-009
behaviour:

- tool dispatcher emits only `{ observation, rawResult }`
- agent step has no `evidenceFrames` field in the output
- bench harness falls back to `parseObservations`

Rollback is therefore a flag flip.

## Cutover gate

`evidenceFrameCoverage >= 0.99` on two consecutive nightly bench runs.
Coverage is defined as:

```
evidenceFrameCoverage = |{ tool calls with structured frame }| / |{ tool calls total }|
```

Only once the gate holds does Phase 1 (ConstraintGraph) begin.

## Rollback plan

1. Flip `EVIDENCE_FRAME_EMIT=false` — tool dispatcher stops emitting frames.
2. Agent step `evidenceFrames` field is optional — absent when flag is off.
3. Bench harness falls back to legacy `parseObservations` automatically when
   `frames.length === 0`.
4. No schema migration, no data migration. DB and wire contracts unchanged.

## Alternatives considered

### Alt A — Emit only `rawResult` with tightened type

"Just type the existing `rawResult: unknown` as a union." Rejected: loses
`observationSnapshot` / `observationHash` / `toolCallId` — cannot support the
downstream `provenanceRef.toolCallId` contract GCE needs.

### Alt B — Drop the observation string entirely

"LLM can consume structured JSON directly." Rejected: observation strings
are authored to be token-efficient for the LLM context window; structured
JSON is 3-5x larger. This work is orthogonal to Phase 0 and may happen
independently in a separate ADR.

### Alt C — Store frames in a sidecar table (DB-backed)

"Persist frames for long-term replay." Rejected for Phase 0 scope. Frames
live in-memory during a request lifecycle only. Persistence is a separate
decision (likely ADR-011 once the bench gold set needs historical replay).

## Open questions

1. **Frame size ceiling**: `ResultItem` can be large under multi-entity
   scenarios. Do we cap frames at e.g. 50 KB and truncate with a
   `truncated: true` marker, or cap at the tool level (already done via
   `SUMMARY_TOP_N = 5`)? Defer to implementation — start with tool-level
   cap, add explicit frame cap only if bench telemetry justifies.
2. **Parallel batch frames**: the existing `executeAgentToolsBatch` returns
   multiple results. Each must get its own frame with a distinct
   `toolCallId`. Convention: `${requestId}-p${index}`. Matches the existing
   request-ID convention for parallel batches.
3. **Claude tool-use integration**: when the LLM emits `tool_use` blocks,
   does the frame `toolCallId` match the LLM's `tool_use_id`? Desirable for
   end-to-end traceability. Phase 0 does **not** guarantee this — the
   frame ID is engine-generated. Alignment is a Phase 3 (GCE) concern.

## References

- [2026-04-15 improvement plan](../plans/2026-04-15-improvement.md) §Axis 0
- [2026-04-14 RCA](../plans/2026-04-15-improvement.md#0-why-the-previous-draft-was-wrong) cause chain
- [ADR-008 runtime plane](008-runtime-plane-snapshot-scoped-primary-keys.md) — the previous contract migration this builds on
