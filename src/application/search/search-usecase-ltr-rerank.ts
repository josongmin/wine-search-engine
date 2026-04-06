import type { QueryClassWeights } from '../../domain/ranking/index.js';
import type { QueryClass } from '../../domain/shared/types/index.js';
import { LTRRanker } from '../../domain/ranking/service/ltr-ranker.js';
import { extractLTRFeatures } from '../../domain/ranking/service/ltr-feature-extractor.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';

/**
 * Epic 4: LambdaMART rerank when a per-query-class model exists.
 */
export function applyLtrRerankIfAvailable(
  rankedResults: readonly RankedResult[],
  queryClass: QueryClass,
  ltrModels: ReadonlyMap<string, QueryClassWeights> | undefined,
): RankedResult[] {
  const ltrModel = ltrModels?.get(queryClass);
  if (!ltrModel || rankedResults.length === 0) {
    return [...rankedResults];
  }

  const rankableDocuments = rankedResults.map((doc, idx) => ({
    entityId: doc.entityId,
    retrievalScore: doc.finalScore,
    features: extractLTRFeatures({
      semantic: doc.componentScores.semantic,
      popularity: doc.componentScores.popularity,
      attributeAlignment: doc.componentScores.attributeAlignment,
      preferenceAlignment: doc.componentScores.preferenceAlignment,
    }),
    originalRank: idx + 1,
  }));

  const rerankedDocs = LTRRanker.rerank(rankableDocuments, queryClass, ltrModel);

  const origMap = new Map(rankedResults.map((r) => [r.entityId as string, r]));
  return rerankedDocs
    .map((reranked) => {
      const orig = origMap.get(reranked.entityId);
      if (!orig) return undefined;
      return { ...orig, finalScore: reranked.ltrScore, rank: reranked.finalRank };
    })
    .filter((r): r is RankedResult => r !== undefined);
}
