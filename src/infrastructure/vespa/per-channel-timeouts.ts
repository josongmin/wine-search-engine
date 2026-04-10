/**
 * Per-channel HTTP timeout constants (E3-T5).
 *
 * Each retrieval channel has its own latency budget:
 * - Vespa search: tight (3 s) — must not block the hot retrieval path.
 * - Embedding: looser (8 s) — embedding model inference can be slow.
 * - Reranker: loosest (10 s) — cross-encoder inference is expensive.
 *
 * These are exported so callers that construct clients (container-adapters.ts,
 * readiness.ts) and tests can import the same constant rather than re-declaring
 * magic numbers locally. See CLAUDE.md rule 30 (cross-module constant SSoT).
 */

/** Maximum wall-clock time for a Vespa search (/search/) HTTP request. */
export const VESPA_SEARCH_TIMEOUT_MS = 3_000;

/** Maximum wall-clock time for an embedding API HTTP request. */
export const EMBEDDING_TIMEOUT_MS = 8_000;

/** Maximum wall-clock time for a reranker API HTTP request. */
export const RERANKER_TIMEOUT_MS = 10_000;
