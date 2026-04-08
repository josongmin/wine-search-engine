import { normalizeUnicode, stripAccents } from '../../shared/utils/unicode-normalize.js';
import type { NormalizedQueryViews } from '../model/query-views.js';

const PUNCTUATION_STRIP_RE = /[^\p{L}\p{N}\s]+/gu;
const COMPACT_RE = /[^\p{L}\p{N}]+/gu;
const SPACE_RE = /\s+/g;
const LATIN_VOWEL_RE = /[aeiouy]/g;
const PHONETIC_NORMALIZATION_RULES: readonly [RegExp, string][] = [
  [/sch/g, 'ch'],
  [/sh/g, 'ch'],
  [/ph/g, 'f'],
  [/eaux/g, 'o'],
  [/eau/g, 'o'],
  [/aux/g, 'o'],
] as const;
const KOREAN_TRANSLITERATION_RULES: readonly [RegExp, string][] = [
  [/샤토\s*마고/gu, 'chateau margaux'],
  [/샤또\s*마고/gu, 'chateau margaux'],
  [/샤또\s*마르고/gu, 'chateau margaux'],
  [/모에\s*샹동/gu, 'moet chandon'],
  [/모엣\s*샹동/gu, 'moet chandon'],
  [/오퍼스\s*원/gu, 'opus one'],
  [/오푸스\s*원/gu, 'opus one'],
  [/로마네\s*콩티/gu, 'romanee conti'],
  [/로마네\s*콩티\s*드/gu, 'romanee conti'],
] as const;
const KOREAN_TRANSLITERATION_COMPONENT_RULES: readonly [RegExp, string][] = [
  [/도멘\s*드\s*라/gu, 'domaine de la'],
  [/샤토/gu, 'chateau'],
  [/샤또/gu, 'chateau'],
  [/오브리옹/gu, 'haut brion'],
  [/페트뤼스/gu, 'petrus'],
  [/페트루스/gu, 'petrus'],
  [/모엣/gu, 'moet'],
  [/모에/gu, 'moet'],
  [/샹동/gu, 'chandon'],
  [/오퍼스/gu, 'opus'],
  [/오푸스/gu, 'opus'],
  [/로마네/gu, 'romanee'],
  [/콩티/gu, 'conti'],
  [/마르고/gu, 'margaux'],
  [/마고/gu, 'margaux'],
  [/라피트/gu, 'lafite'],
  [/라투르/gu, 'latour'],
  [/무통/gu, 'mouton'],
  [/슈발/gu, 'cheval'],
  [/블랑/gu, 'blanc'],
] as const;

const dedupeVariants = (variants: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const variant of variants) {
    const trimmed = variant.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }

  return unique;
};

const collapseWhitespace = (value: string): string => value.replace(SPACE_RE, ' ').trim();

const stripPunctuation = (value: string): string =>
  collapseWhitespace(value.replace(PUNCTUATION_STRIP_RE, ' '));

const compact = (value: string): string =>
  value.replace(COMPACT_RE, '').replace(SPACE_RE, '').trim();

const hasLatinCharacters = (value: string): boolean => /[a-z]/i.test(value);

