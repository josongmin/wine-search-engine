/**
 * Entity Lookup V2 — concept / facet lexicon + classifier (T-ELV2-02).
 *
 * A *concept query* describes a CLASS of wines (a grape, a region, a style, an
 * occasion) rather than a specific entity. Such queries must redirect to
 * discovery search and never enter entity resolution (RFC DoD §3 — `까쇼`류).
 *
 * This module is the single source of concept vocabulary. It REUSES the
 * existing attribute vocabularies (rule 25/30 — no duplicate word lists):
 *   - {@link GRAPE_VOCABULARY} / {@link REGION_VOCABULARY} / {@link COUNTRY_VOCABULARY}
 *     from the ranking attribute vocabulary (English surface forms),
 *   - {@link KOREAN_GRAPE_ALIASES} (Korean + Latin grape regexes, incl. `까쇼`).
 * On top of those it adds the facet descriptors (style / colour / body /
 * sweetness / occasion / price) and generic wine stopwords that the attribute
 * vocab does not carry.
 *
 * Classification principle (NOT a hot-string blacklist — ticket forbidden):
 * strip every concept token + stopword from the normalized query; if NOTHING
 * meaningful remains, the query is purely conceptual. A residual token is a
 * producer / proper-name signal and the query is admitted to resolution.
 */

import { GRAPE_VOCABULARY, REGION_VOCABULARY, COUNTRY_VOCABULARY } from '../../ranking/model/wine-attribute-vocabulary.js';
import { KOREAN_GRAPE_ALIASES } from '../../shared/utils/korean-grape-aliases.js';
import { stripAccents } from '../../shared/utils/unicode-normalize.js';
import type { NormalizedQueryViews } from '../../query/model/query-views.js';

/**
 * Facet descriptors — colour / type / body / sweetness / texture. These name a
 * wine CLASS, not an entity. English + Korean surface forms. Lower-cased.
 */
const STYLE_DESCRIPTOR_TERMS: readonly string[] = [
  // colour / type
  'red', 'white', 'rose', 'rosé', 'sparkling', 'dessert', 'fortified', 'orange',
  '레드', '화이트', '로제', '스파클링', '디저트', '주정강화',
  // body / sweetness / texture
  'dry', 'sweet', 'off-dry', 'semi-sweet', 'full bodied', 'full-bodied',
  'medium bodied', 'medium-bodied', 'light bodied', 'light-bodied',
  'oaky', 'tannic', 'crisp', 'bold', 'smooth', 'fruity', 'earthy', 'mineral',
  'dry red', 'dry white',
  '드라이', '달콤한', '단맛', '풀바디', '미디엄바디', '라이트바디', '미디엄', '바디감',
];

/**
 * Occasion / price intent terms — also describe a discovery facet, not an
 * entity. English + Korean.
 */
const OCCASION_PRICE_TERMS: readonly string[] = [
  'cheap', 'expensive', 'affordable', 'budget', 'value', 'premium', 'luxury',
  'gift', 'anniversary', 'celebration', 'party', 'pairing', 'recommend', 'recommendation',
  '가성비', '선물', '기념일', '파티', '추천', '저렴한', '비싼', '고급',
];

/**
 * Generic wine stopwords — tokens that carry no entity signal on their own.
 * Stripped before deciding whether a residual proper-name token remains.
 */
const GENERIC_STOPWORDS: readonly string[] = [
  'wine', 'wines', 'vino', 'vin', 'a', 'an', 'the', 'of', 'de', 'du', 'di', 'da',
  'and', 'or', 'with', 'for', 'me', 'some', 'good', 'best', 'nice',
  '와인', '와인추천', '좀', '하나', '추천해줘', '추천해', '주세요',
];

/**
 * Normalize a concept phrase the SAME way the matched view is normalized:
 * accent-stripped + lower-cased. The classifier matches against
 * `views.vintageStripped`, which is accent-stripped — so an accented vocab
 * term ("Châteauneuf-du-Pape", "Rhône", "rosé") MUST be accent-stripped here
 * or it could never match (audit: DoD-b miss).
 */
