import { z } from 'zod';

export const KNOWN_AGENT_TOOL_NAMES = [
  'search_wines',
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

export const SearchToolAttemptInputSchema = z.object({
  query: AttemptStringSchema.optional(),
  limit: AttemptNumberSchema.optional(),
  retrieval_mode: AttemptStringSchema.optional(),
  exclude_grapes: AttemptStringArraySchema.optional(),
  exclude_regions: AttemptStringArraySchema.optional(),
  max_price_krw: AttemptNumberSchema.optional(),
  max_alcohol_pct: AttemptNumberSchema.optional(),
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

// ── Inferred types for each tool's validated input ───────────────────────────
export type SearchToolAttemptInput = z.infer<typeof SearchToolAttemptInputSchema>;
export type FoodPairingAttemptInput = z.infer<typeof FoodPairingAttemptInputSchema>;
export type DrinkingWindowAttemptInput = z.infer<typeof DrinkingWindowAttemptInputSchema>;
export type CompareWinesAttemptInput = z.infer<typeof CompareWinesAttemptInputSchema>;

/** Any single known-tool input. Useful when the specific tool isn't narrowed yet. */
export type KnownAgentToolInput =
  | SearchToolAttemptInput
  | FoodPairingAttemptInput
  | DrinkingWindowAttemptInput
  | CompareWinesAttemptInput;

// ── Discriminated union: known tool + its typed input ────────────────────────
export type KnownAgentToolAttempt =
  | { readonly tool: 'search_wines'; readonly input: SearchToolAttemptInput }
  | { readonly tool: 'get_food_pairings'; readonly input: FoodPairingAttemptInput }
  | { readonly tool: 'check_drinking_window'; readonly input: DrinkingWindowAttemptInput }
  | { readonly tool: 'compare_wines'; readonly input: CompareWinesAttemptInput };

/** Unknown tool attempt — minimal open surface for recovery semantics. */
export interface UnknownAgentToolAttempt {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

/** Union of known + unknown tool attempts across the agent pipeline. */
export type AgentToolAttempt = KnownAgentToolAttempt | UnknownAgentToolAttempt;

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

/**
 * Parse and validate a known tool's input against its strict schema.
 *
 * Returns a discriminated `KnownAgentToolAttempt` on success so the tool
 * name and its typed input travel as a correlated pair through the pipeline.
 * Returns `null` for unknown tools or when the input fails schema validation.
 *
 * Safety of `as KnownAgentToolAttempt`: the cast is safe because
 *  1. `tool` is verified by `isKnownAgentToolName` (runtime type guard)
 *  2. `parsed.data` comes from the matching Zod schema (strict parse)
 */
export function parseKnownAgentToolAttemptInput(
  tool: string,
  rawInput: unknown,
): KnownAgentToolAttempt | null {
  if (!isKnownAgentToolName(tool)) {
    return null;
  }
  const normalized = normalizeRawAttemptInput(tool, rawInput);
  const parsed = KnownAgentToolInputAttemptSchemas[tool].safeParse(normalized);
  if (!parsed.success) return null;
  // Safe cast: tool is KnownAgentToolName and parsed.data is the matching schema output
  return { tool, input: parsed.data } as KnownAgentToolAttempt;
}

/**
 * Maximum number of keys preserved in an unknown tool attempt's input.
 * Beyond this, keys are silently truncated — the recovery observation
 * ("Unknown tool: ...") is what drives the LLM's retry, not the input record.
 */
export const MAX_UNKNOWN_TOOL_INPUT_KEYS = 20;

export function parseUnknownAgentToolAttemptInput(
  rawInput: unknown,
): Record<string, unknown> {
  if (!isRecord(rawInput)) return {};
  const keys = Object.keys(rawInput);
  if (keys.length <= MAX_UNKNOWN_TOOL_INPUT_KEYS) return rawInput;
  const bounded: Record<string, unknown> = {};
  for (let i = 0; i < MAX_UNKNOWN_TOOL_INPUT_KEYS; i++) {
    bounded[keys[i]!] = rawInput[keys[i]!];
  }
  return bounded;
}
