/**
 * Alias types an operator may curate by hand on the lookup-v2 ops write plane.
 *
 * Remaining {@link ALIAS_TYPES} members (`canonical`, `catalog_noise_alias`,
 * `derived_initialism`) are machine-derived at index time and must not be
 * hand-authored through ops submit.
 *
 * SSoT — web ops UI imports this list; CSR ops-web mirrors it and is guarded by
 * `lookup-v2-ops-curated-alias-types.regression.test.ts`.
 */
export const OPS_CURATED_ALIAS_TYPES = [
  'misspelling',
  'abbreviation',
  'translation',
  'phonetic',
  'observed_query_alias',
] as const;

export type OpsCuratedAliasType = (typeof OPS_CURATED_ALIAS_TYPES)[number];
