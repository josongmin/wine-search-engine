# Entity Lookup V2 — Live Shadow-Compare Result (2026-06-02)

## Precision-first gate PASS — but a REAL recall regression (15-row smoke, 2026-06-02, gitSha 9a236030)

`pnpm run eval:lookup-v2:shadow` against the live stack with the CURRENT 4-gate
`buildShadowReport` (incl. Gate 4 non-degeneracy) AND the vintage-mismatch guard.
Artifact: `evidence/shadow-report-2026-06-02-postfix.json` (stamped generatedAt + gitSha).

| metric | V1 (`/v1/lookup/wine`) | V2 (`/v2/entity-lookup`) |
|---|---|---|
| rows | 15 | 15 |
| **correct** (incl. correct-abstentions) | 5 | **9** |
| wrong-positive | **1** | **0** |
| **hot-entity RESOLVES (of 7 expected-resolve)** | **5** | **2** |
| abstainRate | 0.600 | **0.867** |

**Read this honestly — the PASS is precision, NOT resolution superiority:**
- The cutover gate is PRECISION-FIRST and it PASSES: V2 wrong-positive=0 (vs V1's 1),
  concept-redirect 1.000, non-degenerate. The vintage wrong-positive (`오퍼스원 2019`
  → Opus One 2018) is closed.
- BUT V2's `correct=9` is mostly **correct-ABSTENTIONS** on the 8 non-resolve rows. On the
  7 expected-resolve rows V2 RESOLVES ONLY **2** (Opus One ×2) vs V1's **5** — V2 abstains
  on **Dom Pérignon, 돔페리뇽, Penfolds Grange** where V1 resolved. This is a **recall
  regression**: V2 trades recall for precision. NOT "9× superiority".
- So the gate PASS means "safe to cut over on PRECISION grounds (no new wrong-resolves)",
  it does **not** mean V2 finds more wines. The recall gap (curation / family-graph
  population / alias coverage for famous wines) is an open pre-cutover consideration.

**This 15-row hotset is a SMOKE check, not the cutover authority.** The full eval_cases
distribution (`run-entity-resolution-validation.ts`) is the authority for the
resolution-quality call. Do NOT flip authority on this run alone.

---

## ~~UPDATE — trusted-calibration re-run (2026-06-02 PM)~~ — SUPERSEDED

> SUPERSEDED by the smoke run above. This run FAILED the gate on the vintage
> wrong-positive (now fixed) and its "V2 9 vs V1 1" / "9× superiority" framing is a
> DIFFERENT run from the committed PASS artifact — do not cite it. Kept for history.

After closing the calibration capture loop (top1_raw_score now plumbed through
resolver + ranked-route → eval_results), running a live 500-case eval to
generate 374 labeled (rawScore, isCorrect) samples, and fitting + persisting
`calibration_params` to prod (exact_entity: isotonic ECE 0.334→0.181 N=125;
unknown: isotonic ECE 0.326→0.011 N=80), the shadow was re-run with the live PG
pool injected into the container (blocker + calibration store active).

| metric | V1 (`/v1/lookup/wine`) | V2 (`/v2/entity-lookup`) |
|---|---|---|
| rows | 15 | 15 |
| correct | **1** | **9** |
| wrong-positive | 0 | **1** |

- improvements: **9**, regressions: 1, concept-redirect accuracy: **1.000**.
- **Entity-resolution superiority PROVEN**: V2 resolves 9× more hotset entities
  than V1 under trusted calibration on the live stack. DoD met: `opu one`→
  ambiguous, `까쇼`/`Cabernet Sauvignon`/`full bodied red`/`Napa Valley`/`wine`
  →redirect_discovery (100%), `Opus One`(EN+KO)/`Penfolds Grange`→resolved,
  `a`→failed.
- **Cutover gate: FAIL** — one wrong-positive (6.7%) where V1 had none:
  `elv2-015 오퍼스원 2019` → resolved to **Opus One 2018** (VINTAGE MISMATCH;
  expected ambiguous/multi-vintage). Single remaining blocker before flipping
  authority off V1: vintage-aware admission must downgrade a resolve whose
  entity vintage ≠ the query's explicit vintage token.
- 4 safe misses (recall/curation gaps, NOT wrong): `Dom Perignon` (EN+KO),
  `Sassicaia 2019`, `Caymus Cabernet Sauvignon` — abstain rather than mis-resolve.

Report: `shadow-report-trusted-2026-06-02.json`.

---

> ⚠️ **NOT CUTOVER-ELIGIBLE — pre-Gate-4, degraded substrate (self-review C2).**
> This run was scored by the THREE-gate `buildShadowReport` that existed at the
> time (commit 77bfe578); the **non-degeneracy Gate 4** (commit ff60531a) did
> NOT exist yet and the run was never re-scored under it. The trace below shows a
> DEGRADED substrate — the blocker returned 0 candidates for every query and every
> expected-resolve exemplar (Dom Pérignon, Penfolds Grange, Sassicaia 2019, 오퍼스원)
> was downgraded to ambiguous — i.e. V2 likely resolved **0** expected-resolve hot
> entities. Under current Gate 4 (V2-resolved-floor) this run would **FAIL**. The
> "correct=7" below is achieved off the 8 non-resolve rows (failed/redirect), NOT
> off hot-entity resolution. The raw `/tmp/lookup-v2-shadow-report.json` was not
> committed and is gone, so these numbers are not independently auditable.
>
> **Required before cutover:** re-run `pnpm run eval:lookup-v2:shadow` on a
> properly-populated stack (blocker index loaded) with current Gate-4 code, and
> commit the stamped raw artifact (now emits generatedAt + gitSha). Treat the
> PASS below as historical/unverified only.

> T-ELV2-08 live execution of `pnpm run eval:lookup-v2:shadow` against the real
> stack (RDS Postgres + self-hosted Vespa + OpenAI embeddings). Reproduce with
> the same command; report written to `/tmp/lookup-v2-shadow-report.json`.

## Gate outcome (pre-Gate-4, unverified): PASS

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
