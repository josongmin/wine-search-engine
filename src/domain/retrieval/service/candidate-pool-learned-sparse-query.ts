import type { HybridRetrievalInput } from '../model/retrieval-input.js';

/** Max expansion terms fed into retrieval query views. */
const QUERY_EXPANSION_MAX_TERMS = 32;
/** Weight increment per repeated token occurrence in expansion stats. */
const QUERY_EXPANSION_TERM_WEIGHT_STEP = 0.25;

export function buildLearnedSparseQueryWeights(
  input: HybridRetrievalInput,
): readonly { token: string; weight: number }[] {
  const counts = new Map<string, number>();
  const sourceQueries = [...input.lexicalQueries, ...input.semanticQueries];

  for (const query of sourceQueries) {
    for (const token of query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 2)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  for (const boost of [
    ...(input.retrievalPlan?.softBoosts ?? []),
    ...(input.retrievalPlan?.inferredBoosts ?? []),
  ]) {
    const boostTokens = retrievalValueToTokens(boost.value);
    for (const token of boostTokens) {
      // Math.max(0, ...) prevents negative weights from corrupting counts.
      // Previously Math.max(1, ...) was used but that clamps all [0,1]-range weights to 1,
      // discarding calibrated confidence signal entirely — high-confidence (0.95) and
      // low-confidence (0.07) boosts received identical increments of 1.
      counts.set(token, (counts.get(token) ?? 0) + Math.max(0, Number.isFinite(boost.weight) ? boost.weight : 0));
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const diff = right[1] - left[1];
      const primary = Number.isFinite(diff) ? diff : 0;
      // Deterministic tiebreaker: avoid localeCompare() which is locale-dependent
      // and produces different token orderings across systems (CLAUDE.md rule 21).
      // Tokens are ASCII-safe query terms so simple lexicographic comparison is correct.
      return primary !== 0 ? primary : (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
    })
    .slice(0, QUERY_EXPANSION_MAX_TERMS)
    .map(([token, count]) => ({
      token,
      weight: 1 + (count - 1) * QUERY_EXPANSION_TERM_WEIGHT_STEP,
    }));
}

function retrievalValueToTokens(value: HybridRetrievalInput['hardConstraints'][number]['value']): readonly string[] {
  if (typeof value === 'string') {
    return tokenizeRetrievalValue(value);
  }
  if (typeof value === 'number') {
    return [value.toString()];
  }
  if (Array.isArray(value)) {
    const tokens: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        tokens.push(...tokenizeRetrievalValue(entry));
      }
    }
    return tokens;
  }
  return [];
}

function tokenizeRetrievalValue(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}
