import type { QueryClass } from '../../shared/types/index.js';
import type { RankingInput } from '../model/ranking-input.js';
import type { RankerRuntimeSignal } from '../model/ranking-runtime-signal.js';
import type { RerankerPort, RerankCandidate } from '../port/reranker.port.js';
import { effectiveRerankBlendWeight } from './rerank-blend.js';
import {
  type ScoredEntry,
  buildWineText,
  compareScoredEntriesByFinalScoreDesc,
} from './ranker-scored-entry.js';

/**
 * Treat reranker batch as degenerate when max-min below this and keep the
 * heuristic score instead of fabricating a midpoint blend.
 * Logit-scale scores can differ by ~1e-7 from floating-point noise; 1e-8 was
 * overly tight and collapsed distinct candidates into the degraded path.
 */
const RERANK_SCORE_MIN_MAX_RANGE_EPSILON = 1e-6;
/** Degradation reason emitted when rerank scores cannot be normalized safely. */
const RERANK_SCORE_NORMALIZATION_FAILED_REASON = 'reranker_score_normalization_failed';
/** Degradation reason emitted when the blend weight is not finite. */
const RERANK_BLEND_WEIGHT_INVALID_REASON = 'reranker_blend_weight_invalid';

/**
 * Applies cross-encoder reranking to the top-K candidates.
 *
 * Candidates beyond top-K retain their original order appended after
 * the reranked set.  The final score blends the cross-encoder score with
 * the original aggregated score using a query-class-aware weight
 * (RFC-017 §5.3) rather than a hardcoded ratio.
 */
