# Runbook — Nightly calibration auto-pipeline (P0.1)

This runbook covers the **nightly calibration auto-pipeline** that re-fits
the resolver calibrator from real eval traces and gates AdmissionGate's
hallucination guard (`ConfidenceRefusalPolicy`) on freshness.

The pipeline is the **load-bearing trust signal** for the hallucination
guard: when the pipeline is broken or stale, AdmissionGate intentionally
disables the refusal policy rather than gate-keep on unreliable
calibration. **A failed pipeline is not "fail safe" — it's "fail open"
relative to hallucination prevention**, so a failure must be triaged the
same day.

## Surfaces

| Artifact | Path |
|---|---|
| Trace extractor | `scripts/eval/extract-calibration-trace.ts` |
| Fit driver | `scripts/calibrate/fit-resolver-calibration.ts` |
| PG store + TTL gate | `src/infrastructure/adapter/pg-calibration-store.ts` |
| Calibrator + trust flag | `src/domain/resolver/service/calibrator.ts` |
| AdmissionGate trust check | `src/domain/decision/service/admission-gate.ts` |
| Migration adding columns | `src/infrastructure/db/migrations/021_calibration_pipeline.sql` |
| Workflow | `.github/workflows/calibration-nightly.yml` |
| Diagnostic reports | `data/calibration-reports/<timestamp>.json` |

## TTL semantics — what `CALIBRATION_TTL_DAYS` means

`CALIBRATION_TTL_DAYS` (default **14**, configurable via env) is the
maximum age in days that a row in `calibration_params` may have for
`AdmissionGate.confidenceRefusal` to be applied.

Trust is gated on **`fitted_at`**, not `trained_at`:

- `fitted_at IS NULL` → never trusted. Legacy rows pre-dating the
  auto-pipeline carry NULL so they can't masquerade as fresh.
- `now - fitted_at > CALIBRATION_TTL_DAYS days` → not trusted (stale).
- `now - fitted_at <= CALIBRATION_TTL_DAYS days` → trusted.

When trust is withheld, the calibrator still applies the *best-available*
stored calibration to the raw scores (so visible confidence values stay
in [0,1]), but `CalibratedResolutionScore.calibrationTrusted` is set to
`false`. The AdmissionGate then **skips** `ConfidenceRefusalPolicy`. The
display still shows a calibrated score; only the refusal decision is
disabled.

## Manual trigger

```sh
gh workflow run calibration-nightly.yml \
  -f since_days=14   # default 7
```

Or end-to-end locally against a dev database:

```sh
# 1) ensure migration 021 is applied
pnpm run migrate

# 2) populate eval_results (smoke replay or live offline eval)
pnpm run eval:offline:smoke

# 3) extract trace
pnpm run -s tsx scripts/eval/extract-calibration-trace.ts \
    --output data/calibration/trace-$(date -u +%Y%m%d).ndjson \
    --since 7 \
    --min-samples 100

# 4) fit + persist
pnpm run -s tsx scripts/calibrate/fit-resolver-calibration.ts \
    --input data/calibration/trace-$(date -u +%Y%m%d).ndjson \
    --report-dir data/calibration-reports
```

Confirm trust flipped to true:

```sql
SELECT query_class, method, fitted_at, sample_size,
       ROUND(EXTRACT(EPOCH FROM (now() - fitted_at)) / 86400.0, 1) AS age_days,
       ece
FROM calibration_params
ORDER BY fitted_at DESC NULLS LAST;
```

`age_days <= CALIBRATION_TTL_DAYS` for every row you expect to be live.

## Interpreting ECE drift

Each fit emits `data/calibration-reports/<timestamp>.json` with
`eceBefore` (raw score vs label) and `eceAfter` (calibrated score vs
label) per query class. Healthy ECE-after for the resolver is typically
**< 0.05**.

| `eceAfter` | Status | Action |
|---|---|---|
| < 0.03 | Excellent | None |
| 0.03–0.05 | Healthy | None |
| 0.05–0.10 | Degraded | Investigate `eval_results` distribution. Possible drift in `top1_raw_score` due to feature schema change. |
| > 0.10 | Broken | Stop the deploy. The calibrator cannot map raw → probability well enough to gate hallucinations; falling back to non-trusted state is safer than re-deploying. |

If `eceAfter > eceBefore`: the fitter regressed on the holdout. Most
common cause is a too-small per-class trace (`sample_size` < 200);
broaden `--since` or wait another night.

## When to invalidate

Manually invalidate a row when you know the calibration is *wrong* but
the TTL has not yet expired (e.g., post-hoc discovery of feature schema
drift, ETL bug that leaked corrupted scores into `top1_raw_score`,
post-mortem from a hallucination incident):

```sql
UPDATE calibration_params
   SET fitted_at = NULL   -- forces "never_fitted" → trust withheld
 WHERE query_class = 'short_entity';
```

After invalidation, re-trigger the workflow as soon as upstream data is
clean — the TTL gate will withhold trust until a new nightly fit lands.

## Failure modes & operator response

| Symptom | Likely cause | Response |
|---|---|---|
| `extract-trace` exits 1 with "insufficient samples" | Traffic too low for `--since 7d` | Widen `since_days` to 14 via workflow_dispatch; if still low, traffic problem, escalate |
| `fit-calibration` exits 1 with "insufficient class balance" | All-positive or all-negative subset | Likely a recent regression in `is_correct_resolve` labeling — check `eval_cases.expected_entity_id` for drift |
| `verify-trust` integration test fails post-fit | `fitted_at` row not visible / TTL too short / migration not applied | Confirm migration 021 applied; confirm `CALIBRATION_TTL_DAYS` >= 1 |
| ECE > 0.10 on a class | Calibrator can't map raw scores | Inspect `top1_raw_score` distribution; suspect ETL or scoring schema change |
| Auto-filed GitHub issue says "fittedAt unchanged" | Pipeline ran but persisted nothing | Likely `dry_run` flag set or DB credentials missing — check the workflow `Run the calibration trust integration check` logs |

## Audit invariants

The pipeline is correct when, after each nightly run:

1. `data/calibration-reports/` contains exactly one new JSON file with
   today's date.
2. Every `query_class` that had ≥ `MIN_TRACE_SAMPLES` × per-class
   threshold rows in the window has a fresh `fitted_at` within the
   last 24h.
3. The integration test `post-fit-trust.integration.test.ts` passes.
4. `select calibrationTrusted ...` on a sample lookup query returns
   `true` (visible via the `decisionTrace` in the `/v1/search/lookup`
   debug payload — see `.ai/debug-mode.md`).
