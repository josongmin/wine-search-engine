/**
 * T5.4 / E3-U3: Selective precision reranking gate.
 *
 * Determines whether cross-encoder reranking should be triggered for a given
 * query, based on candidate count, query class, route, and anchor presence.
 * This avoids the cost of reranking when it is unlikely to improve precision.
 *
 * Contract ownership:
 *   - {@link RerankGateInput}  — the ONLY input surface for gate decisions
 *   - {@link RerankGateDecision} — the ONLY output surface; consumers read shouldRerank + reason
 *   - {@link evaluateRerankGate} — pure function, no I/O; single call site is Ranker.rank()
 *
 * Do NOT add a second call site or duplicate the gate logic in route helpers.
 */

export interface RerankGateInput {
  readonly candidateCount: number;
  readonly queryClass: string;
  readonly effectiveRoute: string;
  readonly hasAnchor: boolean;
  /** Execution-contract rerank ceiling. <= 0 disables precision reranking. */
  readonly rerankLimit?: number;
  /** For testing/overrides — forces rerank regardless of other conditions. */
  readonly rerankForced?: boolean;
}

interface RerankGateDecision {
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
 *  3. budget_disabled (rerankLimit ≤ 0) → skip (compiled budget opts out)
 *  4. short_entity / entity route    → skip (already highly precise)
 *  5. comparison_query / hasAnchor → always rerank (high value)
 *  6. semantic_preference          → always rerank (ambiguous semantics benefit most)
 *  7. pure_constraint              → always rerank (price/style/pairing intent)
 *  8. ambiguous_short_form         → always rerank (multiple plausible entities)
 *  9. queryClass='unknown'         → always rerank (P1.B — unclassified queries default
 *                                    benefit from cross-encoder precision; previously
 *                                    fell through to default_skip even with 22+ candidates)
 * 10. candidateCount >= 20         → rerank (enough candidates to benefit)
 * 11. default                      → skip
 */

/** Below this candidate count, cross-encoder overhead exceeds benefit — the
 *  pool is too sparse for meaningful re-ordering (RFC-017 §5.4). */
const RERANK_GATE_MIN_CANDIDATE_COUNT = 5;
/** At or above this count, diversity is high enough that cross-encoder
 *  re-ordering reliably improves top-5 precision (RFC-017 §5.4). */
const RERANK_GATE_LARGE_CANDIDATE_COUNT = 20;

export function evaluateRerankGate(input: RerankGateInput): RerankGateDecision {
  const { candidateCount, queryClass, effectiveRoute, hasAnchor, rerankForced, rerankLimit } = input;
  const boundedTopK =
    rerankLimit !== undefined
      ? Math.max(0, Math.min(candidateCount, rerankLimit))
      : undefined;

  if (rerankForced === true) {
    return {
      shouldRerank: true,
      reason: 'forced',
      ...(boundedTopK !== undefined ? { topKOverride: boundedTopK } : {}),
    };
  }

  if (candidateCount < RERANK_GATE_MIN_CANDIDATE_COUNT) {
    return { shouldRerank: false, reason: 'too_few_candidates' };
  }

  if ((boundedTopK ?? 1) <= 0) {
    return { shouldRerank: false, reason: 'budget_disabled' };
  }

  if (queryClass === 'exact_entity' || queryClass === 'short_entity' || effectiveRoute === 'entity') {
    return { shouldRerank: false, reason: 'already_precise' };
  }

  if (queryClass === 'comparison_query' || hasAnchor) {
    return {
      shouldRerank: true,
      reason: hasAnchor ? 'has_anchor' : 'comparison_query',
      ...(boundedTopK !== undefined ? { topKOverride: boundedTopK } : {}),
    };
  }

  // semantic_preference queries have ambiguous intent — cross-encoder reranking
  // adds the most value here because dense retrieval alone cannot reliably rank
  // nuanced preference-driven matches. Always rerank regardless of candidate count.
  if (queryClass === 'semantic_preference') {
    return {
      shouldRerank: true,
      reason: 'semantic_preference',
      ...(boundedTopK !== undefined ? { topKOverride: boundedTopK } : {}),
    };
  }

  // pure_constraint queries (price/style/food-pairing) benefit heavily from
  // cross-encoder reranking: Cohere rerank-v3.5 understands multilingual
  // intent ("스테이크와 어울리는") → English document cross-attention,
  // which BM25 alone cannot provide. Always rerank when candidates exist.
  if (queryClass === 'pure_constraint') {
    return {
      shouldRerank: true,
      reason: 'pure_constraint',
      ...(boundedTopK !== undefined ? { topKOverride: boundedTopK } : {}),
    };
  }

  // ambiguous_short_form queries (e.g. "바롤로", "아마로네") have multiple
  // plausible candidates — cross-encoder reranking improves precision.
  if (queryClass === 'ambiguous_short_form') {
    return {
      shouldRerank: true,
      reason: 'ambiguous_short_form',
      ...(boundedTopK !== undefined ? { topKOverride: boundedTopK } : {}),
    };
  }

  // P1.B — queryClass='unknown' (planner could not classify) previously fell
  // through to default_skip even with 22+ candidates, causing reranking to be
  // silently bypassed on the long tail of Korean colloquial / bilingual /
  // pairing scenarios. Treat 'unknown' as always-rerank when candidates exist:
  // the cost is bounded by `rerankLimit` (budget gate already enforced above),
  // and cross-encoder rerank is the strongest known precision lever for
  // unclassified queries.
  if (queryClass === 'unknown') {
    return {
      shouldRerank: true,
      reason: 'unknown_class_default_rerank',
      ...(boundedTopK !== undefined ? { topKOverride: boundedTopK } : {}),
    };
  }

  if (candidateCount >= RERANK_GATE_LARGE_CANDIDATE_COUNT) {
    return {
      shouldRerank: true,
      reason: 'large_candidate_set',
      ...(boundedTopK !== undefined ? { topKOverride: boundedTopK } : {}),
    };
  }

  return { shouldRerank: false, reason: 'default_skip' };
}
