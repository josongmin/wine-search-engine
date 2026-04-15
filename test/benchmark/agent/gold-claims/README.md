# Gold Claims — ADR-016 Axis 3

This directory hosts the **gold annotation set** for the grounded claim
emitter's shadow-parity harness.

## Files

| File | Purpose |
|------|---------|
| `schema.ts` | Zod schema for a single annotation row. |
| `gold-claims.jsonl` | JSON-lines annotations. **120 bootstrap rows (Wave D + Wave I6 + Wave J3); production cutover requires ≥200.** |
| `shadow-parity-proof.json` | Nightly-green proof file. Written by the harness; tracked under git so the extractor-deletion guard can read it. |

## Bootstrap annotation set (120 rows)

The bootstrap set is synthesised from well-known public wine facts over
the 8-wine evidence catalog (Opus One 2018, Sassicaia 2018, Penfolds
Grange 2017, Masi Amarone, Barolo Monfortino 2015, Moet Brut Imperial,
Chateau d'Yquem 2015, Cloudy Bay 2022). It is **not** the ADR-016 §2.8
cutover gate — that gate requires ≥200 human-annotated rows. Wave J3
takes the set to 120 (half-way to the gate); 80 more human-annotated
rows are still required before the production cutover can ship.

### Per-`AtomicClaimType` distribution (120 rows)

| Type | Wave D (30) | Wave I6 delta | Wave J3 delta | Total (120) |
|------|:-:|:-:|:-:|:-:|
| `entity_reference` | 8 | +6 | +8 | 22 |
| `attribute_assertion` | 3 | +6 | +8 | 17 |
| `price_assertion` | 4 | +4 | +6 | 14 |
| `vintage_assertion` | 6 | +4 | +8 | 18 |
| `pairing_assertion` | 2 | +3 | +8 | 13 |
| `comparative_assertion` | 1 | +3 | +6 | 10 |
| `drinking_window_assertion` | 1 | +2 | +4 | 7 |
| `style_assertion` | 4 | +2 | +8 | 14 |
| `recommendation` | 1 | +0 | +4 | 5 |
| **Total** | **30** | **+30** | **+60** | **120** |

### Verdict mix (Wave J3 delta, 60 new rows)

| Verdict | Count |
|---------|:-:|
| `entailed` | 25 |
| `partially_entailed` | 14 |
| `contradicted` | 17 |
| `not_entailed` | 4 |

### Shadow-parity measurement

Measured with `runShadowParity` over the canned-LLM bootstrap harness
(see `test/benchmark/evaluator/shadow-parity-harness.ts`):

| Set size | `statusOkSubset` | `fullSet` | Effective gate |
|----------|:-:|:-:|:-:|
| 30 (Wave D) | 0.500 (15/30) | 0.500 (15/30) | **0.500** |
| 60 (Wave I6) | 0.500 (30/60) | 0.500 (30/60) | **0.500** |
| 120 (Wave J3) | 0.467 (56/120) | 0.467 (56/120) | **0.467** |

Parity dipped slightly at 120 (0.500 → 0.467) as the J3 delta widens
the contradicted/not_entailed surface (Moet NV vintage claims,
white-wine-with-steak pairing mismatches, oyster/Sauvignon vs Opus
One contradictions). The legacy 5-class extractor bulk-emits
`entailed`, so contradictions are systematic legacy misses — exactly
the gap the 9-class router was designed to close. Per-type movement
at 120:

| Type | Parity @30 | Parity @60 | Parity @120 |
|------|:-:|:-:|:-:|
| `entity_reference` | 1.00 | 1.00 | 1.00 (22/22) |
| `attribute_assertion` | 0.33 | 0.44 | 0.53 (9/17) |
| `price_assertion` | 0.00 | 0.00 | 0.00 (0/14) |
| `vintage_assertion` | 0.33 | 0.20 | 0.28 (5/18) |
| `pairing_assertion` | 0.50 | 0.80 | 0.62 (8/13) |
| `comparative_assertion` | 0.00 | 0.75 | 0.60 (6/10) |
| `drinking_window_assertion` | 0.00 | 0.00 | 0.00 (0/7) |
| `style_assertion` | 0.75 | 0.50 | 0.21 (3/14) |
| `recommendation` | 0.00 | 0.00 | 0.60 (3/5) |

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
