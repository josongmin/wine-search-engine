/**
 * Korean → Latin curated wine-domain token lexicon (SSoT).
 *
 * Background. The repo has THREE places that historically encoded the
 * Korean↔Latin wine-domain vocabulary, each for a slightly different
 * purpose:
 *
 *   1. `Transliterator.EXCEPTIONS` (domain/alias/service/transliterator.ts)
 *      — curated MULTI-WORD identity surfaces ("opus one"↔"오푸스원",
 *      "dom pérignon"↔"돔 페리뇽"). High confidence, exact-match only.
 *
 *   2. `KOREAN_TRANSLITERATION_RULES` (this directory's query-normalizer)
 *      — curated MULTI-WORD or "exact" patterns ("샤또 마고"→"chateau
 *      margaux", "오푸스 원"→"opus one"). Used at *query normalization*
 *      time to inject a Latin variant into `views.transliterated`.
 *
 *   3. `KOREAN_TRANSLITERATION_COMPONENT_RULES` (same query-normalizer)
 *      — curated PER-TOKEN component substitutions ("페트뤼스"→"petrus",
 *      "마고"→"margaux", "샤또"→"chateau", …). Used at query
 *      normalization time to build a coarser multi-word transliteration.
 *
 * The entity-route Korean lookup gap (memory `project_entity_route_broken`)
 * is structurally an SSoT defect: a query like "페트뤼스 어떤 와인이야?"
 * gets normalized to "petrus 어떤 와인이야" (table 3), but that string
 * appears in `lookupVariants` only as a single multi-word value — the bare
 * Latin token "petrus" never becomes a PG-alias lookup key. Downstream PG
 * matches on `normalized_value = ANY(...)`, so the canonical alias row
 * `petrus → w-petrus-*` is silently missed.
 *
 * This module exposes the SSoT per-token Korean→Latin map so the alias
 * lookup plan can emit the bare Latin token as a first-class lookup key
 * for ANY known wine-domain Korean unigram, even when that token appears
 * inside a Korean-mixed query that the EXCEPTIONS dictionary cannot
 * exact-match.
 *
 * Why only "high-confidence" pairs (NOT the broad component rules like
 * `샤또 → chateau`): single-word Korean→Latin lookups feed directly into
 * PG's `WHERE normalized_value = ANY(...)`. An aggressive substitution
 * (e.g. emitting "chateau" as a unigram for input "샤또 디켐") would
 * collide against every Chateau-family Latin alias in the snapshot and
 * regress the established alias-precedence contract (see
 * `search-snapshot-alias-matcher.test.ts`: "prefers explicit Korean exact
 * aliases over broad Chateau-family Hangul completion collisions").
 *
 * We therefore include only Korean syllables that resolve to a SPECIFIC,
 * non-ambiguous wine identity term (페트뤼스→petrus, 사시카이아→sassicaia,
 * 마고→margaux, …) — and exclude the ambiguous family prefixes (샤또,
 * 보졸레, 도멘 …) that act as discriminators only when combined with the
 * rest of an identity surface.
 */

import { Transliterator } from '../../alias/service/transliterator.js';
import { containsHangul } from '../../shared/utils/hangul.js';

/**
 * Curated per-Korean-token Latin form. The Korean key is the surface form
 * the user typically types; the Latin value MUST be exactly what the ETL
 * stores in `aliases.normalized_value` so a PG ANY(...) lookup matches
 * the alias row.
 *
 * Includes the high-confidence subset of `KOREAN_TRANSLITERATION_COMPONENT_RULES`
 * (excluding the ambiguous family prefixes 샤또/보졸레/도멘 드 라/누보) PLUS
 * the curated entity surfaces drawn from `Transliterator.EXCEPTIONS` that
 * have a unique Korean unigram representation (사시카이아, 티냐넬로,
 * 오르넬라이아, 안티노리, 가야, 크뤼그, 그라파, …).
 */
