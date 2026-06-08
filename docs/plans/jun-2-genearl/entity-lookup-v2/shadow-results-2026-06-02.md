# Entity Lookup V2 — Live Shadow-Compare Result (2026-06-02)

> Historical analysis only.
> Current authority truth moved to `docs/bench/STATUS.md` and
> `tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml`.
> Any PASS claim in this file is sample-limited or superseded and must not be
> treated as the current cutover verdict or current public surface contract.

## UPDATE (2026-06-03) — FULL eval_cases distribution: gate FAILS on a PRE-EXISTING fuzzy wrong-positive

The 100-case (25/class) sample below PASSED, but the **full `eval_cases`
distribution (215 cases, no `--limit-per-class`, fingerprint `bd8abea5…`)** —
which the checklist names as the true cutover authority — **FAILS**:

| class | V1 | V2 |
|---|---|---|
| exact_entity (n=75) | 100% | 98.7% (miss 1: "2018 St. Supéry Élu") |
| noisy_recall (n=40) | 97.5% | **100%** |
| ambiguous_short_form (n=60) | 78.3%, **wrong=13** | **100%, wrong=0** |
| no_match (n=40) | 100% | 97.5%, **wrong=1** |
| **OVERALL (n=215)** | 93.5%, wrong=13 | **99.1%, wrong=1, miss=1** |

**verdict: FAIL** — sole reason: `no_match` V2 correct-rate 97.5% < V1 100% × 0.98
(one V2 wrong-positive).

- The blocker is **ONE pre-existing precision bug**, NOT a regression from this
  session's fixes: **"Viña Espectro Maipo Valley Carmenere"** (a Chilean wine not
  in corpus) **fuzzy-matches "2022 Viñas Mora kaamen III" at calibratedScore=1.0**
  via the `fuzzy_alias` channel and resolves. **Confirmed pre-existing** by
  running the query on the pre-fix commit (`62ee94c0`) — identical wrong-resolve.
  None of this session's changes (Korean romanization / producer-collision gate /
  vintage) touch this non-Korean, digit-free, non-collision query. Root issue: a
  fuzzy edit-distance match is being scored as identity-grade 1.0 (fuzzy
  confidence not discounted). **This is the real cutover blocker.**