const normalizePhoneticSkeleton = (value: string): string => {
  let normalized = compact(value).toLowerCase();
  for (const [pattern, replacement] of PHONETIC_NORMALIZATION_RULES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
};

const phoneticNormalized = (value: string): string =>
  hasLatinCharacters(value) ? normalizePhoneticSkeleton(value) : '';

const phoneticCompact = (value: string): string =>
  hasLatinCharacters(value) ? normalizePhoneticSkeleton(value).replace(LATIN_VOWEL_RE, '') : '';

const canonicalizeVintageToken = (token: string): string => {
  if (/^\d{4}$/.test(token)) {
    return token;
  }

  if (/^\d{2}$/.test(token)) {
    const year = Number(token);
    if (Number.isFinite(year)) {
      const currentCentury = Math.floor(new Date().getFullYear() / 100) * 100;
      const pivot = new Date().getFullYear() % 100;
      const canonicalYear = year <= pivot ? currentCentury + year : currentCentury - 100 + year;
      return String(canonicalYear);
    }
  }

  return token;
};

const canonicalizeVintage = (value: string): string => {
  const tokens = collapseWhitespace(value).split(' ');
  return collapseWhitespace(tokens.map(canonicalizeVintageToken).join(' '));
};

const stripVintage = (value: string): string =>
  collapseWhitespace(
    collapseWhitespace(value)
      .split(' ')
      .filter((token) => !/^(?:19|20)\d{2}$/.test(token) && !/^\d{2}$/.test(token))
      .join(' '),
  );

const transliterateExact = (value: string): string | undefined => {
  let result = value;
  let changed = false;

  for (const [pattern, replacement] of KOREAN_TRANSLITERATION_RULES) {
    const next = result.replace(pattern, replacement);
    if (next !== result) {
      changed = true;
      result = next;
    }
  }

  const normalized = collapseWhitespace(result);
  return changed ? normalized : undefined;
};

const transliterateByComponents = (value: string): string | undefined => {
  let result = value;
  let changed = false;

  for (const [pattern, replacement] of KOREAN_TRANSLITERATION_COMPONENT_RULES) {
    const next = result.replace(pattern, ` ${replacement} `);
    if (next !== result) {
      changed = true;
      result = next;
    }
  }

  const normalized = collapseWhitespace(result);
  return changed ? normalized : undefined;
};

const buildTransliterationVariants = (value: string): readonly string[] =>
  dedupeVariants([
    transliterateExact(value) ?? '',
    transliterateByComponents(value) ?? '',
  ]);

/** Minimum tokens to generate reorder variants (pairwise permutations). */
const QUERY_REORDER_VARIANT_MIN_TOKENS = 2;
/** Maximum tokens — beyond this, permutation count explodes. */
const QUERY_REORDER_VARIANT_MAX_TOKENS = 4;

/**
 * Generates all unique token orderings for a whitespace-delimited query.
 * Only generates permutations for queries with 2-4 tokens to avoid explosion.
 * Returns an empty array for single-token or >4-token queries.
 */
const buildReorderedVariants = (value: string): readonly string[] => {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length < QUERY_REORDER_VARIANT_MIN_TOKENS || tokens.length > QUERY_REORDER_VARIANT_MAX_TOKENS) {
    return [];
  }
  const permutations: string[] = [];
  const permute = (arr: string[], current: string[]): void => {
    if (arr.length === 0) {
      permutations.push(current.join(' '));
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      const token = arr[i];
      if (token === undefined) continue;
      permute(
        [...arr.slice(0, i), ...arr.slice(i + 1)],
        [...current, token],
      );
    }
  };
  permute(tokens, []);
  // Skip the first permutation (it's the original order, already in lookupVariants)
  return dedupeVariants(permutations.slice(1));
};

/**
 * Produces a multi-view representation of a query for entity lookup.
 *
 * The views intentionally keep different normalization strengths so callers
 * can stage retrieval from conservative to aggressive forms without losing
 * provenance.
 */
export class QueryNormalizer {
  normalize(query: string): NormalizedQueryViews {
    const raw = query;
    const strict = collapseWhitespace(normalizeUnicode(query)).toLowerCase();
    const accentless = stripAccents(strict);
    const collapsedWhitespace = collapseWhitespace(accentless);
    const punctuationStripped = stripPunctuation(accentless);
    const compactView = compact(punctuationStripped);
    const vintageCanonicalized = canonicalizeVintage(punctuationStripped);
    const vintageStripped = stripVintage(vintageCanonicalized);
    const transliteratedVariants = buildTransliterationVariants(vintageStripped);
    const transliterated = transliteratedVariants[0];
    const transliteratedCompacts = transliteratedVariants.map((value) => compact(value));

    // phoneticNormalized: phonetic rules applied (no vowel removal) — separate from compact
    const phoneticNormalizedView = phoneticNormalized(accentless);

    const phoneticVariants = dedupeVariants([
      phoneticCompact(punctuationStripped),
      phoneticCompact(vintageCanonicalized),
      phoneticCompact(vintageStripped),
      ...transliteratedVariants.map((value) => phoneticCompact(value)),
    ]);
    const phoneticCompactView = phoneticVariants[0] ?? '';

    // reordered: alternate token orderings for multi-word queries
    const reorderedVariants = buildReorderedVariants(vintageStripped);

    return {
      raw,
      strict,
      accentless,
      collapsedWhitespace,
      punctuationStripped,
      compact: compactView,
      ...(phoneticNormalizedView.length > 0 ? { phoneticNormalized: phoneticNormalizedView } : {}),
      ...(phoneticCompactView.length > 0 ? { phoneticCompact: phoneticCompactView } : {}),
      vintageCanonicalized,
      vintageStripped,
      ...(transliterated !== undefined ? { transliterated } : {}),
      ...(reorderedVariants.length > 0 ? { reordered: reorderedVariants } : {}),
      lookupVariants: dedupeVariants([
        strict,
        accentless,
        collapsedWhitespace,
        punctuationStripped,
        compactView,
        vintageCanonicalized,
        vintageStripped,
        ...transliteratedVariants,
        ...transliteratedCompacts,
        ...(phoneticNormalizedView.length > 0 ? [phoneticNormalizedView] : []),
        ...phoneticVariants,
        ...reorderedVariants,
      ]),
    };
  }
}

const DEFAULT_QUERY_NORMALIZER = new QueryNormalizer();

export function buildNormalizedQueryViews(query: string): NormalizedQueryViews {
  return DEFAULT_QUERY_NORMALIZER.normalize(query);
}

export function normalizeQueryStrict(query: string): string {
  return buildNormalizedQueryViews(query).strict;
}
