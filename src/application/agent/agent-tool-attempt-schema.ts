import { z } from 'zod';

export const KNOWN_AGENT_TOOL_NAMES = [
  'search_wines',
  'get_food_pairings',
  'check_drinking_window',
  'compare_wines',
] as const;

export type KnownAgentToolName = (typeof KNOWN_AGENT_TOOL_NAMES)[number];

const AttemptStringSchema = z.string();
const AttemptNumberSchema = z.number().finite();
const AttemptBooleanSchema = z.boolean();
const AttemptStringArraySchema = z.array(z.string());

export const SearchToolAttemptInputSchema = z.object({
  query: AttemptStringSchema.optional(),
  limit: AttemptNumberSchema.optional(),
  retrieval_mode: AttemptStringSchema.optional(),
  exclude_grapes: AttemptStringArraySchema.optional(),
  exclude_regions: AttemptStringArraySchema.optional(),
  max_price_krw: AttemptNumberSchema.optional(),
  wine_type: AttemptStringSchema.optional(),
  country: AttemptStringSchema.optional(),
  vintage_min: AttemptNumberSchema.optional(),
  vintage_max: AttemptNumberSchema.optional(),
  appellation: AttemptStringSchema.optional(),
  style: AttemptStringSchema.optional(),
  styles: AttemptStringArraySchema.optional(),
  certification: AttemptStringSchema.optional(),
  want_diversity: AttemptBooleanSchema.optional(),
}).strict();

export const FoodPairingAttemptInputSchema = z.object({
  food: AttemptStringSchema.optional(),
  max_price: AttemptNumberSchema.optional(),
  max_price_krw: AttemptNumberSchema.optional(),
  color: AttemptStringSchema.optional(),
}).strict();

export const DrinkingWindowAttemptInputSchema = z.object({
  entity_id: AttemptStringSchema.optional(),
  target_year: AttemptNumberSchema.optional(),
}).strict();

export const CompareWinesAttemptInputSchema = z.object({
  query_a: AttemptStringSchema.optional(),
  query_b: AttemptStringSchema.optional(),
}).strict();

const KnownAgentToolInputAttemptSchemas = {
  search_wines: SearchToolAttemptInputSchema,
  get_food_pairings: FoodPairingAttemptInputSchema,
  check_drinking_window: DrinkingWindowAttemptInputSchema,
  compare_wines: CompareWinesAttemptInputSchema,
} as const satisfies Record<KnownAgentToolName, z.ZodType<Record<string, unknown>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isKnownAgentToolName(tool: string): tool is KnownAgentToolName {
  return (KNOWN_AGENT_TOOL_NAMES as readonly string[]).includes(tool);
}

function normalizeRawAttemptInput(
  tool: string,
  rawInput: unknown,
): Record<string, unknown> {
  if (isRecord(rawInput)) {
    return rawInput;
  }
  if (typeof rawInput === 'string' && rawInput.length > 0 && tool === 'search_wines') {
    return { query: rawInput };
  }
  return {};
}

export function parseKnownAgentToolAttemptInput(
  tool: string,
  rawInput: unknown,
): Record<string, unknown> | null {
  if (!isKnownAgentToolName(tool)) {
    return null;
  }
  const normalized = normalizeRawAttemptInput(tool, rawInput);
  const parsed = KnownAgentToolInputAttemptSchemas[tool].safeParse(normalized);
  return parsed.success ? parsed.data : null;
}

export function parseUnknownAgentToolAttemptInput(
  rawInput: unknown,
): Record<string, unknown> {
  return isRecord(rawInput) ? rawInput : {};
}
