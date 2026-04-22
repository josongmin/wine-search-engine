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
  return EXACT_LIKE_LOOKUP_STRATEGIES.has(strategy);
}

export function hasExactLikeLookupStrategy(strategies: Iterable<string>): boolean {
  for (const strategy of strategies) {
    if (isExactLikeLookupStrategy(strategy)) {
      return true;
    }
  }
  return false;
}

export function isTranslationLookupStrategy(strategy: string): boolean {
  return TRANSLATION_LOOKUP_STRATEGIES.has(strategy);
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
  return PHONETIC_LOOKUP_STRATEGIES.has(strategy);
}

export function hasPhoneticLookupStrategy(strategies: Iterable<string>): boolean {
  for (const strategy of strategies) {
    if (isPhoneticLookupStrategy(strategy)) {
      return true;
    }
  }
  return false;
}
