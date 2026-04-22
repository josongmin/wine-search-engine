import type { NormalizedQueryViews } from '../model/query-views.js';
import { buildNormalizedQueryViews } from './query-normalizer.js';
import { Transliterator } from '../../alias/service/transliterator.js';

const LATIN_VOWEL_RE = /[aeiouy]/i;
const ASCII_ACRONYM_RE = /^[A-Z0-9]+$/;
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;
/** Minimum compact Latin length to treat a token as a lexical word (not an acronym). */
const MIN_LATIN_LEXICAL_CHAR_COUNT = 4;
/** Uppercase acronym surfaces are bounded to avoid matching long product codes. */
const MAX_ACRONYM_SURFACE_LENGTH = 6;

function compactForLookup(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}

function trimDeduped(values: Iterable<string>): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }

  return ordered;
}

function isLexicalLatinWord(value: string): boolean {
  const compact = compactForLookup(value).toLowerCase();
  return (
    compact.length >= MIN_LATIN_LEXICAL_CHAR_COUNT
    && /[a-z]/.test(compact)
    && LATIN_VOWEL_RE.test(compact)
  );
}

function isUppercaseAcronymSurface(value: string): boolean {
  const trimmed = value.trim();
  if (
    trimmed.length < 2
    || trimmed.length > MAX_ACRONYM_SURFACE_LENGTH
    || /\s/u.test(trimmed)
    || HANGUL_RE.test(trimmed)
  ) {
    return false;
  }
  const compact = trimmed.replace(/[^A-Za-z0-9]+/g, '');
  return (
    compact.length >= 2
    && compact.length <= MAX_ACRONYM_SURFACE_LENGTH
    && ASCII_ACRONYM_RE.test(compact)
  );
}

export interface AliasLookupPlan {
  readonly views: NormalizedQueryViews;
  readonly tokenList: readonly string[];
  readonly compactList: readonly string[];
  readonly transliteratedList: readonly string[];
  readonly phoneticList: readonly string[];
}

export function buildAliasLookupPlan(
  normalizedQuery: string,
  queryViews?: NormalizedQueryViews,
): AliasLookupPlan {
  const views = queryViews ?? buildNormalizedQueryViews(normalizedQuery);
  const prefixRomanized = Transliterator.romanizeWineTermPrefix(normalizedQuery);
  const words = views.punctuationStripped.split(/\s+/).filter(Boolean);
  const tokenSet = new Set<string>();
  const compactSet = new Set<string>();
  const transliteratedSet = new Set<string>();
  const phoneticSet = new Set<string>();
  const phoneticCompact = views.phoneticCompact;

  for (const value of views.lookupVariants) {
    if (value.length === 0 || (phoneticCompact !== undefined && value === phoneticCompact)) {
      continue;
    }
    tokenSet.add(value);
    if (value !== views.compact) {
      compactSet.add(compactForLookup(value));
    }
  }

  if (views.compact.length > 0) {
    compactSet.add(views.compact);
  }

  if (views.transliterated !== undefined && views.transliterated.length > 0) {
    transliteratedSet.add(views.transliterated);
    transliteratedSet.add(compactForLookup(views.transliterated));
  }

  if (prefixRomanized !== undefined && prefixRomanized.length > 0) {
    tokenSet.add(prefixRomanized);
    compactSet.add(compactForLookup(prefixRomanized));
    transliteratedSet.add(prefixRomanized);
    transliteratedSet.add(compactForLookup(prefixRomanized));
  }

  if (views.phoneticCompact !== undefined && views.phoneticCompact.length > 0) {
    phoneticSet.add(views.phoneticCompact);
  }

  for (const word of words) {
    if (word.length < 2) {
      continue;
    }
    tokenSet.add(word);
    compactSet.add(compactForLookup(word));
  }

  for (let i = 0; i < words.length - 1; i += 1) {
    const left = words[i];
    const right = words[i + 1];
    if (left === undefined || right === undefined) {
      continue;
    }
    const bigram = `${left} ${right}`;
    tokenSet.add(bigram);
    compactSet.add(compactForLookup(bigram));
  }

  return {
    views,
    tokenList: trimDeduped(tokenSet),
    compactList: trimDeduped(compactSet),
    transliteratedList: trimDeduped(transliteratedSet),
    phoneticList: trimDeduped(phoneticSet),
  };
}

export function isPhoneticAliasSurfaceCompatible(
  normalizedQuery: string,
  aliasSurface: string,
): boolean {
  if (!isLexicalLatinWord(normalizedQuery)) {
    return true;
  }
  return !isUppercaseAcronymSurface(aliasSurface);
}
