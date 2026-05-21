import { normalizeUnicodeWithHomoglyphs, stripAccents } from '../../shared/utils/unicode-normalize.js';
import {
  canonicalizeVintageToken,
  isPotentialVintageToken,
} from '../../shared/utils/vintage.js';
import type { NormalizedQueryViews } from '../model/query-views.js';
import { globalSilentSkipCounter } from '../../../domain/observability/silent-skip-counters.js';
import { correctKoreanWineTypos } from './korean-wine-aliases.js';
import { expandVintageVariants } from './vintage-normalizer.js';

const PUNCTUATION_STRIP_RE = /[^\p{L}\p{N}\s]+/gu;
const COMPACT_RE = /[^\p{L}\p{N}]+/gu;
const SPACE_RE = /\s+/g;
const LATIN_VOWEL_RE = /[aeiouy]/g;
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;
const PHONETIC_NORMALIZATION_RULES: readonly [RegExp, string][] = [
  [/sch/g, 'ch'],
  [/sh/g, 'ch'],
  [/ph/g, 'f'],
  [/eaux/g, 'o'],
  [/eau/g, 'o'],
  [/aux/g, 'o'],
] as const;
/**
 * Korean josa (particle) suffix stripper.
 *
 * Matches 22 documented noun particles attached to the end of a Hangul-syllable
 * token (count must match `KOREAN_JOSA` fixture in
 * `test/regression/query-normalizer-properties.regression.test.ts`):
 *   은/는/이/가          subject markers      (4)
 *   을/를                 object markers       (2)
 *   의                    possessive           (1)
 *   에/에서/에게          locative / dative    (3)
 *   로/으로               directional          (2)
 *   와/과/랑/이랑         "and/with"           (4)
 *   부터/까지/도          range / additive     (3)
 *   보다                  comparison           (1)
 *   님/씨                 honorific            (2)
 *                                       total: 22
 *
 * The regex requires at least 1 preceding Hangul syllable (U+AC00–U+D7A3) so
 * we do not strip from Latin tokens (e.g. "data" must not lose "a"). It also
 * uses the Unicode-safe boundary `(?=$|[^\p{L}\p{N}])` — \b is ASCII-only and
 * would silently not match here.
 *
 * Honorific suffixes 님/씨 are included: they rarely apply to wines directly
 * but appear in conversational wrappers like "샤또 무통 로칠드님".
 */
const KOREAN_JOSA_STRIP_RE =
  /([\uAC00-\uD7A3])(은|는|이|가|을|를|의|에서|에게|에|으로|로|과|와|이랑|랑|부터|까지|보다|도|님|씨)(?=$|[^\p{L}\p{N}])/gu;

/**
 * Strip trailing Korean josa (particles) from each Hangul-anchored token.
 * Exported as the single source of truth (CLAUDE.md rule 30) so downstream
 * consumers — e.g. the synthesis grounding-verify claim matcher — normalize
 * Korean surfaces identically to the query normalizer. Do NOT re-implement a
 * private josa stripper elsewhere; import this.
 */
export const stripKoreanJosa = (value: string): string =>
  value.replace(KOREAN_JOSA_STRIP_RE, '$1');

/**
 * Output-length bound (enforced by Property 8 in
 * `test/regression/query-normalizer-properties.regression.test.ts`):
 *
 *   |view| ≤ K_LEN × |input| + K_CONST     with K_LEN = 8, K_CONST = 64.
 *
 * Why K_LEN = 8: the worst observed per-character expansion across all
 * normalization steps (josa-strip + NFKC + lowercase + accent-strip +
 * component transliteration) comes from the rule arrays below. Empirical
 * worst case among documented patterns: "샤또" (2 chars) → " chateau "
 * (9 chars w/ inserted spaces) ≈ 4.5×; "오푸스" (3) → " opus one " (10) ≈
 * 3.3×. Property-based fuzz over 100 random inputs (≤200 chars) shows max
 * observed multiplier ≈ 5×; K_LEN = 8 leaves ~37% safety margin against
 * future rule additions while still catching exponential blow-up.
 *
 * Why K_CONST = 64: absorbs constant slack on short inputs — concatenated
 * inserted spaces around component substitutions, NFKC compatibility
 * expansions (e.g. ligatures), and the small fixed overhead from
 * `collapseWhitespace`. 64 bytes is the smallest power-of-two slack that
 * accommodates every fixture below (longest LHS→RHS expansion is
 * "카베르네 소비뇽" → " cabernet  sauvignon " ≈ 22 char delta).
 *
 * If a new transliteration rule pushes per-char growth past 6×, re-derive
 * K_LEN empirically rather than tightening the bound silently.
 */
