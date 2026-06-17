import { Transliterator } from '../../alias/service/transliterator.js';
import { buildNormalizedQueryViews } from './query-normalizer.js';
import { expandKoreanWineTypoVariants } from './korean-wine-aliases.js';
import { isVintageYearToken } from '../../shared/utils/vintage.js';

const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;

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

function tokenizeSurface(value: string): readonly string[] {
  return buildNormalizedQueryViews(value)
    .punctuationStripped
    .split(/\s+/u)
    .filter(Boolean);
}

function addNormalizedSurfaceTerms(target: Set<string>, surface: string): void {
  const views = buildNormalizedQueryViews(surface);
  for (const value of [
    views.strict,
    views.punctuationStripped,
    views.vintageStripped,
  ]) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    target.add(trimmed);
  }
}

function addCuratedKoreanVariants(target: Set<string>, surface: string): void {
  const exceptionSurface = Transliterator.koreanExceptionSurfaceForLatinTerm(surface);
  if (exceptionSurface === undefined) {
    return;
  }
  addNormalizedSurfaceTerms(target, exceptionSurface);
  for (const typoVariant of expandKoreanWineTypoVariants(exceptionSurface)) {
    addNormalizedSurfaceTerms(target, typoVariant);
  }
}

export function isEligiblePrefixQuery(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return HANGUL_RE.test(trimmed) ? trimmed.length >= 2 : trimmed.length >= 3;
}

export function buildAliasPrefixTerms(
  surfaces: readonly string[],
): readonly string[] {
  const terms = new Set<string>();
  for (const surface of surfaces) {
    const trimmed = surface.trim();
    if (trimmed.length === 0) {
      continue;
    }
    addNormalizedSurfaceTerms(terms, trimmed);
    if (!HANGUL_RE.test(trimmed)) {
      addCuratedKoreanVariants(terms, trimmed);
    }
  }
  return trimDeduped(terms);
}

/**
 * True iff the query consumed the entire leading token of a multi-token alias
 * but nothing beyond it (`chateau` -> `chateau margaux`, `opus` -> `opus one`).
 *
 * This is too broad to count as identity-bearing exact-like evidence.
 */
export function isDisallowedWholeLeadingTokenExpansion(
  querySurface: string,
  candidateSurface: string,
): boolean {
  const queryTokens = tokenizeSurface(querySurface);
  const candidateTokens = tokenizeSurface(candidateSurface);
  return (
    queryTokens.length === 1
    && candidateTokens.length > 1
    && queryTokens[0] !== undefined
    && candidateTokens[0] === queryTokens[0]
  );
}

/**
 * True when a single-token query equals only a non-leading token of a multi-token
 * alias (`one` -> `opus one`). These fragments must not promote via phonetic recall.
 */
export function isDisallowedNonLeadingTokenFragment(
  querySurface: string,
  candidateSurface: string,
): boolean {
  const queryTokens = tokenizeSurface(querySurface);
  const candidateTokens = tokenizeSurface(candidateSurface);
  if (queryTokens.length !== 1 || candidateTokens.length <= 1) {
    return false;
  }
  const queryToken = queryTokens[0];
  if (queryToken === undefined) {
    return false;
  }
  const tokenIndex = candidateTokens.indexOf(queryToken);
  return tokenIndex > 0;
}

function isDisallowedWholeLeadingPhraseExpansion(
  querySurface: string,
  candidateSurface: string,
): boolean {
  const queryTokens = tokenizeSurface(querySurface);
  const candidateTokens = tokenizeSurface(candidateSurface);
  if (queryTokens.length === 0 || candidateTokens.length <= queryTokens.length) {
    return false;
  }

  return candidateTokens
    .slice(0, queryTokens.length)
    .join(' ') === queryTokens.join(' ');
}

/**
 * True iff `queryTerm` should be allowed to prefix-match `candidateTerm` in
 * the exact-like alias-prefix substrate.
 *
 * Structural guard:
 * - Allow genuine incomplete prefixes (`opu` -> `opus one`)
 * - Reject broad whole-token expansions where the query already consumed the
 *   full leading token of a multi-token alias (`chateau` -> `chateau margaux`,
 *   `opus` -> `opus one`)
 *
 * Rationale: the latter are category/family collisions, not precise identity
 * evidence. Exact / compact-exact / fuzzy channels already cover the real
 * identity-bearing cases.
 */
export function matchesAliasPrefixTerm(
  queryTerm: string,
  candidateTerm: string,
): boolean {
  const trimmedQuery = queryTerm.trim();
  const trimmedCandidate = candidateTerm.trim();
  if (trimmedQuery.length === 0 || trimmedCandidate.length === 0) {
    return false;
  }
  if (!trimmedCandidate.startsWith(trimmedQuery)) {
    return false;
  }

  if (isDisallowedWholeLeadingTokenExpansion(trimmedQuery, trimmedCandidate)) {
    return false;
  }

  if (isDisallowedWholeLeadingPhraseExpansion(trimmedQuery, trimmedCandidate)) {
    return false;
  }

  return true;
}

/** Wine-label prefixes that must not fan out phonetic recall on multi-token queries. */
const GENERIC_WINE_LABEL_PREFIX_TOKENS = new Set([
  'chateau',
  'château',
  'domaine',
  'bodega',
  'cantina',
  'weingut',
  'tenuta',
  'quinta',
  'castello',
  'clos',
  'mas',
  'dom',
  'schloss',
  'cellars',
  'winery',
  'wines',
  'wine',
]);

export function isGenericWineLabelPrefixToken(token: string): boolean {
  return GENERIC_WINE_LABEL_PREFIX_TOKENS.has(token.trim().toLowerCase());
}

/**
 * Per-token phonetic / Double-Metaphone fanout on multi-token queries must not
 * treat generic label prefixes or standalone vintage years as identity anchors
 * (`chateau` -> every château wine, `2015` -> every 2015 vintage).
 */
export function shouldSkipPerTokenPhoneticFanout(
  queryToken: string,
  queryTokenCount: number,
): boolean {
  if (queryTokenCount < 2) {
    return false;
  }
  const normalized = queryToken.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return isGenericWineLabelPrefixToken(normalized) || isVintageYearToken(normalized);
}
