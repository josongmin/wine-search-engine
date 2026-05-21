/**
 * LTR-powered ranking service for production inference.
 *
 * Uses learned ranking models to rerank search results.
 */

import type { QueryClass } from '../../shared/types/index.js';
import { clamp } from '../../shared/utils/clamp.js';
import { compareScoreDescending } from '../../shared/utils/stable-comparator.js';
import type { RankingFeatures, QueryClassWeights } from './lambdamart-ranker.js';
import { scoreDocument } from './lambdamart-ranker.js';

/**
 * Default retrieval↔LTR blend weight when the caller does not supply one.
 * 0.5 = equal trust in fusion retrieval score and learned LTR score; the
 * neutral midpoint avoids biasing toward either signal before tuning.
 * Named per CLAUDE.md rule 15 (multiplier/weight constants must be named).
 */
const BLEND_ALPHA_DEFAULT = 0.5;
/** Blend weight is a convex mixing coefficient — must stay within [0, 1]. */
const BLEND_ALPHA_MIN = 0;
const BLEND_ALPHA_MAX = 1;
/**
 * Below this many candidates the saturation guard is a no-op: a single
 * candidate has no ordering to lose, so an identical-score "collapse" is
 * not a degeneracy worth falling back for.
 */
const SATURATION_MIN_CANDIDATES = 2;
/** A score column is saturated when it carries this many distinct values. */
const SATURATION_UNIQUE_THRESHOLD = 1;

/**
 * A searchable document to be ranked.
 */
interface RankableDocument {
  readonly entityId: string;
  readonly retrievalScore: number;
  readonly features: RankingFeatures;
  readonly originalRank: number;
}

/**
 * Result after LTR ranking.
 */
interface RankedDocument extends RankableDocument {
  readonly ltrScore: number;
  readonly finalRank: number;
}

interface LtrRerankResult {
  readonly documents: readonly RankedDocument[];
  /** True when LTR scores were saturated (all identical) and the ranker
   *  fell back to heuristic retrieval scores. Downstream should treat
   *  this as ltrAvailable=false for entropy gate purposes. */
  readonly saturated: boolean;
}

/**
 * LTR Ranker: applies learned models to rerank documents.
 */
function rerank(
  documents: readonly RankableDocument[],
  _queryClass: QueryClass,
  model?: QueryClassWeights,
): LtrRerankResult {
  if (!model) {
    return {
      documents: documents.map((doc, idx) => ({
        ...doc,
        ltrScore: doc.retrievalScore,
        finalRank: idx + 1,
      })),
      saturated: false,
    };
  }

  const scored = documents.map((doc) => ({
    ...doc,
    ltrScore: scoreDocument(doc.features, model),
  }));

  // Saturation guard: if all LTR scores clamp to the same value (e.g. 1.0
  // when untrained initial weights push raw score > 1 for every candidate),
  // entropy is 1.0 and the resolver cannot distinguish candidates. Fall back
  // to heuristic retrieval scores which at least preserve fusion rank order.
  const uniqueScores = new Set(scored.map((d) => d.ltrScore));
  if (
    uniqueScores.size <= SATURATION_UNIQUE_THRESHOLD &&
    scored.length >= SATURATION_MIN_CANDIDATES
  ) {
    return {
      documents: documents.map((doc, idx) => ({
        ...doc,
        ltrScore: doc.retrievalScore,
        finalRank: idx + 1,
      })),
      saturated: true,
    };
  }

  // Deterministic ordering via the SSoT comparator (NaN→-Infinity, stable):
  //   1) ltrScore descending
  //   2) retrievalScore descending (tie-break on equal learned score)
  //   3) entityId ascending (final lexicographic tie-break so two candidates
  //      with identical ltrScore AND retrievalScore can never resolve by
  //      input/iteration order — see @shared/utils/stable-comparator).
  const sorted = [...scored].sort((a, b) => {
    const byLtr = compareScoreDescending(a.ltrScore, b.ltrScore);
    if (byLtr !== 0) return byLtr;
    const byRetrieval = compareScoreDescending(a.retrievalScore, b.retrievalScore);
    if (byRetrieval !== 0) return byRetrieval;
    if (a.entityId < b.entityId) return -1;
    if (a.entityId > b.entityId) return 1;
    return 0;
  });

  return {
    documents: sorted.map((doc, idx) => ({
      ...doc,
      finalRank: idx + 1,
    })),
    saturated: false,
  };
}

/**
 * Computes blended score combining retrieval + LTR.
 */
function blendScores(
  retrievalScore: number,
  ltrScore: number,
  alpha: number = BLEND_ALPHA_DEFAULT,
): number {
  // Non-finite inputs (NaN/Infinity from upstream signal bugs) must not
  // propagate into the blended score — a single NaN poisons every downstream
  // comparison (NaN compared with anything is false). Drop the offending term
  // to 0 rather than emit NaN. Rule: Number.isFinite guard before arithmetic.
  const safeRetrieval = Number.isFinite(retrievalScore) ? retrievalScore : 0;
  const safeLtr = Number.isFinite(ltrScore) ? ltrScore : 0;
  // alpha is a convex mixing coefficient; clamp so an out-of-range or NaN
  // alpha cannot push the blend outside the span of its two inputs.
  const safeAlpha = clamp(alpha, BLEND_ALPHA_MIN, BLEND_ALPHA_MAX);
  return (1 - safeAlpha) * safeRetrieval + safeAlpha * safeLtr;
}

/**
 * Detects significant reranking to monitor for quality regressions.
 */
function measureRerankingShift(
  beforeRerank: readonly (string | number)[],
  afterRerank: readonly (string | number)[],
): number {
  let totalShift = 0;
  let count = 0;

  const beforePos = new Map(beforeRerank.map((id, idx) => [id, idx]));
  const afterPos = new Map(afterRerank.map((id, idx) => [id, idx]));

  for (const [docId, beforeIdx] of beforePos.entries()) {
    const afterIdx = afterPos.get(docId) ?? beforeRerank.length;
    totalShift += Math.abs(afterIdx - beforeIdx);
    count++;
  }

  return count > 0 ? totalShift / count : 0;
}

export const LTRRanker = {
  rerank,
  blendScores,
  measureRerankingShift,
} as const;
