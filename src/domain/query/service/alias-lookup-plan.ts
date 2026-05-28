import type { NormalizedQueryViews } from '../model/query-views.js';
import { buildNormalizedQueryViews } from './query-normalizer.js';
import { Transliterator } from '../../alias/service/transliterator.js';
import { stripAccents } from '../../shared/utils/unicode-normalize.js';
import { lookupCuratedKoreanToken } from './korean-wine-token-lexicon.js';

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

interface AliasLookupPlan {
  readonly views: NormalizedQueryViews;
  readonly tokenList: readonly string[];
  readonly compactList: readonly string[];
  readonly transliteratedList: readonly string[];
  readonly phoneticList: readonly string[];
}

/**
 * Minimum lookup token length.
 *
 * Single-character lookups are dominated by Korean noise particles (e.g.
 * "야", "은") that match many alias rows on prefix and overwhelm PG's
 * ANY(...) candidate scan. The 2-char floor was the existing word-loop
 * guard below.
 */
const MIN_LOOKUP_TOKEN_LENGTH = 2;

/** Maximum span (in source words) considered for curated reverse romanization. */
const MAX_REVERSE_ROMANIZATION_SPAN = 2;

/**
 * For each Hangul-bearing unigram / bigram in `words`, attempt a reverse
 * romanization via the curated `Transliterator.EXCEPTIONS` dictionary.
 *
 * This covers entity surfaces that have a curated Korean↔Latin pair but
 * no entry in `KOREAN_TRANSLITERATION_COMPONENT_RULES` (e.g. "사시카이아"
 * → "sassicaia", "돔 페리뇽" → "dom pérignon"). Without this loop, those
 * Korean tokens would only ever be searched as Korean surfaces, and the
 * PG aliases substrate would silently miss the canonical Latin row when
 * the Korean alias is absent from the overlay snapshot for that wine.
 *
 * The lookup is curated, deterministic, and gated on `containsHangul` so
 * Latin tokens never round-trip through the index.
 */
function addCuratedReverseRomanizations(
  words: readonly string[],
  tokenSet: Set<string>,
  compactSet: Set<string>,
): void {
  for (let i = 0; i < words.length; i += 1) {
    for (let span = 1; span <= MAX_REVERSE_ROMANIZATION_SPAN; span += 1) {
      const slice = words.slice(i, i + span);
      if (slice.length !== span) break;
      const surface = slice.join(' ');
      if (!HANGUL_RE.test(surface)) continue;
      // SSoT lookup: tries the curated per-token lexicon first (페트뤼스
      // → petrus, 마고 → margaux, …), then falls through to the broader
      // EXCEPTIONS reverse-romanization (오푸스 원 → opus one, 돔 페리뇽
      // → dom pérignon, …).
      const latin = lookupCuratedKoreanToken(surface);
      if (latin === undefined || latin.length === 0) continue;

      // Emit both the accentful AND accent-stripped Latin surfaces:
      //   - ETL's `normalizeForMatch` strips accents before writing the
      //     `aliases.normalized_value` column, so the canonical PG row
      //     for Pétrus stores "petrus", not "pétrus".
      //   - Some downstream consumers compare against the curated value
      //     directly, so the accentful form must remain in tokenSet too.
      //
      // Per-word tokenization of the Latin form is INTENTIONALLY OMITTED:
      // splitting "beaujolais nouveau" into "beaujolais" would inject an
      // ambiguous family-prefix unigram that collides against every
      // Beaujolais cru in the alias snapshot. The curated lexicon already
      // contains the single-token entries we WANT (페트뤼스→petrus,
      // 마고→margaux, …) — multi-word reverse-romanizations stay paired.
      const accentless = stripAccents(latin);
      for (const variant of accentless === latin ? [latin] : [latin, accentless]) {
        tokenSet.add(variant);
        compactSet.add(compactForLookup(variant));
      }
    }
  }
}

function addCuratedWholeSurfaceRomanizations(
  surfaces: readonly string[],
  tokenSet: Set<string>,
  compactSet: Set<string>,
): void {
  for (const surface of surfaces) {
    const trimmed = surface.trim();
    if (trimmed.length === 0 || !HANGUL_RE.test(trimmed)) {
      continue;
    }

    const latin = lookupCuratedKoreanToken(trimmed);
    if (latin === undefined || latin.length === 0) {
      continue;
    }

    const accentless = stripAccents(latin);
    for (const variant of accentless === latin ? [latin] : [latin, accentless]) {
      tokenSet.add(variant);
      compactSet.add(compactForLookup(variant));
    }
  }
}

function buildSafeFullSurfaceVariants(views: NormalizedQueryViews): readonly string[] {
  const reorderedVariants = new Set(views.reordered ?? []);
  return trimDeduped(
    views.lookupVariants.filter((value) => !reorderedVariants.has(value)),
  );
}

