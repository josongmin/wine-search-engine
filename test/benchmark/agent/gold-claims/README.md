# Gold Claims — ADR-016 Axis 3

This directory hosts the **gold annotation set** for the grounded claim
emitter's shadow-parity harness.

## Files

| File | Purpose |
|------|---------|
| `schema.ts` | Zod schema for a single annotation row. |
| `gold-claims.jsonl` | JSON-lines annotations. **Committed empty in the PR7 skeleton.** |
| `shadow-parity-proof.json` | Nightly-green proof file. Written by the harness; tracked under git so the extractor-deletion guard can read it. |

## Annotation row shape

One JSON object per line in `gold-claims.jsonl`:

```jsonc
{
  "queryId": "…",
  "query": "…",
  "rankedResultsRef": "…",   // fixture reference
  "expectedClaims": [
    {
      "type": "vintage_assertion",
      "category": "core_structured_claim",
      "text": "2015 vintage",
      "entityId": "…",
      "provenance": [{ "toolCallId": "…" }],
      "claimSchemaVersion": "claim_schema_v1"
    }
  ]
}
```

Every `expectedClaim` MUST validate under `GoldClaimRowSchema` in
`schema.ts`.

## Deletion gate

The legacy regex-based `src/domain/evaluation/service/claim-extractor.ts`
stays alive until:

1. This file (`gold-claims.jsonl`) has **≥ 200 entries**.
2. `shadow-parity-proof.json` records **≥ 2 consecutive nightly greens**
   at parity ≥ 0.95 — measured twice: once on `status='ok'` subset,
   once on full set (ADR-016 §2.8). The lower is the gate.

The file `test/regression/claim-extractor-deletion-guard.regression.test.ts`
enforces these pre-conditions at PR time.

## Dual-report bias

Per ADR-016 §2.8, shadow-parity metrics are reported **twice** — once
with the `status === 'ok'` filter and once without. Readers must quote
both; the **lower** is the effective gate.
