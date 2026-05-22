/**
 * Source-prefix dropped before classifying a strategy. The search-index alias
 * matcher (see `src/infrastructure/adapter/search-index-alias-matcher.ts`)
 * prepends `index_` to every emitted strategy so the SOURCE (search index vs
 * in-memory snapshot) is visible in trace output, but the CLASSIFICATION (is
 * this an exact-like / phonetic match for scoring purposes) must be the SAME
 * regardless of source. Stripping the prefix in one place keeps the prefix
 * semantically available downstream while preventing a misclassification that
 * silently bypassed the phonetic-only confidence cap and let gibberish queries
 * cross the resolve threshold via a phonetic collision (the cap engages on a
 * purely-phonetic strategy set — see `applyPhoneticOnlyCap` in
 * `candidate-scorer.ts` — and was missing the `index_*` variants).
 */
const STRATEGY_SOURCE_PREFIXES: readonly string[] = ['index_'];

/**
 * Strip any source prefix from a strategy name so the classification sets
 * below are matched on the bare strategy identifier. SSoT for the prefix
 * normalization — extend `STRATEGY_SOURCE_PREFIXES` to add new sources.
 */
function stripStrategySourcePrefix(strategy: string): string {
  for (const prefix of STRATEGY_SOURCE_PREFIXES) {
    if (strategy.startsWith(prefix)) return strategy.slice(prefix.length);
  }
  return strategy;
}

const EXACT_LIKE_LOOKUP_STRATEGIES = new Set([
  'exact',
  'lexical_exact',
  'compact_exact',
  'transliterated_exact',
  'prefix_exact',
  'transliterated_prefix',
  'phonetic_exact',
  'hangul_ime_completion',
]);

const TRANSLATION_LOOKUP_STRATEGIES = new Set([
  'transliterated_exact',
  'transliterated_fuzzy',
  'transliterated_prefix',
]);

const PHONETIC_LOOKUP_STRATEGIES = new Set([
  'phonetic_exact',
  'phonetic_fuzzy',
]);

export function isExactLikeLookupStrategy(strategy: string): boolean {
  return EXACT_LIKE_LOOKUP_STRATEGIES.has(stripStrategySourcePrefix(strategy));
}

export function hasExactLikeLookupStrategy(strategies: Iterable<string>): boolean {
  for (const strategy of strategies) {
    if (isExactLikeLookupStrategy(strategy)) {
      return true;
    }
  }
  return false;
}

function isTranslationLookupStrategy(strategy: string): boolean {
  return TRANSLATION_LOOKUP_STRATEGIES.has(stripStrategySourcePrefix(strategy));
}

export function hasTranslationLookupStrategy(strategies: Iterable<string>): boolean {
  for (const strategy of strategies) {
    if (isTranslationLookupStrategy(strategy)) {
      return true;
    }
  }
  return false;
}

export function isPhoneticLookupStrategy(strategy: string): boolean {
  return PHONETIC_LOOKUP_STRATEGIES.has(stripStrategySourcePrefix(strategy));
}

export function hasPhoneticLookupStrategy(strategies: Iterable<string>): boolean {
  for (const strategy of strategies) {
    if (isPhoneticLookupStrategy(strategy)) {
      return true;
    }
  }
  return false;
}