function normalizeConceptTerm(term: string): string {
  // Match `vintageStripped`: accent-stripped, lower-cased, punctuation folded to
  // spaces (so hyphenated terms like "Châteauneuf-du-Pape" align with the
  // punctuation-stripped view "chateauneuf du pape"), whitespace collapsed.
  return stripAccents(term.toLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Lower-cased, accent-stripped, de-duplicated phrase list from reused vocab. */
const ATTRIBUTE_CONCEPT_PHRASES: readonly string[] = Array.from(
  new Set(
    [...GRAPE_VOCABULARY, ...REGION_VOCABULARY, ...COUNTRY_VOCABULARY].map(normalizeConceptTerm),
  ),
);

/**
 * All single-step concept phrases (attribute vocab + descriptors + occasion),
 * accent-stripped, sorted longest-first so multi-word phrases are stripped
 * before their tokens.
 */
const CONCEPT_PHRASES: readonly string[] = Array.from(
  new Set([
    ...ATTRIBUTE_CONCEPT_PHRASES,
    ...STYLE_DESCRIPTOR_TERMS.map(normalizeConceptTerm),
    ...OCCASION_PRICE_TERMS.map(normalizeConceptTerm),
  ]),
).sort((a, b) => b.length - a.length);

/**
 * Wrap a regex source in a SCRIPT-AWARE soft boundary.
 *
 * `\b` is ASCII-only (rule 8). A full `[\p{L}\p{N}]` boundary is ALSO wrong for
 * Korean: Hangul agglutinates with no inter-morpheme space, so a full boundary
 * misses `까쇼와인` / `레드와인` (audit R2 — DoD-c regression). We instead block
 * adjacency only to a LATIN letter or digit: this still prevents a Latin grape
 * substring-matching inside a word (`merlot` ⊄ `merlotation`) while allowing
 * Hangul/CJK adjacency. Lookbehind/lookahead are NON-consuming, so an adjacent
 * Hangul char is never deleted by the strip.
 */
function boundedSource(source: string): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${source})(?![a-z0-9])`, 'giu');
}

/**
 * Escape a literal phrase and wrap it in Unicode-safe word boundaries.
 */
function boundedPhraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return boundedSource(escaped);
}

/**
 * Korean grape regexes recompiled global+unicode AND boundary-wrapped. The raw
 * {@link KOREAN_GRAPE_ALIASES} were authored for substring extraction; here
 * they MUST be bounded so e.g. `시라`(Syrah) / `merlot` do not strip out of the
 * middle of a producer name (audit DoD-c). The grape's alternation is grouped
 * by {@link boundedSource} so the boundaries apply to the whole alternation.
 */
const KOREAN_GRAPE_STRIP_REGEXES: ReadonlyArray<readonly [RegExp, string]> =
  KOREAN_GRAPE_ALIASES.map(([re, grape]) => [boundedSource(re.source), grape] as const);

const CONCEPT_PHRASE_REGEXES: ReadonlyArray<readonly [RegExp, string]> = CONCEPT_PHRASES.map(
  (phrase) => [boundedPhraseRegex(phrase), phrase] as const,
);
const STOPWORD_REGEXES: readonly RegExp[] = GENERIC_STOPWORDS.map((w) => boundedPhraseRegex(normalizeConceptTerm(w)));

export interface ConceptClassification {
  /** True when the query, stripped of concept tokens + stopwords, has no residual. */
  readonly isConceptOnly: boolean;
  /** Whether any concept token (grape/region/style/...) matched at all. */
  readonly hasConceptTerm: boolean;
  /** The concept terms that fired, for the response evidence rail. */
  readonly terms: readonly string[];
  /** Leftover surface after stripping — non-empty means a proper-name signal. */
  readonly residual: string;
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Classify a normalized query as concept-only or entity-bearing.
 *
 * Works on `vintageStripped` (accent-stripped, lower-cased, punctuation- and
 * vintage-free; Hangul preserved) so a bare vintage ("2015") never counts as a
 * residual proper-name token.
 */
export function classifyConcept(views: NormalizedQueryViews): ConceptClassification {
  // Pad so boundary regexes can match at both ends. Korean grape regexes match
  // both Hangul and Latin grape names, so this covers `까쇼` and `cabernet`.
  let residual = ` ${views.vintageStripped.toLowerCase()} `;
  const terms = new Set<string>();

  for (const [re, grape] of KOREAN_GRAPE_STRIP_REGEXES) {
    // Bounded regexes consume the leading boundary char; re-pad after each
    // replace so adjacent tokens still see a boundary.
    if (re.test(residual)) {
      terms.add(grape);
      residual = ` ${residual.replace(re, ' ')} `;
    }
  }

  for (const [re, phrase] of CONCEPT_PHRASE_REGEXES) {
    if (re.test(residual)) {
      terms.add(phrase);
      residual = ` ${residual.replace(re, ' ')} `;
    }
  }

  for (const re of STOPWORD_REGEXES) {
    residual = ` ${residual.replace(re, ' ')} `;
  }

  // Drop any leftover standalone digits (stray vintage fragments, counts).
  residual = residual.replace(/(?:^|[^\p{L}\p{N}])\d+(?=$|[^\p{L}\p{N}])/gu, ' ');

  const cleaned = collapse(residual);
  return {
    isConceptOnly: cleaned.length === 0,
    hasConceptTerm: terms.size > 0,
    terms: [...terms],
    residual: cleaned,
  };
}
