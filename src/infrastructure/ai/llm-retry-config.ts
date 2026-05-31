/**
 * SSoT for the shared LLM-adapter retry tuning.
 *
 * Every LLM HTTP adapter in `src/infrastructure/ai/` (OpenAI chat, Anthropic
 * chat, ChatGPT OAuth, OpenAI structured, …) retries transient failures with
 * the SAME backoff envelope — the only thing that differs per adapter is the
 * `label` used in error messages. Before this module those five identical
 * numeric tuples lived inline in each adapter and drifted silently when one
 * was tuned without the others (CLAUDE.md SSoT rule 30: cross-module constants).
 *
 * The `RetryConfig` TYPE remains owned by `../http/retry-with-backoff.ts`
 * (the retry primitive). This module owns only the LLM-adapter DEFAULT VALUES,
 * keeping the generic primitive free of provider-specific tuning.
 *
 * Tuning rationale (shared envelope):
 *   - maxAttempts 4: initial + 3 retries — survives a single transient
 *     5xx / connection reset / 429 burst without collapsing the call.
 *   - transientBackoff 250ms → 2s cap: fast retries for 5xx / network errors.
 *   - rateLimitBackoff 2s → 30s cap: slower regime for 429 so a TPM window
 *     has time to recover; floored by Retry-After when the server sends it.
 */

import type { RetryConfig } from '../http/retry-with-backoff.js';

/**
 * Shared LLM-adapter retry tuning WITHOUT a label. Each adapter spreads this
 * and overrides `label` via {@link withRetryLabel}. Frozen so a caller cannot
 * mutate the shared base and silently drift another adapter.
 */
export const DEFAULT_LLM_RETRY_CONFIG: Omit<RetryConfig, 'label'> = Object.freeze({
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
});

/**
 * Build a full {@link RetryConfig} from the shared LLM default plus a
 * provider-specific label (e.g. "OpenAI chat", "Anthropic chat").
 *
 * `overrides` lets an adapter that legitimately needs a different envelope
 * (e.g. a single-attempt key-pool fan-out) narrow one field without copying
 * the whole tuple — keeping the SSoT as the single base.
 */
export function withRetryLabel(
  label: string,
  overrides?: Partial<Omit<RetryConfig, 'label'>>,
): RetryConfig {
  return {
    ...DEFAULT_LLM_RETRY_CONFIG,
    ...overrides,
    label,
  };
}
