import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../../observability/silent-skip-counters.js';

const log = bootstrapLogger.child({ component: 'SemanticEmbeddingCombiner' });

export function combineSemanticEmbeddings(
  embeddings: readonly (readonly number[])[],
): readonly number[] | undefined {
  const first = embeddings[0];
  if (first === undefined || first.length === 0) {
    if (first !== undefined && first.length === 0) {
      globalSilentSkipCounter.increment('embedding_empty_vector', {
        position: 0,
        expected: 'non-empty',
      });
    }
    return undefined;
  }
  if (embeddings.length === 1) {
    return first;
  }

  const combined = new Array<number>(first.length).fill(0);
  for (const embedding of embeddings) {
    if (embedding.length !== first.length) {
      log.warn(
        {
          expectedDim: first.length,
          gotDim: embedding.length,
          embeddingCount: embeddings.length,
        },
        'Skipping embedding with mismatched dimension during combination',
      );
      globalSilentSkipCounter.increment('embedding_dim_mismatch', {
        expected: first.length,
        got: embedding.length,
      });
      continue;
    }
    for (let i = 0; i < embedding.length; i++) {
      combined[i] = (combined[i] ?? 0) + (embedding[i] ?? 0);
    }
  }

  const norm = Math.sqrt(combined.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    // Zero-norm means all embeddings cancelled out or were all-zero.
    // Returning first (unnormalized) would produce a valid-length vector
    // that ANN interprets as a real query — yielding garbage results.
    // Returning undefined lets CandidatePool detect the failure and
    // degrade to sparse-only retrieval (which is the correct fallback).
    log.warn(
      {
        embeddingCount: embeddings.length,
        firstLength: first.length,
        norm,
      },
      'Embedding combination produced zero-norm vector — returning undefined for graceful degradation',
    );
    globalSilentSkipCounter.increment('embedding_zero_norm_combined', {
      embeddingCount: embeddings.length,
    });
    return undefined;
  }
  return combined.map((value) => value / norm);
}
