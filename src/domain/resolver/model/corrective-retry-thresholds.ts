/**
 * SSoT for the TA3-1 corrective-retry confidence threshold.
 *
 * Below this calibrated confidence C, a non-ambiguous, non-resolved result
 * triggers a corrective_retry recommendation. Imported by both:
 *   - `src/domain/resolver/service/resolver.ts` — emits the recommendation
 *   - `src/application/search/search-usecase-corrective-retry.ts` — consumes
 *     the recommendation and decides whether to actually retry
 *
 * At 0.5 we allow retry when the resolver is effectively uncertain — better
 * than the resolution threshold itself (usually 0.7) so we still catch
 * near-miss cases that may resolve correctly on a second pass.
 *
 * Rule 30 (CLAUDE.md): cross-module domain constants live in a single SSoT.
 */
export const CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD = 0.5;
