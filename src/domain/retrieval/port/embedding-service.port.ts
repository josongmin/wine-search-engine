/**
 * Port (driven side) for generating text embeddings.
 *
 * Implementations may target OpenAI, BGE-M3, or any embedding model
 * that produces fixed-dimension dense vectors.
 */
export interface EmbeddingServicePort {
  /**
   * Generate an embedding vector for a single text input.
   *
   * @param text - The text to embed.
   * @returns A dense vector of floating-point numbers.
   */
  embed(text: string): Promise<readonly number[]>;

  /**
   * Generate embedding vectors for multiple texts in a single batch call.
   *
   * @param texts - The texts to embed.
   * @returns One embedding per input text, in the same order.
   */
  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}
