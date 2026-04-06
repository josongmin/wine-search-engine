/**
 * T5.4: Selective precision reranking gate.
 *
 * Determines whether cross-encoder reranking should be triggered for a given
 * query, based on candidate count, query class, route, and anchor presence.
 * This avoids the cost of reranking when it is unlikely to improve precision.
 */

export interface RerankGateInput {
  readonly candidateCount: number;
  readonly queryClass: string;
  readonly effectiveRoute: string;
  readonly hasAnchor: boolean;
  /** For testing/overrides — forces rerank regardless of other conditions. */
  readonly rerankForced?: boolean;
}

export interface RerankGateDecision {
  readonly shouldRerank: boolean;
  /** Human-readable trace reason for observability/debugging. */
  readonly reason: string;
  /** Override for the number of top candidates to submit to the reranker. */
  readonly topKOverride?: number;
}

/**
 * Evaluates whether precision reranking should be triggered.
 *
 * Gate priority (first matching rule wins):
 *  1. rerankForced === true        → always rerank
 *  2. candidateCount < 5           → skip (not enough candidates)
 *  3. short_entity / exact_lookup   → skip (already highly precise)
 *  4. comparison_query / hasAnchor → always rerank (high value)
 *  5. semantic_preference          → always rerank (ambiguous semantics benefit most)
 *  6. candidateCount >= 20         → rerank (enough candidates to benefit)
 *  7. default                      → skip
 */
export function evaluateRerankGate(input: RerankGateInput): RerankGateDecision {
  const { candidateCount, queryClass, effectiveRoute, hasAnchor, rerankForced } = input;

  if (rerankForced === true) {
    return { shouldRerank: true, reason: 'forced' };
  }

  if (candidateCount < 5) {
    return { shouldRerank: false, reason: 'too_few_candidates' };
  }

  if (queryClass === 'short_entity' || effectiveRoute === 'exact_lookup') {
    return { shouldRerank: false, reason: 'already_precise' };
  }

  if (queryClass === 'comparison_query' || hasAnchor) {
    return { shouldRerank: true, reason: hasAnchor ? 'has_anchor' : 'comparison_query' };
  }

  // semantic_preference queries have ambiguous intent — cross-encoder reranking
  // adds the most value here because dense retrieval alone cannot reliably rank
  // nuanced preference-driven matches. Always rerank regardless of candidate count.
  if (queryClass === 'semantic_preference') {
    return { shouldRerank: true, reason: 'semantic_preference' };
  }

  if (candidateCount >= 20) {
    return { shouldRerank: true, reason: 'large_candidate_set' };
  }

  return { shouldRerank: false, reason: 'default_skip' };
}
