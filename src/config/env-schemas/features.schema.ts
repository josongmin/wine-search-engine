import { z } from 'zod';

/**
 * Feature-area settings that do not belong to a single infrastructure
 * provider: startup-eval toggle, drinking-window model policy, watchlist
 * webhooks, and the hallucination-refusal threshold.
 *
 * EVAL_RUN_AT_STARTUP lives here (rather than a dedicated eval domain)
 * because it is the only eval-runtime env var today and its companions
 * (drinking window, watchlist) are similarly single-flag feature gates.
 */

/** Webhook HMAC secret minimum length (watchlist delivery signing). */
const ENV_WEBHOOK_SECRET_MIN_LEN = 16;

/**
 * Default confidence-refusal threshold (Epic 17.3 AURC-calibrated operating
 * point). Refusal recall ≥ 0.90 / false-refusal rate ≤ 0.05 on the
 * wrong_top1 eval slice that motivates the policy.
 */
const DEFAULT_CONFIDENCE_REFUSAL_THRESHOLD = 0.45;

/** Default TTL (days) for trusting nightly-fitted calibration parameters.
 *  Matches `DEFAULT_CALIBRATION_TTL_DAYS` in the resolver Calibrator and
 *  the operator-facing runbook (`docs/runbook-calibration-nightly.md`). */
const CALIBRATION_TTL_DEFAULT_DAYS = 14;
/** Upper bound on the operator-configurable TTL. Picked to be wider than
 *  any sensible production value (one year) so an operator cannot
 *  accidentally configure "never expire" while still receiving lint
 *  failures on raw literals further down the config tree. */
const CALIBRATION_TTL_MAX_DAYS = 365;

export const FeaturesEnvSchema = z.object({
  /** Run evaluation on startup (fire-and-forget). */
  EVAL_RUN_AT_STARTUP: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),

  /** Optional ONNX override directory containing `window_start.onnx` and `window_end.onnx`. */
  DRINKING_WINDOW_MODEL_DIR: z.string().min(1).optional(),

  // Watchlist webhook signing secret (Epic 17.1)
  WATCHLIST_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  WEBHOOK_SECRET: z.string().min(ENV_WEBHOOK_SECRET_MIN_LEN).optional(),

  /** Confidence refusal threshold for hallucination prevention (Epic 17.3).
   * The AdmissionGate refuses resolved decisions whose calibrated
   * confidence C falls below this floor.
   * Default: 0.45 (AURC-calibrated operating point — refusal recall ≥ 0.90,
   * false-refusal rate ≤ 0.05 against the wrong_top1 eval slice).
   * Set to 0 to allow any positive-confidence decision (NaN is still refused
   * — the hallucination guard treats non-finite C as zero confidence).
   */
  CONFIDENCE_REFUSAL_THRESHOLD: z
    .coerce.number()
    .finite()
    .min(0)
    .max(1)
    .default(DEFAULT_CONFIDENCE_REFUSAL_THRESHOLD),

  /** P0.1: TTL (in days) for trusting nightly-fitted calibration parameters.
   * When `calibration_params.fitted_at` is older than this many days,
   * Calibrator emits `calibrationTrusted: false` and AdmissionGate skips the
   * confidence-refusal policy (the hallucination guard auto-disables rather
   * than gate-keep on stale calibration). Default 14 days (see
   * CALIBRATION_TTL_DEFAULT_DAYS) — bounded above by
   * CALIBRATION_TTL_MAX_DAYS so "never expire" is unreachable. */
  CALIBRATION_TTL_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(CALIBRATION_TTL_MAX_DAYS)
    .default(CALIBRATION_TTL_DEFAULT_DAYS),

  /** Optional path to a runtime LTR model file for PG-less / bootstrap startup.
   * When unset, learned LTR is skipped unless registry data is available from PG.
   */
  RUNTIME_LTR_MODELS_PATH: z.string().min(1).optional(),
});
