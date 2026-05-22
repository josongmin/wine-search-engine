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

function normalizeToolAttemptInput(rawInput: unknown): Record<string, unknown> {
  if (!isRecord(rawInput)) {
    return {};
  }
  const style = rawInput['style'];
  if (!Array.isArray(style)) {
    return rawInput;
  }
  const styleValues = style.filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0);
  const existingStyles = Array.isArray(rawInput['styles'])
    ? rawInput['styles'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const { style: _style, ...rest } = rawInput;
  const styles = [...new Set([...styleValues, ...existingStyles])];
  return styles.length > 0 ? { ...rest, styles } : rest;
}

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
  drinking_window: AttemptStringSchema.optional(),
  drinking_window_target_year: AttemptNumberSchema.optional(),
  want_diversity: AttemptBooleanSchema.optional(),
}).strict();

/**
 * High-precision entity lookup. Deliberately MINIMAL: just the wine
 * name/identity and an optional small result cap. NO constraint filters — a
 * lookup resolves "which exact wine is this", not "find wines matching X". If
 * the LLM emits filter fields anyway, the strict-parse + repair path strips
 * them (so a stray min_price_krw degrades to a pure lookup rather than failing).
 */
export const LookupWineAttemptInputSchema = z.object({
  query: AttemptStringSchema.optional(),
  limit: AttemptNumberSchema.optional(),
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
  drinking_window: AttemptStringSchema.optional(),
  drinking_window_target_year: AttemptNumberSchema.optional(),
}).strict();

// ── Inferred types for each tool's validated input ───────────────────────────
export type SearchToolAttemptInput = z.infer<typeof SearchToolAttemptInputSchema>;
export type LookupWineAttemptInput = z.infer<typeof LookupWineAttemptInputSchema>;
export type FoodPairingAttemptInput = z.infer<typeof FoodPairingAttemptInputSchema>;
export type DrinkingWindowAttemptInput = z.infer<typeof DrinkingWindowAttemptInputSchema>;
export type CompareWinesAttemptInput = z.infer<typeof CompareWinesAttemptInputSchema>;

// ── Discriminated union: known tool + its typed input ────────────────────────
export type KnownAgentToolAttempt =
  | { readonly tool: 'search_wines'; readonly input: SearchToolAttemptInput }
  | { readonly tool: 'lookup_wine'; readonly input: LookupWineAttemptInput }
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
  lookup_wine: LookupWineAttemptInputSchema,
  get_food_pairings: FoodPairingAttemptInputSchema,
  check_drinking_window: DrinkingWindowAttemptInputSchema,
  compare_wines: CompareWinesAttemptInputSchema,
} as const satisfies Record<KnownAgentToolName, z.ZodType<Record<string, unknown>>>;

export interface KnownAgentToolAttemptParseIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export interface KnownAgentToolAttemptParseRepair {
  readonly removedUnknownKeys: readonly string[];
}

export interface KnownAgentToolAttemptParseResult {
  readonly attempt: KnownAgentToolAttempt | null;
  readonly normalizedInput: Record<string, unknown>;
  readonly issues: readonly KnownAgentToolAttemptParseIssue[];
  readonly repair?: KnownAgentToolAttemptParseRepair | undefined;
}

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
    return normalizeToolAttemptInput(rawInput);
  }
  if (
    typeof rawInput === 'string' &&
    rawInput.length > 0 &&
    (tool === 'search_wines' || tool === 'lookup_wine')
  ) {
    return { query: rawInput };
  }
  return {};
}

function collectParseIssues(error: z.ZodError): readonly KnownAgentToolAttemptParseIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path,
    message: issue.message,
  }));
}

function collectUnknownKeys(error: z.ZodError): readonly string[] {
  const keys: string[] = [];
  for (const issue of error.issues) {
    if (issue.code !== 'unrecognized_keys') {
      continue;
    }
    keys.push(...issue.keys);
  }
  return [...new Set(keys)];
}

function omitKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  if (keys.length === 0) {
    return input;
  }
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !omitted.has(key)),
  );
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
  return parseKnownAgentToolAttemptInputWithRepair(tool, rawInput).attempt;
}

export function parseKnownAgentToolAttemptInputWithRepair(
  tool: string,
  rawInput: unknown,
): KnownAgentToolAttemptParseResult {
  if (!isKnownAgentToolName(tool)) {
    return {
      attempt: null,
      normalizedInput: {},
      issues: [{ path: [], message: `Unknown tool: ${tool}` }],
    };
  }
  const normalized = normalizeRawAttemptInput(tool, rawInput);
  const schema = KnownAgentToolInputAttemptSchemas[tool];
  const parsed = schema.safeParse(normalized);
  if (parsed.success) {
    return {
      attempt: { tool, input: parsed.data } as KnownAgentToolAttempt,
      normalizedInput: normalized,
      issues: [],
    };
  }

  const removedUnknownKeys = collectUnknownKeys(parsed.error);
  if (removedUnknownKeys.length > 0) {
    const repairedInput = omitKeys(normalized, removedUnknownKeys);
    const repaired = schema.safeParse(repairedInput);
    if (repaired.success) {
      return {
        attempt: { tool, input: repaired.data } as KnownAgentToolAttempt,
        normalizedInput: repairedInput,
        issues: [],
        repair: { removedUnknownKeys },
      };
    }
    return {
      attempt: null,
      normalizedInput: repairedInput,
      issues: collectParseIssues(repaired.error),
      repair: { removedUnknownKeys },
    };
  }

  return {
    attempt: null,
    normalizedInput: normalized,
    issues: collectParseIssues(parsed.error),
  };
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
