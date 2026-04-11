import { z } from 'zod';
import {
  EMBEDDING_TIMEOUT_MS,
  RERANKER_TIMEOUT_MS,
} from '../../infrastructure/vespa/per-channel-timeouts.js';

/**
 * Retrieval-side external services: embedding, Cohere reranker,
 * and the learned matcher. Grouped here because they all plug into the hybrid
 * retrieval/ranking pipeline rather than the generic LLM chat surface.
 *
 * SCAN4-08: env defaults are sourced from per-channel-timeouts.ts (SSoT) so
 * the in-process constant and the env-overridable default are always in sync.
 */

/** Cross-encoder blend: lower trusts external reranker less (domain default). */
const DEFAULT_RERANK_BLEND_SCALE = 0.7;
const DEFAULT_LEARNED_MATCHER_HTTP_TIMEOUT_MS = 30_000;
/** Maximum supported embedding vector size. text-embedding-3-large = 3072;
 *  add headroom for future models but prevent OOM from misconfigured values. */
const MAX_EMBEDDING_DIMENSION = 8192;

export const RetrievalEnvSchema = z.object({
  // Embedding Service
  // External embedding HTTP service (fallback when OpenAI embedding is not configured).
  // No default — if neither OPENAI_EMBEDDING_MODEL nor EMBEDDING_SERVICE_URL is set
  // and OPENAI_API_KEY is present, the system uses OpenAI embeddings. If neither key
  // nor URL is set, dense retrieval is disabled via the kill switch guard below.
  EMBEDDING_SERVICE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),
  /** Expected embedding vector dimension. When set, vectors with mismatched dimensions are rejected. */
  EMBEDDING_DIMENSION: z.coerce.number().int().positive().max(MAX_EMBEDDING_DIMENSION).optional(),
  /** Per-request HTTP timeout for embedding API calls (AbortSignal). */
  EMBEDDING_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(EMBEDDING_TIMEOUT_MS),

  /** Multiplies query-class rerank blend weights; lower = trust cross-encoder less (0–1). */
  RERANK_BLEND_SCALE: z.coerce.number().finite().min(0).max(1).default(DEFAULT_RERANK_BLEND_SCALE),
  /** Per-request HTTP timeout for Cohere reranker API calls (AbortSignal). */
  RERANKER_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(RERANKER_TIMEOUT_MS),

  // Cohere reranker (required for reranking)
  // z.preprocess: coerce "" → undefined so apiKey !== undefined checks skip Cohere when
  // COHERE_API_KEY is set to an empty string (same pattern as OPENAI_API_KEY / ANTHROPIC_API_KEY).
  COHERE_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  COHERE_RERANK_MODEL: z.string().min(1).default('rerank-v4.0-pro'),
  COHERE_BASE_URL: z.string().url().default('https://api.cohere.ai/v2'),

  // Learned Matcher Service (optional — omit to disable RFC-006 §5.2 ML blend)
  LEARNED_MATCHER_SERVICE_URL: z.string().url().optional(),
  /** Per-request HTTP timeout for learned matcher API calls (AbortSignal). */
  LEARNED_MATCHER_HTTP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_LEARNED_MATCHER_HTTP_TIMEOUT_MS),
});
