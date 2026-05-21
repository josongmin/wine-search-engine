# Runbook — AURC-derived per-class refusal threshold (P0.2)

This runbook covers operations for the per-class refusal threshold introduced
in P0.2. The runtime policy (`ConfidenceRefusalPolicy`) refuses low-confidence
decisions whose calibrated confidence `C` falls below the per-class τ derived
from the AURC (Area-Under-Risk-Coverage) curve.

References:

- Geifman & El-Yaniv 2017, "Selective Classification for Deep Neural
  Networks" — the SOTA selective-prediction operating-point selection used
  here.
- Migration `src/infrastructure/db/migrations/021_refusal_thresholds.sql`.
- Derivation core: `src/domain/calibration/service/refusal-threshold-derivation.ts`.
- CLI: `scripts/calibrate/derive-refusal-threshold.ts`.
- Runtime adapter: `src/infrastructure/adapter/pg-refusal-threshold-store.ts`.

## 1. What the AURC operating point means

The AURC curve plots the *risk* (error rate among admitted predictions)
against the *coverage* (fraction of predictions admitted) as the confidence
threshold τ sweeps from high to low. We pick τ at a chosen `target_coverage`
operating point so that the system admits exactly that fraction of
predictions with the minimum observed risk.

- **target_coverage = 0.85 (default)** — admit 85% of predictions; refuse
  the bottom 15% by calibrated confidence. This is a coverage-pinned
  selective-classifier (Geifman & El-Yaniv 2017 §3.2 variant).
- **Higher coverage** → smaller τ → fewer refusals → potentially higher
  observed risk. Use when business priority is recall.
- **Lower coverage** → larger τ → more refusals → lower observed risk. Use
  when business priority is precision / hallucination avoidance.

The per-class τ exists because producer queries, wine-name queries, and
generic browse queries each have different score distributions; a uniform
threshold over-refuses one class while under-refusing another.

## 2. Re-deriving thresholds

```bash
pnpm tsx scripts/calibrate/derive-refusal-threshold.ts \
    --target-coverage 0.85 \
    --report-dir data/refusal-threshold-reports
```

When to re-derive:

- **Nightly** — wired into `.github/workflows/nightly-tests.yml` (the
  `calibrate-refusal-threshold` job). The nightly cron is the canonical
  refresh cadence; manual runs are only required when chasing a regression.
- **After a calibrator change** — Platt/Isotonic refits invalidate the
  score distribution. Re-derive τ in the same change set.
- **After a routing change** — new query classes need their own τ rows.
- **When `dataset_hash` drifts** — see §4.

Idempotency: the CLI does a transactional `INSERT … ON CONFLICT (query_class)
DO UPDATE`, so re-runs are safe. The CLI refuses to persist if any class has
fewer than `MIN_SAMPLES_FOR_THRESHOLD = 200` samples (binomial 95% Wilson CI
half-width ≈ 3% at p = 0.05).

## 3. Operational env vars

| Variable | Default | Purpose |
|---|---|---|
| `REFUSAL_DERIVE_TARGET_COVERAGE` | `0.85` | CLI target coverage |
| `REFUSAL_DERIVE_MIN_SAMPLES_PER_CLASS` | `200` | CLI minimum-samples gate |
| `REFUSAL_THRESHOLD_TTL_SECONDS` | `300` | Runtime in-process cache TTL |
| `CONFIDENCE_REFUSAL_THRESHOLD` | unset | Force-uniform threshold escape hatch (ops use only) |

`CONFIDENCE_REFUSAL_THRESHOLD` survives as the documented force-uniform
override. It is **not** a fallback when the provider is unavailable — that
case explicitly degrades to `calibrationTrusted=false` (see §6).

## 4. `dataset_hash` drift

Every fit persists a `dataset_hash` over the `(queryClass, score, isCorrect)`
tuples that produced it. The hash is a sha-256 of the sorted tuples.

- **Hash unchanged across two runs** → no drift, no refit needed.
- **Hash changed** → distribution shifted. Inspect the new τ; if it moves
  significantly (>0.05) check whether the calibrator was retrained or the
  eval set was rebuilt.

Compare via:

```sql
SELECT query_class, threshold, dataset_hash, fitted_at
FROM refusal_thresholds
ORDER BY fitted_at DESC;
```

## 5. Choosing `target_coverage`

The default `0.85` is a starting point — operationalise it per release:

1. Run the derive CLI with `--dry-run` for several candidate coverages
   (0.80, 0.85, 0.90).
2. Compare the `risk_at_coverage` in the diagnostic report; pick the
   coverage that meets the product hallucination-rate target.
3. Persist with `--target-coverage <value>` and document the decision in
   the release notes.

For per-class overrides (e.g. wine-name queries warrant tighter coverage
than producer browse) split the run by class and merge reports manually —
the CLI fits all classes at the same target by design so the operating
point stays comparable.

## 6. Failure modes and observability

The runtime emits three counters from `silent-skip-counters`:

| Counter | Trigger | Action |
|---|---|---|
| `refusal_threshold_provider_unavailable` | Adapter cannot read `refusal_thresholds` (DB outage, table missing) | Restore DB. Until then the policy reports `calibrationTrusted=false` and the AdmissionGate skips the confidence check. |
| `refusal_threshold_class_fallback` | Request `query_class` not in the table; fell back to `general` | Add the missing class to the derive script's class-coverage suite. |
| `refusal_threshold_fallback_missing` | Neither exact class nor `general` exists | Re-run the derive CLI; the derive always synthesizes a `general` row. |

**Critical:** the policy never fabricates a hardcoded refusal threshold on
unavailability. Refusing every request during a DB outage would convert a
transient infra incident into a 100% refusal spike. The deliberate
degradation (skip the check, emit the counter, keep serving) is the
"no heuristic fallback" execution-baseline requirement.

## 7. Rollback

To disable the per-class lookup without rolling back the migration:

1. `UNSET REFUSAL_THRESHOLD_TTL_SECONDS` (not strictly required).
2. Truncate the table: `TRUNCATE refusal_thresholds;` — this puts the
   provider into `unavailable` state and the AdmissionGate skips the
   confidence check.
3. To re-enable the legacy global scalar instead, set
   `CONFIDENCE_REFUSAL_THRESHOLD=<value>`; the policy will use it as a
   legacy fallback (note: today it is only consulted if the provider is
   *not* wired; the truncation path is the cleanest disable).

To roll back the migration itself, follow the standard migration rollback
flow under `src/infrastructure/db/migrations/rollback/`.
