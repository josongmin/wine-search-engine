import type {
  SpladeEncoderPort,
  SpladeQueryWeights,
} from '../../domain/retrieval/port/splade-encoder.port.js';

/**
 * Stub SPLADE encoder — falls back to BM25-style term weighting.
 *
 * Used until a real SPLADE model server is wired in (Phase B).
 *
 * The stub tokenizes the query and assigns equal weight (1.0) to each
 * term, producing a degenerate "all 1s" sparse vector. This lets the
 * `learned_sparse` retrieval channel run end-to-end during integration
 * testing without requiring a model server. It is intentionally a
 * degenerate fallback — the goal is to keep the pipeline alive, not to
 * produce useful sparse expansion.
 *
 * When tokens repeat, the last occurrence wins (still weight 1.0) so the
 * output is de-duplicated by token — `dotProduct` against the index
 * expects unique token keys.
 */

// Split on any run of non-alphanumeric (Unicode-aware) characters. We
// intentionally keep this simple and ASCII-biased for the stub; a real
// SPLADE adapter will tokenize via the model's own WordPiece vocabulary.
const TOKEN_SPLIT_REGEX = /[^\p{L}\p{N}]+/u;

/** Drop 1-character tokens — single letters add noise without recall benefit
 *  in BM25/SPLADE-style sparse retrieval. Aligned with the project's other
 *  tokenizers (query-normalizer, sparse hit pipeline) which use the same floor. */
const MIN_TOKEN_LENGTH = 2;
/** Equal weight per surviving token — this is the degenerate "BM25 fallback"
 *  shape, NOT a learned SPLADE distribution. The real SPLADE encoder will
 *  emit per-token weights from the trained model; this stub keeps the wire
 *  contract alive without faking learned recall. */
const STUB_TOKEN_WEIGHT = 1.0;

export class StubSpladeEncoder implements SpladeEncoderPort {
  readonly typicalActiveTokens = 8;
  readonly modelId = 'stub-bm25-fallback';

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy port; stub has no I/O
  async encode(query: string): Promise<readonly SpladeQueryWeights[]> {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const seen = new Map<string, number>();
    for (const raw of query.split(TOKEN_SPLIT_REGEX)) {
      if (raw.length < MIN_TOKEN_LENGTH) continue;
      const token = raw.toLowerCase();
      if (token.length < MIN_TOKEN_LENGTH) continue;
      if (!Number.isFinite(STUB_TOKEN_WEIGHT)) continue;
      seen.set(token, STUB_TOKEN_WEIGHT);
    }

    const out: SpladeQueryWeights[] = [];
    for (const [token, weight] of seen) {
      out.push({ token, weight });
    }
    return out;
  }
}
