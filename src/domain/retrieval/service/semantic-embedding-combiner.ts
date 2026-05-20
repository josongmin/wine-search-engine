import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';
import { globalSilentSkipCounter } from '../../../domain/observability/silent-skip-counters.js';

const log = bootstrapLogger.child({ component: 'SemanticEmbeddingCombiner' });

function isFiniteNumberVector(
  vec: readonly number[],
  expectedLength: number,
): { ok: true } | { ok: false; reason: 'dim_mismatch' | 'non_finite_element'; index?: number; value?: number } {
  if (vec.length !== expectedLength) {
    return { ok: false, reason: 'dim_mismatch' };
  }
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (v === undefined || !Number.isFinite(v)) {
      return { ok: false, reason: 'non_finite_element', index: i, value: v ?? NaN };
    }
  }
  return { ok: true };
}

/**
 * Combines N unit-norm embeddings into a single unit-norm vector.
 *
 * C1 (fail-loud) contract:
 *  - Input: N embeddings of the SAME length, all elements finite (no NaN,
 *    Infinity, hole, undefined). Single-embedding case returns the vector
 *    verbatim after validation.
 *  - If any embedding violates this contract, the combination is aborted
 *    and `undefined` is returned with a specific skip counter/log tag.
 *    The caller must treat this as "dense retrieval unavailable" and
 *    degrade sparse-only. NEVER substitute 0 for missing/corrupt elements —
 *    that silently warps the vector geometry.
 *  - Zero-norm output (all embeddings cancelled) also returns `undefined`
 *    with a distinct tag.
 */
export function combineSemanticEmbeddings(
  embeddings: readonly (readonly number[])[],
): readonly number[] | undefined {
  const first = embeddings[0];
  if (first === undefined) {
    return undefined;
  }
  if (first.length === 0) {
    globalSilentSkipCounter.increment('embedding_empty_vector', {
      position: 0,
      expected: 'non-empty',
    });
    return undefined;
  }

  // Validate the primary embedding. A corrupt primary means the combiner
  // cannot safely produce anything — fail-loud for dense retrieval.
  const firstCheck = isFiniteNumberVector(first, first.length);
  if (!firstCheck.ok) {
    log.warn(
      { reason: firstCheck.reason, index: firstCheck.index, value: firstCheck.value },
      'Primary embedding contains non-finite element(s) — aborting combination',
    );
    globalSilentSkipCounter.increment(
      firstCheck.reason === 'dim_mismatch'
        ? 'embedding_dim_mismatch'
        : 'embedding_non_finite_element',
      {
        embeddingCount: embeddings.length,
      },
    );
    return undefined;
  }

  if (embeddings.length === 1) {
    return first;
  }

  const combined = new Array<number>(first.length).fill(0);
  for (let e = 0; e < embeddings.length; e++) {
    const embedding = embeddings[e];
    if (embedding === undefined) {
      // Hole in the array — impossible under TS typing but defensive. Treat
      // as contract violation: fail the whole combination.
      log.warn(
        { position: e, embeddingCount: embeddings.length },
        'Hole detected in embeddings array — aborting combination',
      );
      globalSilentSkipCounter.increment('embedding_array_hole', { position: e });
      return undefined;
    }
    const check = isFiniteNumberVector(embedding, first.length);
    if (!check.ok) {
      // C1: a single corrupt embedding aborts the ENTIRE combination.
      // Skipping just this embedding and continuing would warp the combined
      // vector's geometry relative to what the caller expects.
      log.warn(
        {
          position: e,
          reason: check.reason,
          index: check.index,
          value: check.value,
          expectedDim: first.length,
          gotDim: embedding.length,
          embeddingCount: embeddings.length,
        },
        'Embedding contains non-finite element or dimension mismatch — aborting combination',
      );
      globalSilentSkipCounter.increment(
        check.reason === 'dim_mismatch'
          ? 'embedding_dim_mismatch'
          : 'embedding_non_finite_element',
        { position: e, embeddingCount: embeddings.length },
      );
      return undefined;
    }
    for (let i = 0; i < embedding.length; i++) {
      // All elements validated finite above. Direct addition is safe; no
      // nullish coalescing that could silently rescue a corrupt value.
      combined[i] = combined[i]! + embedding[i]!;
    }
  }

  const norm = Math.sqrt(combined.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    // Zero-norm means all embeddings cancelled out. Returning the first
    // vector unnormalized would produce a geometrically invalid query.
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
