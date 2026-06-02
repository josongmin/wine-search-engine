# Entity Lookup V2 — Live Shadow-Compare Result (2026-06-02)

> T-ELV2-08 live execution of `pnpm run eval:lookup-v2:shadow` against the real
> stack (RDS Postgres + self-hosted Vespa + OpenAI embeddings). Reproduce with
> the same command; report written to `/tmp/lookup-v2-shadow-report.json`.

## Gate outcome: **PASS**

| metric | V1 (`/v1/lookup/wine`) | V2 (`/v2/entity-lookup`) |
|---|---|---|
| rows | 15 | 15 |
| correct | 3 | **7** |
| wrong-positive | 0 | **0** |

- improvements (V1 wrong/miss → V2 correct): **5**
- regressions (V1 correct → V2 wrong/miss): 1
- concept-redirect accuracy: **1.000**
- `buildShadowReport().gate.pass`: **true** (wrong-positive ≤ V1, correct-rate within tolerance, concept-redirect ≥ floor)

## What the live decision traces confirmed

- **Calibration-trust gate fired live**: e.g. `Dom Perignon` resolver=resolved (C=0.828) → final **ambiguous** with rule `CALIBRATION_TRUST_GATE_DOWNGRADE` ("cannot resolve from a raw ranker score against a probability-space threshold"). Exactly the precision-first protection — a non-wrong-resolve under untrusted calibration.
- **Multi-vintage → ambiguous**: `Penfolds Grange` / `Sassicaia 2019` / `오퍼스원 2019` → `GAP_BELOW_THRESHOLD` (gap 0 < T_gap) → ambiguous, not a wrong single-vintage resolve.
- **Concept redirects 100%**: 까쇼 / Cabernet Sauvignon / full bodied red / Napa Valley / wine all redirect_discovery (never entered resolution).

## Honest environment caveats

This run proves the harness + gate end-to-end and shows V2 > V1, but the env was
not fully production-calibrated:

- **Calibration untrusted** — no fresh per-class calibration params in the active
  snapshot, so trusted-path resolves were conservatively downgraded. A
  production run with trained calibration would resolve more of the exact
  hot-entities outright (higher V2 `correct`).
- **Blocker returned 0 candidates** for all queries (blocker index not populated
  in this env); candidate recall came via alias anchors only. With the blocker
  index live, recall (and thus resolve rate) would be higher.

## Cutover status

The automated cutover gate (`buildShadowReport`) PASSES on the hotset. The
remaining prod gate before flipping authority off V1 is a **live-traffic canary**
(mirror real traffic to V2, confirm 0 wrong-positives) — see cutover-checklist.md.
