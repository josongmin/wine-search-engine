# Gold Claims — ADR-016 Axis 3

This directory hosts the **gold annotation set** for the grounded claim
emitter's shadow-parity harness.

## Files

| File | Purpose |
|------|---------|
| `schema.ts` | Zod schema for a single annotation row. |
| `gold-claims.jsonl` | JSON-lines annotations. **60 bootstrap rows (Wave D + Wave I6); production cutover requires ≥200.** |
| `shadow-parity-proof.json` | Nightly-green proof file. Written by the harness; tracked under git so the extractor-deletion guard can read it. |

## Bootstrap annotation set (60 rows)

The bootstrap set is synthesised from well-known public wine facts over
the 8-wine evidence catalog (Opus One 2018, Sassicaia 2018, Penfolds
Grange 2017, Masi Amarone, Barolo Monfortino 2015, Moet Brut Imperial,
Chateau d'Yquem 2015, Cloudy Bay 2022). It is **not** the ADR-016 §2.8
cutover gate — that gate requires ≥200 human-annotated rows.

### Per-`AtomicClaimType` distribution (60 rows)

| Type | Wave D (30) | Wave I6 delta | Total (60) |
|------|:-:|:-:|:-:|
| `entity_reference` | 8 | +6 | 14 |
| `attribute_assertion` | 3 | +6 | 9 |
| `price_assertion` | 4 | +4 | 8 |
| `vintage_assertion` | 6 | +4 | 10 |
| `pairing_assertion` | 2 | +3 | 5 |
| `comparative_assertion` | 1 | +3 | 4 |
| `drinking_window_assertion` | 1 | +2 | 3 |
| `style_assertion` | 4 | +2 | 6 |
| `recommendation` | 1 | +0 | 1 |
| **Total** | **30** | **+30** | **60** |

### Shadow-parity measurement

Measured with `runShadowParity` over the canned-LLM bootstrap harness
(see `test/benchmark/evaluator/shadow-parity-harness.ts`):

| Set size | `statusOkSubset` | `fullSet` | Effective gate |
|----------|:-:|:-:|:-:|
| 30 (Wave D) | 0.500 (15/30) | 0.500 (15/30) | **0.500** |
| 60 (Wave I6) | 0.500 (30/60) | 0.500 (30/60) | **0.500** |

Parity held at 0.50 after doubling the set. Per-type movement at 60:

| Type | Parity @30 | Parity @60 |
|------|:-:|:-:|
| `entity_reference` | 1.00 | 1.00 |
| `attribute_assertion` | 0.33 | 0.44 |
| `price_assertion` | 0.00 | 0.00 |
| `vintage_assertion` | 0.33 | 0.20 |
| `pairing_assertion` | 0.50 | 0.80 |
| `comparative_assertion` | 0.00 | 0.75 |
| `drinking_window_assertion` | 0.00 | 0.00 |
| `style_assertion` | 0.75 | 0.50 |
| `recommendation` | 0.00 | 0.00 |

The new path is authoritative on `price_assertion` / `vintage_assertion`
contradictions (it reads structured evidence); the legacy 5-class regex
extractor flatly emits `entailed` for any extracted numeric, so
contradiction claims produce systematic mismatches. This is the
expected failure mode — it is exactly the gap the 9-class router
was designed to close.

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
