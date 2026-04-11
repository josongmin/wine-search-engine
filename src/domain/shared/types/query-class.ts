/**
 * All query classification labels as defined in RFC-005.
 */
export const QUERY_CLASSES = [
  'exact_entity',
  'short_entity',
  'ambiguous_short_form',
  'anchored_similarity',
  'pure_constraint',
  'semantic_preference',
  'comparison_query',
  'unknown',
] as const;

/**
 * The classification of an incoming search query, per RFC-005.
 *
 * - `exact_entity` — Unambiguous single-entity lookup — fully specified query expected to resolve to exactly one entity.
 * - `short_entity` — direct entity lookup (e.g. "Opus One 2018").
 * - `ambiguous_short_form` — short or abbreviated name that maps to multiple entities.
 * - `anchored_similarity` — "wines like X" with an anchor entity.
 * - `pure_constraint` — structured filter query (e.g. "red wine under $20 from Napa").
 * - `semantic_preference` — natural-language taste preference (e.g. "smooth and fruity").
 * - `comparison_query` — explicit comparison between two or more entities.
 * - `unknown` — the query does not match any known pattern.
 */
export type QueryClass = (typeof QUERY_CLASSES)[number];

const QUERY_CLASS_SET = new Set<string>(QUERY_CLASSES);

export function isQueryClass(value: string): value is QueryClass {
  return QUERY_CLASS_SET.has(value);
}