export async function applyCrossEncoderReranking(
  deps: {
    readonly reranker: RerankerPort | undefined;
    readonly rerankBlendScale: number;
  },
  query: string,
  viable: readonly ScoredEntry[],
  queryClass: QueryClass,
  topKLimit: number,
  stageTimer?: NonNullable<RankingInput['requestContext']>['stageTimer'],
): Promise<{
  readonly results: readonly ScoredEntry[];
  readonly runtimeSignal?: RankerRuntimeSignal | undefined;
  /** True when normalization failed for ALL top-K candidates (collapsed/NaN batch). */
  readonly normalizationFailed?: boolean | undefined;
}> {
  const topK = viable.slice(0, topKLimit);
  const rest = viable.slice(topKLimit);
  const degradationReasons: string[] = [];

  // Build wine-aware passage text for the cross-encoder (RFC-017 §5.2).
  const rerankCandidates: RerankCandidate[] = topK.map((entry) => ({
    entityId: entry.entityId,
    text: buildWineText(entry),
  }));

  const reranker = deps.reranker;
  if (reranker === undefined) {
    throw new Error('applyReranking requires reranker');
  }
  stageTimer?.start('ranking.cross_encoder.remote');
  const rerankResults = await reranker.rerank(
    query,
    rerankCandidates,
    topKLimit,
  );
  stageTimer?.end('ranking.cross_encoder.remote');

  stageTimer?.start('ranking.cross_encoder.postprocess');
  try {
    // Build lookups
    const rerankScoreMap = new Map(
      rerankResults.map((r) => [String(r.entityId), r.score]),
    );
    const entryMap = new Map(
      topK.map((entry) => [String(entry.entityId), entry]),
    );

  // Normalise reranker scores to [0, 1] before blending.
  // Cross-encoder logits (e.g. BGE-reranker) are typically in [-10, +15];
  // min-max within the batch preserves relative ordering while keeping the
  // scale compatible with the original aggregated score (also [0, 1]).
  // Non-finite or collapsed score batches are treated as a degraded rerank:
  // we keep the heuristic score instead of fabricating a midpoint.
  let minRaw = Infinity;
  let maxRaw = -Infinity;
  for (const r of rerankResults) {
    if (!Number.isFinite(r.score)) continue;
    if (r.score < minRaw) minRaw = r.score;
    if (r.score > maxRaw) maxRaw = r.score;
  }
  const rawRange = Number.isFinite(minRaw) && Number.isFinite(maxRaw)
    ? maxRaw - minRaw
    : NaN;

  function normalizeRerankScore(raw: number, originalScore: number): number {
    if (
      !Number.isFinite(raw)
      || !Number.isFinite(rawRange)
      || rawRange < RERANK_SCORE_MIN_MAX_RANGE_EPSILON
    ) {
      if (!degradationReasons.includes(RERANK_SCORE_NORMALIZATION_FAILED_REASON)) {
        degradationReasons.push(RERANK_SCORE_NORMALIZATION_FAILED_REASON);
      }
      return originalScore;
    }
    // Min-max within batch: maps to [0, 1] preserving relative order.
    // Sigmoid compression is unnecessary when min-max already bounds the range.
    return (raw - minRaw) / rawRange;
  }

  // T-E6-02: Detect batch-level normalization failure BEFORE per-candidate loop.
  // When rawRange is NaN or below epsilon, normalizeRerankScore returns
  // originalScore for every candidate — the rerank has zero effect but
  // previously reported applied=true. Surface this as normalizationFailed
  // so the caller can set the correct RerankDecision.
  const batchNormalizationFailed =
    !Number.isFinite(rawRange) || rawRange < RERANK_SCORE_MIN_MAX_RANGE_EPSILON;

  // Reorder top-K by rerank score, blending with original score
  const rerankedTopK: ScoredEntry[] = [];

  for (const r of rerankResults) {
    const original = entryMap.get(String(r.entityId));
    if (original === undefined) {
      continue;
    }
    // Blend: query-class weight × optional global scale (RFC-017 §5.3)
    const rawW = effectiveRerankBlendWeight(queryClass, deps.rerankBlendScale);
    // Guard against NaN/Infinity from a misconfigured rerankBlendScale (e.g. NaN env var).
    // A non-finite blend weight is a configuration failure, so fall back to
    // the heuristic score path instead of fabricating a midpoint blend.
    const w = Number.isFinite(rawW) ? rawW : 0;
    if (!Number.isFinite(rawW) && !degradationReasons.includes(RERANK_BLEND_WEIGHT_INVALID_REASON)) {
      degradationReasons.push(RERANK_BLEND_WEIGHT_INVALID_REASON);
    }
    const normScore = normalizeRerankScore(r.score, original.finalScore);
    const blendedScore = w * normScore + (1 - w) * original.finalScore;
    rerankedTopK.push({
      ...original,
      finalScore: blendedScore,
    });
  }

  // Add any topK entries that the reranker dropped
  for (const entry of topK) {
    if (!rerankScoreMap.has(String(entry.entityId))) {
      rerankedTopK.push(entry);
    }
  }

  // Sort the entire combined set (top-K reranked + rest) by finalScore.
  // Previous code concatenated `[...rerankedTopK, ...rest]` which preserved
  // top-K position even when a rest candidate's original score now exceeded
  // a blended top-K score — producing rank inversions across the boundary.
  // Re-sorting fixes this and applies the same NaN-safe tie-break as the
  // primary sort.
  // Use .concat() instead of spread — rest can be thousands of entries and
  // spread pushes all elements onto the call stack (crashes at ~65K; Rule 9).
    const combined = rerankedTopK.concat(rest);
    combined.sort(compareScoredEntriesByFinalScoreDesc);
    return {
      results: combined,
      ...(batchNormalizationFailed ? { normalizationFailed: true } : {}),
      ...(degradationReasons.length > 0
        ? {
            runtimeSignal: {
              rerankerStatus: 'executed',
              degradation: {
                executionMode: 'degraded',
                degradationReasons,
              },
            } as RankerRuntimeSignal,
          }
        : {}),
    };
  } finally {
    stageTimer?.end('ranking.cross_encoder.postprocess');
  }
}
