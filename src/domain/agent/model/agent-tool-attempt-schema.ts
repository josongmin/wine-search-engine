import { z } from 'zod';

export const KNOWN_AGENT_TOOL_NAMES = [
  'search_wines',
  'lookup_wine',
  'get_food_pairings',
  'check_drinking_window',
  'compare_wines',
] as const;

export type KnownAgentToolName = (typeof KNOWN_AGENT_TOOL_NAMES)[number];

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
  // Parity with `search_wines`: the planner reasonably mirrors `retrieval_mode`
  // across the search-family tools. Previously stripped via the strict-parse
  // repair pass, which left the planner unable to ever pass the field — see
  // bench #117 RCA (compare-wines-retrieval-mode-and-two-sided-constraints.regression).
  // The enum source MUST stay shared with `search_wines` (SSoT — CLAUDE.md #25/#30).
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