const CURATED_KOREAN_TO_LATIN: ReadonlyMap<string, string> = new Map([
  // From KOREAN_TRANSLITERATION_COMPONENT_RULES — high-confidence wine
  // identity surfaces (excluded: ambiguous family prefixes 샤또/보졸레/
  // 도멘 드 라/누보/오브리옹).
  ['페트뤼스', 'petrus'],
  ['페트루스', 'petrus'],
  ['페트러스', 'petrus'],
  ['모엣', 'moet'],
  ['모에', 'moet'],
  ['샹동', 'chandon'],
  ['오퍼스', 'opus'],
  ['오푸스', 'opus'],
  ['로마네', 'romanee'],
  ['콩티', 'conti'],
  ['마르고', 'margaux'],
  ['마고', 'margaux'],
  ['라피트', 'lafite'],
  ['라투르', 'latour'],
  ['무통', 'mouton'],
  ['슈발', 'cheval'],
  ['블랑', 'blanc'],

  // From Transliterator.EXCEPTIONS — single-word identity surfaces that
  // are not ambiguous (we deliberately omit "샤또 페트뤼스" etc. because
  // their multi-word reverse-lookup is already handled via
  // `Transliterator.romanizeWineTerm` in alias-lookup-plan).
  ['사시카이아', 'sassicaia'],
  ['티냐넬로', 'tignanello'],
  ['오르넬라이아', 'ornellaia'],
  ['안티노리', 'antinori'],
  ['가야', 'gaja'],
  ['크뤼그', 'krug'],
  ['뵈브', 'veuve'],
  ['클리코', 'clicquot'],
  ['그라파', 'grappa'],
  ['알마비바', 'almaviva'],
  ['핑구스', 'pingus'],
  ['토레스', 'torres'],
  ['그랑쥬', 'grange'],
  ['그랜지', 'grange'],
  ['그레인지', 'grange'],
  ['덕혼', 'duckhorn'],
  ['카테나', 'catena'],
  ['자파타', 'zapata'],
  ['수카르디', 'zuccardi'],
  ['콘차', 'concha'],
  ['카논코프', 'kanonkop'],
  ['메르루스트', 'meerlust'],
  ['모젤', 'mosel'],
  ['리슬링', 'riesling'],
  ['아우슬레제', 'auslese'],
  ['슈페트레제', 'spätlese'],
  ['바롤로', 'barolo'],
  ['브루넬로', 'brunello'],
  ['키안티', 'chianti'],
  ['아마로네', 'amarone'],
  ['바르바레스코', 'barbaresco'],
  ['프로세코', 'prosecco'],
  ['산지오베제', 'sangiovese'],
  ['네비올로', 'nebbiolo'],
  ['몬테풀치아노', 'montepulciano'],
]);

/**
 * Look up the canonical Latin form for a single curated Korean wine
 * token. Returns `undefined` when the surface is not in the curated
 * lexicon — callers MUST fall back to the broader transliterator paths
 * (`Transliterator.romanizeWineTerm` for multi-word exception surfaces,
 * or the component-rule transliteration carried on
 * `views.transliterated`).
 *
 * The surface is matched on the exact, trimmed string; callers are
 * expected to normalize (NFC, lowercase) before calling.
 */
export function lookupCuratedKoreanToken(surface: string): string | undefined {
  const trimmed = surface.trim();
  if (trimmed.length === 0 || !containsHangul(trimmed)) {
    return undefined;
  }
  return CURATED_KOREAN_TO_LATIN.get(trimmed)
    // Multi-word identities (오푸스 원 → opus one, 돔 페리뇽 → dom
    // pérignon) live in EXCEPTIONS; fall through to the curated
    // reverse-romanization SSoT for them.
    ?? Transliterator.romanizeWineTerm(trimmed);
}

/**
 * Visible to tests / property checks. The map is intentionally read-only.
 */
export function curatedKoreanTokenLexiconSize(): number {
  return CURATED_KOREAN_TO_LATIN.size;
}
