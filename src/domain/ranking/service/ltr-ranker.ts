/**
 * LTR-powered ranking service for production inference.
 *
 * Uses learned ranking models to rerank search results.
 */

import type { QueryClass } from '../../shared/types/index.js';
import type { RankingFeatures, QueryClassWeights } from './lambdamart-ranker.js';
import { LambdaMARTRanker } from './lambdamart-ranker.js';

/**
 * A searchable document to be ranked.
 */
export interface RankableDocument {
  readonly entityId: string;
  readonly retrievalScore: number;
  readonly features: RankingFeatures;
  readonly originalRank: number;
}

/**
 * Result after LTR ranking.
 */
export interface RankedDocument extends RankableDocument {
  readonly ltrScore: number;
  readonly finalRank: number;
}

/**
 * LTR Ranker: applies learned models to rerank documents.
 */
export namespace LTRRanker {
  /**
   * Reranks documents using learned LTR model.
   */
  export function rerank(
    documents: readonly RankableDocument[],
    _queryClass: QueryClass,
    model?: QueryClassWeights,
  ): readonly RankedDocument[] {
    if (!model) {
      return documents.map((doc, idx) => ({
        ...doc,
        ltrScore: doc.retrievalScore,
        finalRank: idx + 1,
      }));
    }

    const scored = documents.map((doc) => ({
      ...doc,
      ltrScore: LambdaMARTRanker.scoreDocument(doc.features, model),
    }));

    const sorted = [...scored].sort((a, b) => {
      if (b.ltrScore !== a.ltrScore) {
        return b.ltrScore - a.ltrScore;
      }
      return b.retrievalScore - a.retrievalScore;
    });

    return sorted.map((doc, idx) => ({
      ...doc,
      finalRank: idx + 1,
    }));
  }

  /**
   * Computes blended score combining retrieval + LTR.
   */
  export function blendScores(
    retrievalScore: number,
    ltrScore: number,
    alpha: number = 0.5,
  ): number {
    return (1 - alpha) * retrievalScore + alpha * ltrScore;
  }

  /**
   * Detects significant reranking to monitor for quality regressions.
   */
  export function measureRerankingShift(
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
}
