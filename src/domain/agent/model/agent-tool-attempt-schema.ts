import { z } from 'zod';

/**
 * T-IR-05 + RFC-021 T-PSA-02: the active agent tool taxonomy is the retrieval
 * primitive set that mirrors the external `/v1/search/{hybrid,semantic,lexical}`
 * and `/v2/entity-lookup` HTTP surface, plus the deterministic
 * `similar_to_entity` reference-similarity primitive. The convenience tools
 * (`get_food_pairings`, `check_drinking_window`, `compare_wines`) were removed
 * from the active loop — the agent composes those capabilities from primitive
 * retrieval + synthesis (architecture-decision §5):
 *   - reference similarity ("X 비슷한 와인") = `lookup_wine` → `similar_to_entity`
 *   - comparison = `lookup_wine` → `lookup_wine` → synthesis
 * The legacy single search tool with an in-body lane selector is gone; the lane
 * is selected by the tool NAME, not a body field. `similar_to_entity` takes an
 * already-resolved `entity_id` anchor — never a free-text name.
 */
export const KNOWN_AGENT_TOOL_NAMES = [
  'search_hybrid',
  'search_semantic',
  'search_lexical',
  'lookup_wine',
  'similar_to_entity',
] as const;

export type KnownAgentToolName = (typeof KNOWN_AGENT_TOOL_NAMES)[number];

/** Maps each search-family primitive tool to the retrieval lane it drives in
 *  the candidate pool. `lookup_wine` is entity resolution (no lane — runs the
 *  entity route). SSoT for the tool→lane projection used by the dispatcher. */
export const SEARCH_PRIMITIVE_TOOL_LANES = {
  search_hybrid: 'hybrid',
  search_semantic: 'semantic_only',
  search_lexical: 'lexical_only',
} as const satisfies Record<string, 'hybrid' | 'semantic_only' | 'lexical_only'>;

export type SearchPrimitiveToolName = keyof typeof SEARCH_PRIMITIVE_TOOL_LANES;

export function isSearchPrimitiveToolName(tool: string): tool is SearchPrimitiveToolName {
  return Object.prototype.hasOwnProperty.call(SEARCH_PRIMITIVE_TOOL_LANES, tool);
}

/** Formatted "Available: ..." string derived from SSOT tool name list. */
export const KNOWN_AGENT_TOOL_NAMES_DISPLAY = KNOWN_AGENT_TOOL_NAMES.join(', ');

const AttemptStringSchema = z.string();
const AttemptNumberSchema = z.number().finite();
const AttemptBooleanSchema = z.boolean();
const AttemptStringArraySchema = z.array(z.string());
const AttemptSingleOrStringArraySchema = z.preprocess(
  (value) => (typeof value === 'string' ? [value] : value),
  AttemptStringArraySchema,
);

export const SearchToolAttemptInputSchema = z.object({
  query: AttemptStringSchema.optional(),
  limit: AttemptNumberSchema.optional(),
  retrieval_mode: AttemptStringSchema.optional(),
  exclude_grapes: AttemptStringArraySchema.optional(),
  exclude_regions: AttemptStringArraySchema.optional(),
  exclude_wine_types: AttemptStringArraySchema.optional(),
  min_price_krw: AttemptNumberSchema.optional(),
  max_price_krw: AttemptNumberSchema.optional(),
  max_alcohol_pct: AttemptNumberSchema.optional(),
  grape_primary: AttemptStringSchema.optional(),
  wine_type: AttemptStringSchema.optional(),
  country: AttemptStringSchema.optional(),
  region: AttemptStringSchema.optional(),
  vintage_min: AttemptNumberSchema.optional(),
  vintage_max: AttemptNumberSchema.optional(),
  appellation: AttemptStringSchema.optional(),
  style: AttemptStringSchema.optional(),
  styles: AttemptStringArraySchema.optional(),
  certification: AttemptStringSchema.optional(),
  occasion: AttemptSingleOrStringArraySchema.optional(),
  gift_suitability_min: AttemptNumberSchema.optional(),
  beginner_suitability_min: AttemptNumberSchema.optional(),
  producer_prestige_min: AttemptNumberSchema.optional(),
  popularity_min: AttemptNumberSchema.optional(),
  recipient_profile: AttemptStringSchema.optional(),
  sweetness_min: AttemptNumberSchema.optional(),
  sweetness_max: AttemptNumberSchema.optional(),
  acidity_min: AttemptNumberSchema.optional(),
  acidity_max: AttemptNumberSchema.optional(),
  tannin_max: AttemptNumberSchema.optional(),
  want_diversity: AttemptBooleanSchema.optional(),
}).strict();

