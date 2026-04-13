/**
 * SSoT for embedding model configuration.
 *
 * Every component that produces or consumes embeddings MUST import these
 * constants rather than hardcoding model names or dimensions:
 *   - `OpenAiEmbeddingService` (runtime query embedding)
 *   - `scripts/etl/index-to-vespa.ts` (ETL document embedding)
 *   - Vespa schema `wine_entity.sd` (tensor declaration — verified by parity test)
 *   - `EMBEDDING_DIMENSION` env var default
 *
 * Changing the model or dimension here propagates everywhere; a mismatch
 * between document and query embeddings silently degrades semantic search.
 */

/** OpenAI embedding model used for both document and query embeddings. */
export const EMBEDDING_MODEL = 'text-embedding-3-small' as const;

/**
 * Output dimensionality passed to the OpenAI embeddings API `dimensions`
 * parameter. Must match the Vespa schema tensor declaration
 * `tensor<float>(x[EMBEDDING_DIMENSION])`.
 *
 * text-embedding-3-small natively produces 1536 dims but supports
 * truncation; 1024 balances quality vs. index size + latency.
 */
export const EMBEDDING_DIMENSION = 1024;
