import type { QueryClass } from '../../shared/types/index.js';
import type { ResolverCandidate } from '../model/resolved-candidate.js';
import { hasExactLikeLookupStrategy } from '../../query/service/lookup-strategy-taxonomy.js';

/** Cap confidence gap for short-form queries with only noisy lookup support. */
const SHORT_FORM_NOISY_SUPPORT_GAP_CAP = 0.01;
/** Decimal places when serializing gap for traces. */
const RESOLVER_GAP_TRACE_DECIMAL_PLACES = 4;

const LOOKUP_STRATEGY_SCORE_WEIGHTS = {
  exact: 0.06,
  lexical_exact: 0.05,
  compact_exact: 0.04,
  transliterated_exact: 0.05,
  prefix_exact: 0.05,
  transliterated_prefix: 0.05,
  phonetic_exact: 0.045,
  fuzzy_char_ngram: 0.025,
  transliterated_fuzzy: 0.03,
  phonetic_fuzzy: 0.03,
  substring: -0.015,
  smart_document: -0.02,
} as const;

type LookupStrategy = keyof typeof LOOKUP_STRATEGY_SCORE_WEIGHTS;

export interface LookupStrategyAdjustment {
  readonly entityId: string;
  readonly strategies: readonly string[];
  readonly rawScoreDelta: number;
}

function isLookupStrategy(strategy: string): strategy is LookupStrategy {
  return strategy in LOOKUP_STRATEGY_SCORE_WEIGHTS;
}

export function computeLookupStrategyAdjustment(
  strategies: readonly string[],
  queryClass: QueryClass,
): number {
  let delta = 0;
  for (const strategy of strategies) {
    if (isLookupStrategy(strategy)) {
      delta += LOOKUP_STRATEGY_SCORE_WEIGHTS[strategy];
    }
  }

  if (delta === 0) {
    return 0;
  }

  const isShortForm =
    queryClass === 'exact_entity' ||
    queryClass === 'short_entity' ||
    queryClass === 'ambiguous_short_form';
  const hasOnlyNoisySupport = !hasExactLikeLookupStrategy(strategies);

  if (isShortForm && hasOnlyNoisySupport && delta > 0) {
    return Math.min(delta, SHORT_FORM_NOISY_SUPPORT_GAP_CAP);
  }

  return Number(delta.toFixed(RESOLVER_GAP_TRACE_DECIMAL_PLACES));
}

export function applyLookupStrategyAdjustments(
  scored: readonly { candidate: ResolverCandidate; rawScore: number }[],
  adjustments: readonly LookupStrategyAdjustment[],
): Array<{ candidate: ResolverCandidate; rawScore: number }> {
  if (adjustments.length === 0) {
    return [...scored];
  }

  const deltaByEntity = new Map(
    adjustments.map((entry) => [entry.entityId, entry.rawScoreDelta]),
  );

  return scored.map((entry) => ({
    candidate: entry.candidate,
    rawScore: entry.rawScore + (deltaByEntity.get(String(entry.candidate.entityId)) ?? 0),
  }));
}