- Secondary (within 2% tolerance, non-blocking): "2018 St. Supéry Élu" abstains
  via `producer_family_collision` even though the top is an EXACT cuvée match
  ("Élu") the family_graph siblings lack — a subtler false-collision (top has
  distinguishing identity the siblings don't); candidate follow-up.
- Net this session: V2 99.1% vs V1 93.5%; V2 wrong=1 vs V1 wrong=13. Large net
  precision+recall win, but **NOT cutover-clear** until the fuzzy_alias
  identity-grade-1.0 wrong-positive is fixed.

## UPDATE (2026-06-03, post-fix 526aeee8) — 25/class sample PASSES (non-authority)

> SUPERSEDED by the full-distribution run above. The 25/class sample missed the
> `no_match` fuzzy wrong-positive that only appears in the fuller no_match set.
> Kept for the per-class lift numbers.

After closing the last noisy_recall miss (`526aeee8` — 2-digit vintage shorthand
must not consume name-internal numbers), the authority scorer
(`run-entity-resolution-validation`, 25/class = 100 cases, same fingerprint
`bdad1bf1…`) reports **verdict: PASS (cutover-eligible)**:

| class (n=25) | V1 | V2 |
|---|---|---|
| exact_entity | 100% | 100% |
| noisy_recall | 100% | **100%** (was 92%) |
| ambiguous_short_form | 76%, wrong=6 | 100%, wrong=0 |
| no_match | 100% | 100% |
| **OVERALL (n=100)** | 94%, wrong=6 | **100%, wrong=0, miss=0** |

The vintage fix lives in the SHARED query normalizer, so V1 noisy_recall also
rose (→100%). V2 now dominates or ties every class with zero wrong-positives.

**Honest scope of this PASS:**
- This is the **25/class = 100-case** authority sample. The full `eval_cases`
  distribution run (no `--limit-per-class`) is the complete authority — see the
  full-distribution result below / artifact when available.
- Gate PASS = **cutover-ELIGIBLE** (may flip authority to V2, demote V1 to
  shadow). It is **NOT** "delete V1 now". Per §4, V1 PURGE still requires: cutover
  done → ≥1 release cycle V2-authority no-incident → V1 traffic = 0 telemetry.
- Dom Pérignon remains a DATA gap (entity not indexed); V2's abstain is correct.

## UPDATE (2026-06-02, post-fix d6eca27b/bc39d01b) — recall regression ROOT-CAUSED and largely closed

The "recall regression" below was diagnosed (adversarial 12-agent workflow + live
traces against RDS+Vespa) to be **three distinct causes**, two of which were real
code bugs now fixed and one of which is a data gap, NOT a V2 defect:

1. **Penfolds Grange (+ the whole exact_entity/noisy_recall classes) — REAL BUG, FIXED**
   (`bc39d01b`). After this session populated the `entity_family` graph, every exact
   query recalls same-producer siblings as **zero-signal recall seeds**
   (`canonicalNormalizedMatch=0`). `detectProducerFamilyCollision` counted them
   regardless of score → false `producer_family_collision` → mass false-abstain.
   Fix: count only score-competitive siblings (`>= STRONG_MATCH_RATIO` of top). The
   classifier is shared, so V1 improved too.

2. **돔페리뇽 — REAL BUG (SSoT drift), FIXED** (`d6eca27b`), but blocked by #3's data
   gap. The query-side transliteration had drifted from the Transliterator SSoT and
   produced no Latin identity surface for curated Korean exceptions, so the resolver's
   identity-key overlap gate zeroed every identity lane (V2-only; V1 has no such gate).
   Fix sources curated exact-key romanizations from the SSoT. 돔페리뇽 now reaches the
   same code path as the ASCII query — but cannot resolve because of #3.

3. **Dom Pérignon (ASCII + Korean) — DATA GAP, not a code bug.** There is **no
   "Dom Pérignon" wine entity in the corpus** (0 rows in `entities`/`aliases`/
   `canonical_*`). V1's "resolve" to `dom-perignon-2012` comes from a static
   seed/attribute alias catalog (an appellation-attribute label, not a recallable
   wine entity), i.e. a **curated illusion**. V2 honestly recalls real documents and
   correctly **abstains**. `dom perignon`/`페리뇽` is **not an expected-resolve case
   in the authority `eval_cases`** — so V2's abstain is the correct precision-first
   outcome, not a regression to fix in code. Closing it requires indexing the entity
   (ETL/data backfill), surfaced via the coverage report per RFC DoD §2.

### Authority eval after the fixes (`run-entity-resolution-validation`, 100 cases, family_graph populated, same eval_cases fingerprint `bdad1bf1…`)

| class | V2 BEFORE | V2 AFTER | V1 AFTER |
|---|---|---|---|
| exact_entity (n=25) | 36.0% | **100.0%** | 100.0% |
| noisy_recall (n=25) | 52.0% | **92.0%** | 96.0% |
| ambiguous_short_form (n=25) | 100.0% (0 wrong) | 100.0% (0 wrong) | 76.0% (6 wrong) |
| no_match (n=25) | 100.0% | 100.0% | 100.0% |
| **OVERALL (n=100)** | **72.0%, wrong=0** | **98.0%, wrong=0** | 93.0%, wrong=6 |

- **V2 wrong-positive = 0 throughout** (precision-first invariant held across the fix).
- The before/after split is a clean false-abstention signature: only the should-RESOLVE
  classes (exact_entity, noisy_recall) moved; the should-NOT-resolve classes were already
  100%/0-wrong in both runs (rules out infra flakiness).
- **Per-class gate still FAILS** on `noisy_recall` (V2 92% < V1 96% × 0.98). Both V2
  misses are **pre-existing ASCII long-noisy-label cases** ("2013 vineyard 29 …" — V1
  misses it too; "2017 bindi sergardi … 17" — V2 missed it in the BEFORE run as well),
  unaffected by these Korean-only + abstention-reducing changes. This is a separate,
  pre-existing V2 weakness on long trailing-noise labels — NOT introduced here, and NOT
  yet cutover-clearing.

**Net:** large recall recovery (V2 72%→98%) at zero precision cost; Penfolds resolves;
돔페리뇽 SSoT drift removed (resolves once the entity is indexed); the residual
noisy_recall gate-fail is pre-existing and out of scope for this recall-gap pass.

---

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
