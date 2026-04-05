/**
 * All recognized query target entity types.
 *
 * Inference happens in the Planner based on anchors, keywords, and constraints:
 * - `wine` -- the query explicitly targets wine documents (vendor, vintage, etc.).
 * - `producer` -- the query targets a producer/winery (e.g. "안티노리", "Antinori").
 * - `region` -- the query targets a geographic region (e.g. "나파", "Napa Valley").
 * - `style` -- the query targets sensory style only (e.g. "묵직한 레드").
 * - `unknown` -- no clear entity type signal detected; treat as semantic discovery.
 */
export const QUERY_TARGET_TYPES = [
  'wine',
  'producer',
  'region',
  'style',
  'unknown',
] as const;

/** A single recognized query target entity type. */
export type QueryTargetType = (typeof QUERY_TARGET_TYPES)[number];