export const FoodPairingAttemptInputSchema = z.object({
  food: AttemptStringSchema.optional(),
  max_price: AttemptNumberSchema.optional(),
  max_price_krw: AttemptNumberSchema.optional(),
  color: AttemptStringSchema.optional(),
  sweetness_target: AttemptNumberSchema.optional(),
  acidity_min: AttemptNumberSchema.optional(),
  tannin_max: AttemptNumberSchema.optional(),
  styles: AttemptStringArraySchema.optional(),
  pairing_tags: AttemptStringArraySchema.optional(),
}).strict();

export const DrinkingWindowAttemptInputSchema = z.object({
  entity_id: AttemptStringSchema.optional(),
  target_year: AttemptNumberSchema.optional(),
}).strict();

export const CompareWinesAttemptInputSchema = z.object({
  query_a: AttemptStringSchema.optional(),
  query_b: AttemptStringSchema.optional(),
  // Historical parity with the search-family tools: the planner reasonably
  // mirrors `retrieval_mode` across sibling retrieval calls. Previously stripped via the strict-parse
  // repair pass, which left the planner unable to ever pass the field — see
  // bench #117 RCA (compare-wines-retrieval-mode-and-two-sided-constraints.regression).
  // The enum source MUST stay shared with the search-family attempt schemas
  // (SSoT — CLAUDE.md #25/#30).
  retrieval_mode: AttemptStringSchema.optional(),
  exclude_grapes: AttemptStringArraySchema.optional(),
  exclude_regions: AttemptStringArraySchema.optional(),
  exclude_wine_types: AttemptStringArraySchema.optional(),
  min_price_krw: AttemptNumberSchema.optional(),
  max_price_krw: AttemptNumberSchema.optional(),
  max_alcohol_pct: AttemptNumberSchema.optional(),
  grape_primary: AttemptStringSchema.optional(),
  wine_type: AttemptStringSchema.optional(),
  country: AttemptStringSchema.optional(),
  region: AttemptStringSchema.optional(),
  country_a: AttemptStringSchema.optional(),
  country_b: AttemptStringSchema.optional(),
  region_a: AttemptStringSchema.optional(),
  region_b: AttemptStringSchema.optional(),
  appellation_a: AttemptStringSchema.optional(),
  appellation_b: AttemptStringSchema.optional(),
  grape_primary_a: AttemptStringSchema.optional(),
  grape_primary_b: AttemptStringSchema.optional(),
  wine_type_a: AttemptStringSchema.optional(),
  wine_type_b: AttemptStringSchema.optional(),
  vintage_min_a: AttemptNumberSchema.optional(),
  vintage_min_b: AttemptNumberSchema.optional(),
  vintage_max_a: AttemptNumberSchema.optional(),
  vintage_max_b: AttemptNumberSchema.optional(),
  vintage_min: AttemptNumberSchema.optional(),
  vintage_max: AttemptNumberSchema.optional(),
  appellation: AttemptStringSchema.optional(),
  style: AttemptStringSchema.optional(),
  styles: AttemptStringArraySchema.optional(),
  certification: AttemptStringSchema.optional(),
  occasion: AttemptSingleOrStringArraySchema.optional(),
  gift_suitability_min: AttemptNumberSchema.optional(),
  beginner_suitability_min: AttemptNumberSchema.optional(),
  producer_prestige_min: AttemptNumberSchema.optional(),
  popularity_min: AttemptNumberSchema.optional(),
  recipient_profile: AttemptStringSchema.optional(),
  sweetness_min: AttemptNumberSchema.optional(),
  sweetness_max: AttemptNumberSchema.optional(),
  acidity_min: AttemptNumberSchema.optional(),
  acidity_max: AttemptNumberSchema.optional(),
  tannin_max: AttemptNumberSchema.optional(),
}).strict();

export function isKnownAgentToolName(tool: string): tool is KnownAgentToolName {
  return (KNOWN_AGENT_TOOL_NAMES as readonly string[]).includes(tool);
}