function addFullSurfaceLookupVariants(
  normalizedQuery: string,
  views: NormalizedQueryViews,
  tokenSet: Set<string>,
  compactSet: Set<string>,
  transliteratedSet: Set<string>,
  phoneticSet: Set<string>,
): void {
  const prefixRomanized = Transliterator.romanizeWineTermPrefix(normalizedQuery);

  for (const value of buildSafeFullSurfaceVariants(views)) {
    if (
      value.length === 0 ||
      (
        views.phoneticCompact !== undefined &&
        value === views.phoneticCompact &&
        value !== views.strict
      )
    ) {
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
    transliteratedSet.add(prefixRomanized);
    transliteratedSet.add(compactForLookup(prefixRomanized));
  }

  if (views.phoneticCompact !== undefined && views.phoneticCompact.length > 0) {
    phoneticSet.add(views.phoneticCompact);
  }
}

export function buildAliasSurfaceLookupPlan(
  normalizedQuery: string,
  queryViews?: NormalizedQueryViews,
): AliasLookupPlan {
  const views = queryViews ?? buildNormalizedQueryViews(normalizedQuery);
  const tokenSet = new Set<string>();
  const compactSet = new Set<string>();
  const transliteratedSet = new Set<string>();
  const phoneticSet = new Set<string>();

  addFullSurfaceLookupVariants(
    normalizedQuery,
    views,
    tokenSet,
    compactSet,
    transliteratedSet,
    phoneticSet,
  );
  addCuratedWholeSurfaceRomanizations(
    [
      views.strict,
      views.punctuationStripped,
      views.vintageStripped,
    ],
    tokenSet,
    compactSet,
  );

  return {
    views,
    tokenList: trimDeduped(tokenSet),
    compactList: trimDeduped(compactSet),
    transliteratedList: trimDeduped(transliteratedSet),
    phoneticList: trimDeduped(phoneticSet),
  };
}

export function buildAliasLookupPlan(
  normalizedQuery: string,
  queryViews?: NormalizedQueryViews,
): AliasLookupPlan {
  const views = queryViews ?? buildNormalizedQueryViews(normalizedQuery);
  const words = views.punctuationStripped.split(/\s+/).filter(Boolean);
  const tokenSet = new Set<string>();
  const compactSet = new Set<string>();
  const transliteratedSet = new Set<string>();
  const phoneticSet = new Set<string>();
  addFullSurfaceLookupVariants(
    normalizedQuery,
    views,
    tokenSet,
    compactSet,
    transliteratedSet,
    phoneticSet,
  );

  // ──────────────────────────────────────────────────────────────────────
  // Pass 2: per-word + per-bigram tokenization.
  //
  // Splits the (Hangul-preserving) `punctuationStripped` view into
  // unigrams + bigrams so individual Korean words remain lookup keys.
  // ──────────────────────────────────────────────────────────────────────
  for (const word of words) {
    if (word.length < MIN_LOOKUP_TOKEN_LENGTH) {
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

  // ──────────────────────────────────────────────────────────────────────
  // Pass 3: curated Korean↔Latin reverse-romanization.
  //
  // This is the structural fix for the Korean→Latin entity-route gap
  // (memory `project_entity_route_broken`). For each Hangul unigram /
  // bigram in the query, ask the curated `Transliterator.EXCEPTIONS`
  // dictionary for its canonical Latin form (페트뤼스 → petrus,
  // 사시카이아 → sassicaia, 돔 페리뇽 → dom pérignon, 오푸스 원 → opus
  // one, …) and add the Latin surface + each Latin word as a lookup key.
  //
  // Why we use EXCEPTIONS — and NOT the broad component-rule
  // transliteration `views.transliterated` — for per-word tokenization:
  // EXCEPTIONS pairs are high-confidence curated identity surfaces, so
  // emitting their Latin tokens as unigram lookup keys is safe. The
  // component rules (e.g. `[/샤또/gu, 'chateau']`) are aggressive
  // syllable substitutions that turn "샤또 디켐" into "chateau dikem";
  // tokenizing those into single Latin words ("chateau") would inject
  // ambiguous broad-family collisions against well-known Latin aliases
  // (Chateau Cheval Blanc, Chateau Margaux, …). The full multi-word
  // component-rule output remains in `transliteratedSet` (compact-match
  // path) and `tokenSet` (full-surface path) from Pass 1.
  //
  // Pass 1 already seeded every full identity surface into `tokenSet`,
  // so the exact-first short-circuit fires before any Pass 3 unigram
  // lookup runs.
  // ──────────────────────────────────────────────────────────────────────
  addCuratedReverseRomanizations(words, tokenSet, compactSet);

  // `prefixRomanized` is already added as a full token in Pass 1 above.
  // We do NOT per-word tokenize it for the same reason
  // `addCuratedReverseRomanizations` does not: family-prefix unigrams
  // (chateau, beaujolais, …) would inject ambiguous collisions.

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
