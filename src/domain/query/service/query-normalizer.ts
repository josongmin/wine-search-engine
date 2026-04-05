import { normalizeUnicode, stripAccents } from '../../shared/utils/unicode-normalize.js';
import type { NormalizedQueryViews } from '../model/query-views.js';

const PUNCTUATION_STRIP_RE = /[^\p{L}\p{N}\s]+/gu;
const COMPACT_RE = /[^\p{L}\p{N}]+/gu;
const SPACE_RE = /\s+/g;
const KOREAN_TRANSLITERATION_RULES: readonly [RegExp, string][] = [
  [/샤또\s*마고/g, 'chateau margaux'],
  [/샤또\s*마르고/g, 'chateau margaux'],
  [/모엣\s*샹동/g, 'moet chandon'],
  [/오푸스\s*원/g, 'opus one'],
  [/로마네\s*콩티/g, 'romanee conti'],
  [/로마네\s*콩티\s*드/g, 'romanee conti'],
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

const transliterate = (value: string): string | undefined => {
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
    const transliterated = transliterate(vintageStripped);

    return {
      raw,
      strict,
      accentless,
      collapsedWhitespace,
      punctuationStripped,
      compact: compactView,
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
        transliterated ?? '',
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
