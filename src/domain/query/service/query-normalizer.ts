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
  [/샤토\s*마고/g, 'chateau margaux'],
  [/샤또\s*마고/g, 'chateau margaux'],
  [/샤또\s*마르고/g, 'chateau margaux'],
  [/모에\s*샹동/g, 'moet chandon'],
  [/모엣\s*샹동/g, 'moet chandon'],
  [/오퍼스\s*원/g, 'opus one'],
  [/오푸스\s*원/g, 'opus one'],
  [/로마네\s*콩티/g, 'romanee conti'],
  [/로마네\s*콩티\s*드/g, 'romanee conti'],
] as const;
const KOREAN_TRANSLITERATION_COMPONENT_RULES: readonly [RegExp, string][] = [
  [/도멘\s*드\s*라/g, 'domaine de la'],
  [/샤토/g, 'chateau'],
  [/샤또/g, 'chateau'],
  [/오브리옹/g, 'haut brion'],
  [/페트뤼스/g, 'petrus'],
  [/페트루스/g, 'petrus'],
  [/모엣/g, 'moet'],
  [/모에/g, 'moet'],
  [/샹동/g, 'chandon'],
  [/오퍼스/g, 'opus'],
  [/오푸스/g, 'opus'],
  [/로마네/g, 'romanee'],
  [/콩티/g, 'conti'],
  [/마르고/g, 'margaux'],
  [/마고/g, 'margaux'],
  [/라피트/g, 'lafite'],
  [/라투르/g, 'latour'],
  [/무통/g, 'mouton'],
  [/슈발/g, 'cheval'],
  [/블랑/g, 'blanc'],
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
    const phoneticVariants = dedupeVariants([
      phoneticCompact(punctuationStripped),
      phoneticCompact(vintageCanonicalized),
      phoneticCompact(vintageStripped),
      ...transliteratedVariants.map((value) => phoneticCompact(value)),
    ]);
    const phoneticCompactView = phoneticVariants[0] ?? '';

    return {
      raw,
      strict,
      accentless,
      collapsedWhitespace,
      punctuationStripped,
      compact: compactView,
      ...(phoneticCompactView.length > 0 ? { phoneticCompact: phoneticCompactView } : {}),
      vintageCanonicalized,
      vintageStripped,
      transliterated,
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
        ...phoneticVariants,
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
