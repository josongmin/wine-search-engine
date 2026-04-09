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

export const FeaturesEnvSchema = z.object({
  /** Run evaluation on startup (fire-and-forget). */
  EVAL_RUN_AT_STARTUP: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),

  /** Explicit production opt-in for heuristic-only drinking-window prediction. */
  ALLOW_HEURISTIC_DRINKING_WINDOW: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  /** Optional directory containing `window_start.onnx` and `window_end.onnx`. */
  DRINKING_WINDOW_MODEL_DIR: z.string().min(1).optional(),

  // Watchlist webhook signing secret (Epic 17.1)
  WATCHLIST_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  WEBHOOK_SECRET: z.string().min(ENV_WEBHOOK_SECRET_MIN_LEN).optional(),

  /** Confidence refusal threshold for hallucination prevention (Epic 17.3).
   * When set (in range [0, 1]), enables confidence-based refusal in AdmissionGate.
   * Default: unset (confidence check disabled, backward compatible).
   * Recommended: 0.45 (AURC-calibrated operating point). */
  CONFIDENCE_REFUSAL_THRESHOLD: z.coerce.number().finite().min(0).max(1).optional(),
});
