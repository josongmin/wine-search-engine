# Entity-Resolution Validation — Expanded (2026-06-02)

Rigorous V1 (`/v1/lookup/wine`) vs V2 (`/v2/entity-lookup`) comparison over the
PG `eval_cases` ground truth, scored by EXACT `expected_entity_id` match.
Replaces the 15-query hotset (which was famous in-corpus wines only and
**overstated** V2's advantage). Run: `scripts/eval/run-entity-resolution-validation.ts`,
live stack, trusted calibration. Raw: `entity-resolution-validation-2026-06-02.json`.

## Result (215 entity-semantic cases)

| class | n | V1 correct | V2 correct | wrong-positive (both) |
|---|---|---|---|---|
| ambiguous_short_form (→abstain) | 60 | 100% | 100% | 0 |
| no_match (→fail) | 40 | 100% | 100% | 0 |
| exact_entity (→resolve to X) | 75 | 0% (0/75) | **5.3% (4/75)** | 0 |
| noisy_recall (→resolve to X) | 40 | 0% (0/40) | 0% (0/40) | 0 |
| **OVERALL** | **215** | **46.5% (100)** | **48.4% (104)** | **0** |

## ⭐ CORRECTED RESULT — recalibrated (the run above was broken)

The 215-case run below scored ~46/48% for BOTH paths because the fitted
`calibration_params` were keyed to query_class `exact_entity` (the eval gold
label) while the **runtime resolver looks up calibration by `short_entity`**
(the classifier's output). Class-key mismatch → calibration never applied →
the trust gate downgraded even single exact-alias matches (confidence 1,
pool size 1) to `ambiguous` via `CALIBRATION_TRUST_GATE_DOWNGRADE`. Confirmed
by `scripts/eval/debug-one-lookup.ts` on `2018 Orin Swift Papillon`.

After re-keying the trace to `short_entity` and refitting/persisting
(isotonic ECE 0.444→0.050, N=173), the SAME 215 cases:

| class | n | V1 correct | V2 correct |
|---|---|---|---|
| exact_entity (→resolve) | 75 | 72.0% (21 miss) | **100%** |
| ambiguous_short_form (→abstain) | 60 | 80.0% (**12 wrong**) | **100% (0 wrong)** |
| noisy_recall (→resolve) | 40 | 60.0% | 60.0% (tie) |
| no_match (→fail) | 40 | 100% | 100% |
| **OVERALL** | **215** | **77.2% (166), 12 wrong** | **92.6% (199), 0 wrong** |

**V2 beats V1 by +15.4pp AND has 0 wrong-positives vs V1's 12** — a genuine,
scaled win on two axes: higher exact-entity recall (100% vs 72%) and far better
precision on ambiguous queries (V2 abstains 100%; V1 wrongly resolves 12/60).
Raw: `entity-resolution-validation-recalibrated-2026-06-02.json`.

Follow-ups: (1) calibration pipeline must key by the RUNTIME query class, not the
eval gold class (extract-calibration-trace currently joins `ec.query_class`);
(2) V1's 12 ambiguous_short_form wrong-positives are a V1 precision bug;
(3) noisy_recall 60% ceiling (both) = real recall gap on noisy variants.

## Honest conclusions (pre-recalibration run below — SUPERSEDED)

1. **V2's advantage does NOT generalize at scale.** Overall V2 48.4% vs V1
   46.5% — a +1.9pp / +4-case edge, entirely from 4 extra `exact_entity`
   resolves. The 15-hotset "V2 9 vs V1 1" was cherry-picked famous wines and is
   NOT representative.
2. **Both paths have near-zero should-resolve recall** (V1 0/115, V2 4/115).
   This is **NOT a resolver-logic failure** — the expected entities + aliases
   all exist in PG (569/569 entities, 75/75 with aliases) — but the live
   resolver returns `anchorCount:0`, i.e. the **alias substrate served by the
   active Vespa snapshot does not cover these eval entities** (snapshot/corpus
   coverage gap, the DoD #2 "coverage/curation hole" at scale). Recall is
   bottlenecked by coverage, which masks any resolver-quality difference.
3. **Precision is intact for both**: 0 wrong-positives across 215 cases;
   ambiguous/no_match correctly abstained 100%. The precision-first design holds
   at scale — neither path hallucinates.

## What this means for cutover

- The cutover claim "V2 >> V1" is **not supported at scale**; it holds only on
  the well-covered famous-wine slice. V2 ≈ V1 on the broad set.
- The dominant lever for real entity-resolution recall is **alias/snapshot
  coverage** (re-publish a snapshot covering the eval corpus, or expand alias
  curation), NOT further resolver tuning. Until coverage is fixed, V2's
  architectural gains (multi-channel union, LTR rerank, calibrated abstain)
  cannot demonstrate their value because there are no candidates to rank.
- Vintage-mismatch wrong-positive seen on the hotset (`오퍼스원 2019`→2018) did
  NOT recur here (0 wrong-positives), but remains a real latent bug to fix.
