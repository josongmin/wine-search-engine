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

## Honest conclusions

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
