/**
 * Phonetic skeleton normalization (SSoT).
 *
 * Three independent call sites historically inlined the SAME phonetic
 * recall skeleton — the lossy/permissive compact-vowel-strip used to bucket
 * Latin wine surfaces for the SQL/in-memory phonetic recall channel:
 *
 *   1. `query-normalizer.ts` (`PHONETIC_NORMALIZATION_RULES` + vowel strip,
 *      via `normalizePhoneticSkeleton` / `phoneticCompact`)
 *   2. `pg-alias-matcher.ts` (`PHONETIC_NORMALIZATION_RULES` + `LATIN_VOWEL_RE`
 *      + `compactForLookup` + `phoneticCompactForLookup`)
 *   3. `search-snapshot-alias-matcher.ts` (identical copies of all four)
 *
 * The three rule arrays were byte-for-byte identical. Under CLAUDE.md rule 30
 * (cross-module constants) and rule 25 (shared vocabulary) they MUST live in
 * one module — a drift between query-time skeleton and lookup-time skeleton
 * silently breaks phonetic recall (the query bucket and alias bucket stop
 * agreeing).
 *
 * NOTE on the SQL boundary: `pg-alias-matcher.ts` ALSO inlines these exact
 * substitutions inside a PostgreSQL `regexp_replace` chain (the
 * `normalized_value = ANY(q.phonetic_values)` recall arm). That copy cannot
 * import TypeScript and is intentionally left in SQL; it is covered by the
 * drift-guard test `phonetic-skeleton-ssot.regression.test.ts`, which asserts
 * the SQL chain matches {@link PHONETIC_NORMALIZATION_RULES} pair-for-pair.
 *
 * This module is in the domain layer and imports nothing outside the domain,
 * so it is a valid import target for `application`, `infrastructure`, and
 * `interface` (composite DAG).
 */

/**
 * Ordered Latin grapheme→phoneme collapse rules applied before vowel
 * stripping. Order matters: longer digraph/trigraph patterns precede their
 * shorter prefixes (`eaux` before `eau` before `aux`) so a greedy left-to-
 * right replace does not strand a partial match.
 *
 * Rationale per pair (French/German wine-surface phonemes):
 *  - sch/sh → ch : German "Schloss" and English "sh" both map to the same
 *    palato-alveolar bucket as French "ch".
 *  - ph → f      : Greek-derived digraph.
 *  - eaux/eau/aux → o : French nasal/diphthong endings ("Margeaux"↔"Margaux").
 */
export const PHONETIC_NORMALIZATION_RULES: readonly [RegExp, string][] = [
  [/sch/g, 'ch'],
  [/sh/g, 'ch'],
  [/ph/g, 'f'],
  [/eaux/g, 'o'],
  [/eau/g, 'o'],
  [/aux/g, 'o'],
] as const;

/**
 * Latin vowels (plus `y`) removed in the final skeleton step so that
 * consonant-skeleton matches survive vowel-level typos. Global flag because
 * we replace every occurrence; do NOT reuse the `/i` single-test variant in
 * `alias-lookup-plan.ts` (different semantic — it gates phonetic eligibility,
 * it does not strip).
 */
export const LATIN_VOWEL_RE = /[aeiouy]/g;

/**
 * Drops every non-letter/non-digit grapheme, collapsing the surface to a
 * compact lookup key. Unicode-aware (`\p{L}\p{N}` with `/u`) so Hangul and
 * accented Latin survive the compaction.
 */
export function compactForLookup(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Compact + lowercase + ordered phoneme-collapse, WITHOUT vowel stripping.
 * This is the `phoneticNormalized` view used by `query-normalizer.ts`.
 */
export function normalizePhoneticSkeleton(value: string): string {
  let normalized = compactForLookup(value).toLowerCase();
  for (const [pattern, replacement] of PHONETIC_NORMALIZATION_RULES) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}

/**
 * Full phonetic recall skeleton: {@link normalizePhoneticSkeleton} followed
 * by Latin-vowel stripping. This is the value bucketed by the SQL/in-memory
 * phonetic recall arms and compared against alias phonetic keys.
 *
 * Intentionally lossy (recall over precision). The phonetic *promotion*
 * DECISION uses Double Metaphone (`@domain/alias/service/double-metaphone`),
 * not this skeleton — see the matcher strategy resolvers.
 */
export function phoneticCompactForLookup(value: string): string {
  return normalizePhoneticSkeleton(value).replace(LATIN_VOWEL_RE, '');
}

/** Minimum phonetic-compact key length before jamo_phonetic recall is allowed. */
export const MIN_PHONETIC_COMPACT_LOOKUP_LENGTH = 3;

export function isEligiblePhoneticCompactLookup(value: string): boolean {
  return value.trim().length >= MIN_PHONETIC_COMPACT_LOOKUP_LENGTH;
}