const KOREAN_TRANSLITERATION_RULES: readonly [RegExp, string][] = [
  [/샤토\s*마고/gu, 'chateau margaux'],
  [/샤또\s*마고/gu, 'chateau margaux'],
  [/샤또\s*마르고/gu, 'chateau margaux'],
  [/카베르네\s*소비뇽/gu, 'cabernet sauvignon'],
  [/카베르네소비뇽/gu, 'cabernet sauvignon'],
  [/보졸레\s*누보/gu, 'beaujolais nouveau'],
  [/모에\s*샹동/gu, 'moet chandon'],
  [/모엣\s*샹동/gu, 'moet chandon'],
  [/(^|[^\p{L}\p{N}])오푸(?=$|[^\p{L}\p{N}])/gu, '$1opus one'],
  [/오퍼스\s*원/gu, 'opus one'],
  [/오푸스\s*원/gu, 'opus one'],
  [/오퍼스/gu, 'opus one'],
  [/오푸스/gu, 'opus one'],
  [/로마네\s*콩티/gu, 'romanee conti'],
  [/로마네\s*콩티\s*드/gu, 'romanee conti'],
] as const;
const KOREAN_TRANSLITERATION_COMPONENT_RULES: readonly [RegExp, string][] = [
  [/도멘\s*드\s*라/gu, 'domaine de la'],
  [/샤토/gu, 'chateau'],
  [/샤또/gu, 'chateau'],
  [/오브리옹/gu, 'haut brion'],
  [/보졸레/gu, 'beaujolais'],
  [/누보/gu, 'nouveau'],
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

const ATTACHED_VINTAGE_BOUNDARY_RE =
  /([\p{L}])((?:19|20)\d{2}|\d{2})(?=$|[^\p{N}])/gu;

/**
 * Separates vintage-like numeric suffixes from adjacent letters.
 *
 * Examples:
 * - "샤토마고1996" -> "샤토마고 1996"
 * - "opusone18" -> "opusone 18"
 *
 * This keeps vintage canonicalization and stripping on the shared vintage SSoT
 * path instead of relying on later span fallbacks to recover the clean entity.
 *
 * We intentionally do NOT split leading numeric tokens from following text
 * ("10만원"), because those are often prices or quantity expressions rather
 * than vintages.
 */
const separateAttachedVintageTokens = (value: string): string =>
  collapseWhitespace(value.replace(ATTACHED_VINTAGE_BOUNDARY_RE, '$1 $2'));

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

// Vintage canonicalization and stripping delegate to the vintage SSoT
// (`@domain/shared/utils/vintage`). Any pivot/format change must happen
// there so query normalization, ETL, and label parsing stay aligned.
const canonicalizeVintage = (value: string): string => {
  const tokens = collapseWhitespace(value).split(' ');
  return collapseWhitespace(tokens.map((token) => canonicalizeVintageToken(token)).join(' '));
};

const stripVintage = (value: string): string =>
  collapseWhitespace(
    collapseWhitespace(value)
      .split(' ')
      .filter((token) => !isPotentialVintageToken(token))
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

const buildTransliterationVariants = (value: string): readonly string[] => {
  const variants = dedupeVariants([
    transliterateExact(value),
    transliterateByComponents(value),
  ].filter((variant): variant is string => variant !== undefined));

  if (variants.length === 0 && HANGUL_RE.test(value)) {
    globalSilentSkipCounter.increment('query_transliteration_variant_absent');
  }

  return variants;
};

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
  const permute = (arr: readonly string[], current: readonly string[]): void => {
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

const buildSemanticEmbeddingVariants = (
  raw: string,
  accentless: string,
  punctuationStripped: string,
  vintageCanonicalized: string,
  vintageStripped: string,
  transliteratedVariants: readonly string[],
  reorderedVariants: readonly string[],
): readonly string[] =>
  dedupeVariants([
    raw,
    accentless,
    punctuationStripped,
    vintageCanonicalized,
    vintageStripped,
    ...transliteratedVariants,
    ...reorderedVariants,
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
    const typoCorrected = correctKoreanWineTypos(query);
    const strict = collapseWhitespace(normalizeUnicodeWithHomoglyphs(typoCorrected)).toLowerCase();
    const accentless = stripAccents(strict);
    const collapsedWhitespace = collapseWhitespace(accentless);
    const punctuationStripped = separateAttachedVintageTokens(stripPunctuation(accentless));
    const compactView = compact(punctuationStripped);
    const vintageCanonicalized = canonicalizeVintage(punctuationStripped);
    const vintageStripped = stripVintage(vintageCanonicalized);
    // Korean particle-stripped view: "보르도의 와인" → "보르도 와인",
    // "샤또 무통 로칠드님" → "샤또 무통 로칠드". Applied AFTER vintage handling
    // so vintage tokens remain numeric and unaffected. Only meaningful for
    // Hangul-bearing queries; Latin-only queries are unchanged by the regex.
    const josaStripped = collapseWhitespace(stripKoreanJosa(vintageStripped));
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
      semanticVariants: buildSemanticEmbeddingVariants(
        raw,
        accentless,
        punctuationStripped,
        vintageCanonicalized,
        vintageStripped,
        transliteratedVariants,
        reorderedVariants,
      ),
      lookupVariants: dedupeVariants([
        strict,
        accentless,
        collapsedWhitespace,
        punctuationStripped,
        compactView,
        vintageCanonicalized,
        vintageStripped,
        ...(josaStripped !== vintageStripped ? [josaStripped] : []),
        ...transliteratedVariants,
        ...transliteratedCompacts,
        ...(phoneticNormalizedView.length > 0 ? [phoneticNormalizedView] : []),
        ...phoneticVariants,
        ...reorderedVariants,
        // 2-digit vintage shorthand expansion ("Margaux 15" → "Margaux 2015").
        // Empty list when query already carries a 4-digit year or has no
        // 2-digit token, so this never widens lookupVariants for
        // unambiguous queries. No-op against the current in-memory KIL
        // benchmark fixtures (no observed delta) but exercised by
        // production ETL surfaces.
        ...expandVintageVariants(raw),
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
