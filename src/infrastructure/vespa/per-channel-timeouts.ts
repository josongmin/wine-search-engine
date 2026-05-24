/**
 * Per-channel HTTP timeout constants (E3-T5).
 *
 * Each retrieval channel has its own latency budget:
 * - Vespa search:           tight (3 s)   — must not block the hot retrieval path.
 * - Vespa bulk hydration:   looser (12 s) — N-document summary fetches with
 *                            `presentation.summary='full'` over 50-200 ids per
 *                            batch routinely exceed the hot-search ceiling on
 *                            Vespa Cloud. Sharing the search budget for both
 *                            channels caused `getDocuments: batch query failed`
 *                            on every popular-anchor scenario in the PtE bench
 *                            (timeout → entire batch dropped → 0/N hydration).
 * - Embedding:              looser (8 s)  — embedding model inference can be slow.
 * - Reranker:               loosest (10 s) — cross-encoder inference is expensive.
 *
 * These are exported so callers that construct clients (container-adapters.ts,
 * readiness.ts) and tests can import the same constant rather than re-declaring
 * magic numbers locally. See CLAUDE.md rule 30 (cross-module constant SSoT).
 */

/** Maximum wall-clock time for a Vespa search (/search/) HTTP request — hot path. */
export const VESPA_SEARCH_TIMEOUT_MS = 3_000;

/**
 * Default wall-clock time for a Vespa bulk-hydration request.
 *
 * 12 s tolerates Vespa Cloud's cold-summary tail on batches up to
 * {@link VESPA_BULK_HYDRATION_BATCH_SIZE_DEFAULT}. The 4x multiplier over
 * the hot-search timeout matches the empirical p95 latency ratio observed
 * in the bench audit (3 s hot vs ~9 s bulk full-summary).
 */
const VESPA_BULK_HYDRATION_TIMEOUT_MS_DEFAULT = 12_000;

/**
 * Maximum wall-clock time for a Vespa bulk-hydration request — batched
 * `entity_id in (...)` document fetches with `presentation.summary='full'`.
 *
 * Override via env when running on a snappier cluster:
 * `VESPA_BULK_HYDRATION_TIMEOUT_MS=8000`.
 */
export const VESPA_BULK_HYDRATION_TIMEOUT_MS = (() => {
  const raw = process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'];
  if (raw === undefined) return VESPA_BULK_HYDRATION_TIMEOUT_MS_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : VESPA_BULK_HYDRATION_TIMEOUT_MS_DEFAULT;
})();

/**
 * Default batch size for Vespa bulk-hydration calls (getDocuments /
 * batchFetchBySummary). Smaller batches keep the per-batch latency well
 * inside {@link VESPA_BULK_HYDRATION_TIMEOUT_MS} so a single timeout
 * doesn't drop the entire batch silently.
 */
const VESPA_BULK_HYDRATION_BATCH_SIZE_DEFAULT = 50;

/** Upper bound (env override is clamped here) — keeps headroom even on
 *  unusually slow clusters where the operator wants to dial down latency
 *  at the cost of more round-trips. */
const VESPA_BULK_HYDRATION_BATCH_SIZE_MAX = 200;

/**
 * Effective batch size honoured by the bulk-fetch helpers. Override via env:
 *   `VESPA_BULK_HYDRATION_BATCH_SIZE=N` (1..200).
 */
export const VESPA_BULK_HYDRATION_BATCH_SIZE = (() => {
  const raw = process.env['VESPA_BULK_HYDRATION_BATCH_SIZE'];
  if (raw === undefined) return VESPA_BULK_HYDRATION_BATCH_SIZE_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed)
    && parsed > 0
    && parsed <= VESPA_BULK_HYDRATION_BATCH_SIZE_MAX
    ? parsed
    : VESPA_BULK_HYDRATION_BATCH_SIZE_DEFAULT;
})();

/** Maximum wall-clock time for an embedding API HTTP request. */
export const EMBEDDING_TIMEOUT_MS = 8_000;

/** Maximum wall-clock time for a reranker API HTTP request. */
export const RERANKER_TIMEOUT_MS = 10_000;
