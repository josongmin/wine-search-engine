/**
 * Mirror of `src/domain/alias/model/ops-curated-alias-types.ts` for the Next.js
 * ops UI. Kept in sync by `lookup-v2-ops-curated-alias-types.regression.test.ts`.
 */
export const OPS_CURATED_ALIAS_TYPES = [
  'misspelling',
  'abbreviation',
  'translation',
  'phonetic',
  'observed_query_alias',
] as const;

export type OpsCuratedAliasType = (typeof OPS_CURATED_ALIAS_TYPES)[number];
