import type { AssemblyPolicy } from './candidate-assembly.js';

/**
 * Maps a retrieval mode to the Vespa rank profile that best serves it.
 *
 * - producer_browse / region_browse → `prestige_hybrid`: blends BM25+ANN with
 *   critic score (35%) and producer prestige (25%), surfacing quality-first results
 *   without a second post-retrieval rerank pass.
 * - compare_candidates / relative → `prestige_hybrid`: head-to-head comparisons
 *   benefit from the same quality-first signal set.
 * - discovery / recommendation / occasion → `wine_aware`: full domain signals with
 *   2-phase reranking; adds availability boost, critic score, vintage freshness,
 *   and drinking-window proximity on top of hybrid phase-1. Best for "find me a wine"
 *   queries where domain quality signals matter most.
 * - everything else → `hybrid`: normalized BM25+ANN+popularity for standard search.
 */
export function resolveVespaRankProfile(retrievalMode: string | undefined): string {
  switch (retrievalMode) {
    case 'producer_browse':
    case 'region_browse':
    case 'compare_candidates':
    case 'relative':
      return 'prestige_hybrid';
    case 'discovery':
    case 'recommendation':
    case 'occasion':
      return 'wine_aware';
    default:
      return 'hybrid';
  }
}

export function buildAssemblyPolicy(maxTotal: number): AssemblyPolicy {
  return {
    maxTotal,
    protectExactMatches: true,
    protectAnchorConditioned: true,
  };
}

export function resolveExplorationTopN(
  profileTopN: number,
  executionBudgetMaxCandidates?: number,
): number {
  if (
    executionBudgetMaxCandidates === undefined
    || !Number.isFinite(executionBudgetMaxCandidates)
    || executionBudgetMaxCandidates <= 0
  ) {
    return profileTopN;
  }
  return Math.min(profileTopN, Math.trunc(executionBudgetMaxCandidates));
}
