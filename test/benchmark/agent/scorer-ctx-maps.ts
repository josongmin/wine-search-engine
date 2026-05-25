/**
 * Context-relevance Korean→English canonical maps.
 *
 * Extracted from `scorer.ts` during the 2026-05-25/26 decomposition (8.1).
 * These tables are referenced exclusively by `scoreContextRelevance` to check
 * that observation text matches the query's wine type / country / region.
 *
 * Module-scope per CLAUDE.md rule 16 (deterministic literal arrays — allocate
 * once, not per scoring call). Korean entries align with the SSoT vocabularies
 * in `search-constraint-extractor.ts`, `entity-resolver.ts`, and `nl-mapper.ts`
 * (rule 25 — single source of truth for cross-module vocabulary).
 */

/** Korean wine type → English canonical (lowercase). */
export const CTX_WINE_TYPE_MAP: ReadonlyArray<readonly [string, string]> = [
  ['레드', 'red'],
  ['화이트', 'white'],
  ['스파클링', 'sparkling'],
  ['로제', 'rosé'],
];

/**
 * Korean country name patterns → English canonical (display-cased).
 * Aligned with KOREAN_COUNTRY_ALIASES in search-constraint-extractor.ts.
 */
export const CTX_COUNTRY_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/프랑스/u, 'France'],
  [/이탈리아/u, 'Italy'],
  [/스페인/u, 'Spain'],
  [/호주/u, 'Australia'],
  [/칠레/u, 'Chile'],
  [/미국/u, 'United States'],
  [/아르헨티나/u, 'Argentina'],
  [/독일/u, 'Germany'],
  [/포르투갈/u, 'Portugal'],
  [/뉴질랜드/u, 'New Zealand'],
  [/남아공/u, 'South Africa'],
  [/오스트리아/u, 'Austria'],
];

/** Korean region name → lowercase English canonical. */
export const CTX_REGION_MAP: ReadonlyArray<readonly [string, string]> = [
  ['보르도', 'bordeaux'],
  ['부르고뉴', 'burgundy'],
  ['나파', 'napa'],
  ['바롤로', 'barolo'],
  ['토스카나', 'tuscany'],
  ['리오하', 'rioja'],
  ['샴페인', 'champagne'],
  ['모젤', 'mosel'],
  ['론', 'rhone'],
  ['피에몬테', 'piedmont'],
];
