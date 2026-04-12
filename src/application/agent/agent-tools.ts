/**
 * Wraps existing use cases as agent tools.
 *
 * Each tool:
 *   1. Validates input with Zod
 *   2. Calls the existing use case (unchanged)
 *   3. Returns a summarized observation string for the LLM context
 *
 * The use cases, Vespa, ranking, decision — NONE are modified.
 */

import { z } from 'zod';
import { coercePositiveInt, coerceNonNegativeInt, coerceFiniteNumber } from '../../domain/shared/utils/zod-coerce.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { SearchExecutorPort } from '../search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import { KRW_PER_USD_APPROXIMATE, MAX_QUERY_LENGTH, MIN_PRODUCED_VINTAGE_YEAR, MAX_PRODUCED_VINTAGE_YEAR } from '../../domain/shared/constants.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import { MAX_SOURCE_RECORD_REFS_PER_ENTITY } from '../../domain/entity/model/source-record-ref.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import type { NormalizedConstraint } from '../../domain/shared/types/constraint-bundle.js';

// ---------------------------------------------------------------------------
// Schema bounds — named constants so lint catches accidental magic numbers
// ---------------------------------------------------------------------------

/** Max characters for a search query string passed to the tool. SSoT: MAX_QUERY_LENGTH from constants.ts. */
const SEARCH_QUERY_MAX_LEN = MAX_QUERY_LENGTH;
/** Max results the agent can request in a single search call. */
const SEARCH_LIMIT_MAX = 20;
/** Max KRW price the agent can filter on (~100M KRW, safely above any real wine). */
const MAX_PRICE_KRW_BOUND = 100_000_000;
/** Max USD price for legacy `max_price` field: MAX_PRICE_KRW_BOUND / KRW_PER_USD_APPROXIMATE.
 * Prevents unbounded numeric input from LLM (e.g. 1e10) before the KRW conversion. */
const MAX_PRICE_USD_BOUND = Math.ceil(MAX_PRICE_KRW_BOUND / KRW_PER_USD_APPROXIMATE); // ≈ 74_075
/** Top-N results shown in the observation string (controls context window usage). */
const SUMMARY_TOP_N = 5;
/**
 * Max lineage `(source_system:source_record_id)` pairs per wine in the pipe-delimited
 * observation text — keeps agent context bounded; full list is in GROUNDING_JSON.
 */
const AGENT_OBSERVATION_SOURCE_RECORD_REFS_MAX = 3;
/** Max characters in any single observation string returned to the agent loop.
 * Truncation prevents a single tool result from exhausting the agent's token budget.
 * ~2000 chars ≈ 500 tokens (at 4 chars/token) — enough for 5 wine summaries. */
const MAX_OBSERVATION_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Input schemas (same as tool-schemas.ts — reusing patterns)
// ---------------------------------------------------------------------------

/** Minimum vintage year for filter (no wines before this exist). */
const VINTAGE_FILTER_MIN = 1600;
/** Maximum vintage year for filter (future vintages not yet produced). */
const VINTAGE_FILTER_MAX = 2100;
/** Maximum length for style/certification filter strings (e.g. "oaked", "biodynamic"). */
const STYLE_FILTER_MAX_LEN = 50;
/** Max length for individual exclude_grapes / exclude_regions / country / appellation strings.
 *  Longest known appellation: "Vino Nobile di Montepulciano" (28 chars); 100 gives ample headroom. */
const FILTER_STRING_MAX_LEN = 100;
/** Max count of exclude_grapes / exclude_regions array items.
 *  Practical limit: a search with >10 exclusions is degenerate and likely a data error. */
const EXCLUDE_FILTER_MAX_COUNT = 10;

/**
 * Placeholder patterns that LLMs sometimes emit instead of real values.
 * Caught at schema validation to prevent multi-step reasoning failures where
 * the agent "invents" an id template instead of copying a real id from prior
 * tool results. Observed patterns in bench logs: __TO_BE_FILLED__,
 * <top_result_entity_id>, {{id}}, TBD, TODO, PLACEHOLDER.
 */
const PLACEHOLDER_PATTERN = /__[a-z_]+__|<[a-z_]+>|\{\{[^}]+\}\}|^(tbd|todo|placeholder|to_be_filled|unknown)$/i;

const SearchInputSchema = z.object({
  query: z.string()
    .min(1)
    .max(SEARCH_QUERY_MAX_LEN)
    .refine((v) => !PLACEHOLDER_PATTERN.test(v), {
      message: 'query cannot be a placeholder. Use actual search terms.',
    }),
  // coercePositiveInt accepts both number and numeric string (LLMs emit "10" instead of 10).
  // CLAUDE.md: LLM tool call inputs MUST NOT use .strict() — LLMs emit extra fields.
  limit: coercePositiveInt.pipe(z.number().int().min(1).max(SEARCH_LIMIT_MAX)).optional(),
  retrieval_mode: z.enum(['auto', 'entity', 'hybrid', 'mixed']).optional(),
  /** Grape varieties to exclude from results (e.g. ["Cabernet Sauvignon", "Merlot"]).
   *  Applied as Vespa YQL NOT clauses — index-level, not post-filter. */
  exclude_grapes: z.array(z.string().trim().min(1).max(FILTER_STRING_MAX_LEN)).max(EXCLUDE_FILTER_MAX_COUNT).optional(),
  /** Countries/regions to exclude (e.g. ["France", "프랑스"]).
   *  Applied as Vespa YQL NOT clauses — index-level, not post-filter. */
  exclude_regions: z.array(z.string().trim().min(1).max(FILTER_STRING_MAX_LEN)).max(EXCLUDE_FILTER_MAX_COUNT).optional(),
  /** Maximum price in KRW. Agent can pass "$50" style — normalized below. */
  // min(1): 0원은 유효한 예산이 아님. LLM이 0을 emit하면 price post-filter가 lenient
  // fallback을 트리거해 가격 미입력 와인 전체를 반환하는 silent no-op이 된다.
  max_price_krw: coerceNonNegativeInt.pipe(z.number().int().min(1).max(MAX_PRICE_KRW_BOUND)).optional(),
  // ── Structured Vespa filters (direct YQL, bypass NL extraction) ──
  /** Wine type filter: red, white, rosé, sparkling, etc. */
  wine_type: z.enum(['red', 'white', 'rosé', 'sparkling', 'fortified', 'dessert', 'orange', 'natural']).optional(),
  /** Country filter (English canonical name). */
  country: z.string().trim().min(1).max(FILTER_STRING_MAX_LEN).optional(),
  /** Minimum vintage year (inclusive). */
  vintage_min: coercePositiveInt.pipe(z.number().int().min(VINTAGE_FILTER_MIN).max(VINTAGE_FILTER_MAX)).optional(),
  /** Maximum vintage year (inclusive). */
  vintage_max: coercePositiveInt.pipe(z.number().int().min(VINTAGE_FILTER_MIN).max(VINTAGE_FILTER_MAX)).optional(),
  /** Appellation filter (e.g. "Pauillac", "Chianti Classico"). */
  appellation: z.string().trim().min(1).max(FILTER_STRING_MAX_LEN).optional(),
  /** Style filter (e.g. "oaked", "unoaked", "light", "full"). */
  style: z.string().trim().min(1).max(STYLE_FILTER_MAX_LEN).optional(),
  /** Certification filter (e.g. "organic", "biodynamic"). */
  certification: z.string().trim().min(1).max(STYLE_FILTER_MAX_LEN).optional(),
  /** When true, activate diversity dedup to spread results across grapes/regions/styles.
   *  Use when user says "다양하게", "각각", "종류별로", "different styles", etc. */
  want_diversity: z.boolean().optional(),
}).superRefine((data, ctx) => {
  // Cross-field invariant: vintage_min must not exceed vintage_max.
  // Each field is valid individually, but vintage_min=2020 vintage_max=1990 would
  // produce an impossible Vespa YQL range filter that silently returns 0 results.
  if (data.vintage_min != null && data.vintage_max != null && data.vintage_min > data.vintage_max) {
    ctx.addIssue({
      path: ['vintage_max'],
      code: 'custom',
      message: `vintage_max (${data.vintage_max}) must be >= vintage_min (${data.vintage_min})`,
    });
  }
});

const CompareInputSchema = z.object({
  query_a: z.string().min(1).max(SEARCH_QUERY_MAX_LEN),
  query_b: z.string().min(1).max(SEARCH_QUERY_MAX_LEN),
});

/** Max length for entity_id to prevent unbounded strings reaching Vespa GET / NL parser.
 * Vespa document IDs are typically ≤200 chars; 500 is a conservative upper bound. */
const ENTITY_ID_MAX_LEN = 500;
// Drinking-window year bounds: imported from SSoT (src/domain/shared/constants.ts).
// Do NOT redefine locally — see CLAUDE.md rule 30.
const DRINKING_WINDOW_MIN_YEAR = MIN_PRODUCED_VINTAGE_YEAR;
const DRINKING_WINDOW_MAX_YEAR = MAX_PRODUCED_VINTAGE_YEAR;

const DrinkingWindowInputSchema = z.object({
  entity_id: z.string()
    .min(1)
    .max(ENTITY_ID_MAX_LEN)
    .refine((v) => !PLACEHOLDER_PATTERN.test(v), {
      message: 'entity_id cannot be a placeholder. Copy the canonical entity_id from a prior search_wines result (e.g. "opus-one-2018").',
    }),
  target_year: coercePositiveInt.pipe(z.number().int().min(DRINKING_WINDOW_MIN_YEAR).max(DRINKING_WINDOW_MAX_YEAR)).optional(),
});

/** Max food description length — prevents unbounded strings in the food pairing query.
 * Food pairing queries are short (e.g. "steak", "파스타"); 200 chars is generous. */
const FOOD_MAX_LEN = 200;

const FoodPairingInputSchema = z.object({
  food: z.string().min(1).max(FOOD_MAX_LEN),
  /** Budget in Korean Won (KRW). Use this instead of USD amounts. */
  // min(1): SearchInputSchema와 동일 이유 — 0원은 price filter를 무력화함.
  max_price_krw: coerceNonNegativeInt.pipe(z.number().int().min(1).max(MAX_PRICE_KRW_BOUND)).optional(),
  /** Legacy USD price field — accepted for backwards compat but converted internally. */
  max_price: coerceFiniteNumber.pipe(z.number().finite().min(0).max(MAX_PRICE_USD_BOUND)).optional(),
  color: z.enum(['red', 'white', 'rosé', 'sparkling']).optional(),
});

// ---------------------------------------------------------------------------
// Tool result type
// ---------------------------------------------------------------------------

export interface AgentToolResult {
  /** Human-readable observation for the LLM context window. */
  readonly observation: string;
  /** Raw structured result (for inclusion in final response). */
  readonly rawResult: unknown;
}

export interface AgentToolExecutionOptions {
  readonly abortSignal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Dependencies (existing use cases — no changes)
// ---------------------------------------------------------------------------

export interface AgentToolDeps {
  readonly searchUseCase: SearchExecutorPort;
  readonly decomposedSearchExecute?: (
    subQueries: readonly string[],
    comparisonIntent: string,
    originalQuery: string,
    requestId: string,
    startTime: number,
  ) => Promise<ComparisonSearchResponse>;
  readonly drinkingWindowCheck?: (input: {
    vintage: number;
    grapePrimaryEnc: number;
    regionEnc: number;
    countryEnc: number;
    body: number;
    tannin: number;
    acidity: number;
    sweetness: number;
    avgCriticProxyScore: number;
    targetYear: number;
  }) => Promise<DrinkingWindowBlock>;
  /** Direct entity lookup by ID — bypasses the full search pipeline.
   *  When provided, check_drinking_window resolves entities via this port
   *  instead of running a search-as-lookup through searchUseCase. */
  readonly entityLookup?: ((id: CanonicalEntityId) => Promise<RetrievalDocument | undefined>) | undefined;
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

const KNOWN_TOOLS = new Set([
  'search_wines',
  'compare_wines',
  'check_drinking_window',
  'get_food_pairings',
]);

export function isKnownTool(name: string): boolean {
  return KNOWN_TOOLS.has(name);
}

// ---------------------------------------------------------------------------
// Multi-constraint detection (for staged-search hints in search_wines)
// ---------------------------------------------------------------------------

/** Minimum number of detected constraint types to emit the staged-search hint. */
const MIN_CONSTRAINTS_FOR_STAGED_HINT = 3;

/**
 * Minimum result count to classify retrieval as "reliable".
 * Below this threshold (with multi-constraint query) the observation is tagged
 * [RETRIEVAL_QUALITY: partial] — agent should try relaxing one NICE-TO-HAVE
 * constraint before accepting the result as sufficient.
 * Domain rationale: user asking for wine recommendations expects 2-3 concrete options.
 */
const MIN_RESULTS_FOR_RELIABLE_QUALITY = 3;

/**
 * Maximum length of the enriched query string (original query + appended exclusion/price params).
 * Must not exceed MAX_QUERY_LENGTH (500) — the security gate in query-sanitizer.ts rejects
 * queries longer than MAX_QUERY_LENGTH, so an enriched query built to 700 chars would always
 * be rejected. Capping here at MAX_QUERY_LENGTH ensures the enriched query passes the gate.
 *
 * Domain rationale: Vespa YQL parser has a 4 KB query limit; downstream NL parser
 * operates well within 500 chars. The previously used value of 700 was inconsistent
 * with the security gate constant.
 */
const MAX_ENRICHED_QUERY_LEN = MAX_QUERY_LENGTH; // 500 — must match security gate

/** Regex for diversity-intent detection. Korean included → /u flag required (rule 8).
 *  Word boundaries use (?:^|[^\p{L}\p{N}])…(?=$|[^\p{L}\p{N}]) instead of \b so
 *  Korean and accented Latin chars are matched correctly (rule 8: no \b on non-ASCII). */
const WANTS_DIVERSITY_RE = /(?:^|[^\p{L}\p{N}])(?:diverse|different|다른|다르게|각각|variety)(?=$|[^\p{L}\p{N}])/iu;

/**
 * Keyword → label pairs for constraint detection.
 * Module-scope to avoid per-call allocation (deterministic, never changes).
 * All Korean patterns use /u flag and avoid \b (ASCII-only boundary).
 */
// BUG-14: All English word-boundary guards use (?<![\p{L}\p{N}]) / (?![\p{L}\p{N}])
// (Unicode character-class lookbehind/lookahead) instead of (?<![a-z]) / (?![a-z]).
// The ASCII-only form silently passes when a Korean (or accented) character immediately
// precedes/follows an English token — e.g. "타닌tannin" would falsely match (?<![a-z])
// because 타닌 contains no ASCII letters. Using [\p{L}\p{N}] closes this gap.
// All patterns carry the /u flag (required for \p{} Unicode property escapes).
const CONSTRAINT_KEYWORDS: ReadonlyArray<[RegExp, string]> = [
  // Sensory attributes — require adjacent Korean context or full English words
  // to avoid matching unrelated words (e.g. /oak/ matching "Oakville" region).
  [/타닌|(?<![\p{L}\p{N}])tannin(?![\p{L}\p{N}])/iu, '타닌'],
  [/과일향|(?<![\p{L}\p{N}])fruity(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])fruit(?![\p{L}\p{N}])/iu, '과일향'],
  // '오크' is rare as a standalone Korean word outside wine context; "oak" scoped to
  // prevent matching place names like "Oakville", "Oakland" — require non-alpha boundary.
  [/오크(?!빌|랜드|먼트)|(?<![\p{L}\p{N}])oak(?:ed|ing|y)?(?![\p{L}\p{N}])/iu, '오크'],
  [/미네랄|(?<![\p{L}\p{N}])mineral(?![\p{L}\p{N}])/iu, '미네랄'],
  // '산도' is safe (wine-specific); "acid" scoped to word boundary equivalent
  [/산도|(?<![\p{L}\p{N}])acid(?:ic|ity|s)?(?![\p{L}\p{N}])/iu, '산도'],
  // '바디' safe; "body" scoped to avoid "somebody", "everybody" etc.
  [/바디감?|(?<![\p{L}\p{N}])body(?![\p{L}\p{N}])/iu, '바디'],
  // '당도' safe; "sweet" scoped to avoid "sweetspot", "sweetheart" etc.
  [/당도|(?<![\p{L}\p{N}])sweet(?:ness|ish)?(?![\p{L}\p{N}])/iu, '당도'],
  // Price — numeric-anchored, safe
  [/[0-9]+\s*만?\s*원|[$€]\s*[0-9]+/u, '가격'],
  [/비건|(?<![\p{L}\p{N}])vegan(?![\p{L}\p{N}])/iu, '비건'],
  [/유기농|(?<![\p{L}\p{N}])organic(?![\p{L}\p{N}])/iu, '유기농'],
  // Vintage — ends with 4 digits so no trailing lookahead needed; leading boundary guards
  // against "avintage2020" false match.
  [/[0-9]{4}\s*년|(?<![\p{L}\p{N}])vintage\s+[0-9]{4}/iu, '빈티지'],
  // Country names — each English term needs its own Unicode word-boundary guards.
  // A single leading (?<![\p{L}\p{N}]) in an alternation only protects the first branch.
  [/이탈리아|프랑스|스페인|독일|한국|(?<![\p{L}\p{N}])italy(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])france(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])spain(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])germany(?![\p{L}\p{N}])/iu, '국가'],
  // Wine type — same: each English branch needs its own boundary guards.
  [/레드|화이트|스파클링|로제|(?<![\p{L}\p{N}])red(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])white(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])sparkling(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])ros[eé](?![\p{L}\p{N}])/iu, '와인타입'],
];

function detectConstraintKeywords(query: string): readonly string[] {
  const found: string[] = [];
  for (const [pattern, label] of CONSTRAINT_KEYWORDS) {
    if (pattern.test(query) && !found.includes(label)) {
      found.push(label);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Negation term extraction (for post-filter in search_wines)
// ---------------------------------------------------------------------------

/**
 * Korean negation suffixes that follow the term being excluded.
 * Pattern: <term><whitespace?><suffix>
 * Uses Unicode-aware matchAll (no \b) per CLAUDE.md rule 8.
 */
const KOREAN_NEGATION_SUFFIX_RE = /(\S+)\s*(?:빼고|제외하고|제외|말고|아닌|없는|빼)/gu;

/**
 * Korean negation prefixes that precede the term being excluded.
 * Pattern: <prefix><whitespace><term>
 * Uses Unicode-aware matchAll (no \b) per CLAUDE.md rule 8.
 * 비 (non-), 안 쓴 (not using), 대신 (instead of) are prefix-style negations.
 */
const KOREAN_NEGATION_PREFIX_RE = /(?:비\s+|안\s+쓴\s+|대신\s+)(\S+)/gu;

/**
 * English/Latin negation prefix pattern.
 * Captures the term following "not", "without", "exclude", "no", "skip", "non-".
 * Uses \p{L}\p{N} character classes instead of \b to handle accented Latin/non-ASCII.
 */
const ENGLISH_NEGATION_RE = /(?:not|without|exclude|no|skip|non-)\s+([\p{L}\p{N}][^,\n]*?)(?=\s*,|\s+and\s|\s*$)/giu;

function extractNegationTerms(query: string): readonly string[] {
  const terms: string[] = [];

  // Korean negation suffixes: X 빼고, X 제외, X 제외하고, X 말고, X 아닌, X 없는, X 빼
  for (const m of query.matchAll(KOREAN_NEGATION_SUFFIX_RE)) {
    const term = m[1]?.trim() ?? '';
    if (term.length > 0) terms.push(term);
  }

  // Korean negation prefixes: 비 X, 안 쓴 X, 대신 X
  for (const m of query.matchAll(KOREAN_NEGATION_PREFIX_RE)) {
    const term = m[1]?.trim() ?? '';
    if (term.length > 0) terms.push(term);
  }

  // English negation: not X, without X, exclude X, no X, skip X, non-X
  for (const m of query.matchAll(ENGLISH_NEGATION_RE)) {
    const term = m[1]?.trim() ?? '';
    if (term.length > 0) terms.push(term);
  }

  return [...new Set(terms.map((t) => t.toLowerCase()))];
}

/**
 * Additional EntitySummary fields checked for negation post-filter in search_wines.
 * Excludes `canonicalLabel` (checked separately) and `grapes` (iterated separately).
 * Only fields actually present on EntitySummary are listed here.
 * Module-scope to avoid per-call allocation (deterministic, never changes).
 */
const NEGATION_ENTITY_STRING_FIELDS: ReadonlyArray<'region' | 'producer' | 'appellation'> = [
  'region', 'producer', 'appellation',
] as const;

function appendStructuredQueryClauses(
  baseQuery: string,
  clauses: readonly string[],
): string {
  if (clauses.length === 0) {
    return baseQuery;
  }
  // When baseQuery is empty (clauses exceeded MAX_ENRICHED_QUERY_LEN and
  // base was dropped), omit the leading ", " to avoid malformed queries
  // like ", not Cabernet, not Merlot".
  if (baseQuery.length === 0) {
    return clauses.join(', ');
  }
  return `${baseQuery}, ${clauses.join(', ')}`;
}

function buildStructuredSearchClauses(input: {
  readonly exclude_grapes?: readonly string[] | undefined;
  readonly exclude_regions?: readonly string[] | undefined;
  readonly max_price_krw?: number | undefined;
  readonly style?: string | undefined;
  readonly certification?: string | undefined;
}): readonly string[] {
  const clauses: string[] = [];
  for (const grape of input.exclude_grapes ?? []) {
    clauses.push(`not ${grape}`);
  }
  for (const region of input.exclude_regions ?? []) {
    clauses.push(`not ${region}`);
  }
  if (input.max_price_krw !== undefined) {
    clauses.push(`${input.max_price_krw}원 이하`);
  }
  // style and certification are soft text hints — they are NOT Vespa hard filters.
  // style values in the index are compound ("medium red", "bold red") so exact-match
  // filtering on agent-emitted values like "light" or "oaked" always returns 0 hits.
  // certification maps to boolean fields (organic, biodynamic) not a string field.
  if (input.style !== undefined) {
    clauses.push(input.style);
  }
  if (input.certification !== undefined) {
    clauses.push(input.certification);
  }
  return clauses;
}

/** Agent mapping version for structured filter provenance. */
const AGENT_FILTER_VERSION = 'agent_v1';

/**
 * Converts agent tool structured params to NormalizedConstraints that flow
 * directly to Vespa as hard YQL filters.
 *
 * Price is intentionally NOT a Vespa hard filter — many wines lack price_usd
 * data, so a hard filter would silently drop valid results. Price filtering
 * is handled by the agent-level post-filter instead.
 */
function buildStructuredFilters(input: z.infer<typeof SearchInputSchema>): readonly NormalizedConstraint[] {
  const filters: NormalizedConstraint[] = [];
  const v = AGENT_FILTER_VERSION;

  // Exclusions
  for (const grape of input.exclude_grapes ?? []) {
    filters.push({ attribute: 'grape_primary', operator: 'exclude', value: grape, source_phrase: grape, confidence: 1.0, mapping_version: v });
  }
  for (const region of input.exclude_regions ?? []) {
    filters.push({ attribute: 'region', operator: 'exclude', value: region, source_phrase: region, confidence: 1.0, mapping_version: v });
  }

  // Wine type
  if (input.wine_type !== undefined) {
    filters.push({ attribute: 'wine_type', operator: '=', value: input.wine_type, source_phrase: input.wine_type, confidence: 1.0, mapping_version: v });
  }

  // Country
  if (input.country !== undefined) {
    filters.push({ attribute: 'country', operator: '=', value: input.country, source_phrase: input.country, confidence: 1.0, mapping_version: v });
  }

  // Vintage range
  if (input.vintage_min !== undefined) {
    filters.push({ attribute: 'vintage_year', operator: '>=', value: input.vintage_min, source_phrase: `${input.vintage_min}년 이후`, confidence: 1.0, mapping_version: v });
  }
  if (input.vintage_max !== undefined) {
    filters.push({ attribute: 'vintage_year', operator: '<=', value: input.vintage_max, source_phrase: `${input.vintage_max}년 이전`, confidence: 1.0, mapping_version: v });
  }

  // Appellation
  if (input.appellation !== undefined) {
    filters.push({ attribute: 'appellation', operator: '=', value: input.appellation, source_phrase: input.appellation, confidence: 1.0, mapping_version: v });
  }

  // Style: NOT a hard Vespa filter — Vespa style values are compound strings like
  // "medium red", "bold red", "light red", "medium white", "full white". An exact-match
  // filter for agent-emitted values like "light" or "oaked" always returns 0 hits.
  // Style is passed as a soft text hint via appendStructuredQueryClauses() instead.

  // Certification: NOT a hard filter — the index has separate boolean fields `organic`
  // and `biodynamic`, not a `certification` string field. A YQL filter on a nonexistent
  // field returns 0 hits. Certification is appended as a text hint to the query.

  return filters;
}

function collectExcludedTerms(input: {
  readonly query: string;
  readonly exclude_grapes?: readonly string[] | undefined;
  readonly exclude_regions?: readonly string[] | undefined;
}): readonly string[] {
  const structuredTerms = [
    ...(input.exclude_grapes ?? []),
    ...(input.exclude_regions ?? []),
  ];
  return [
    ...new Set(
      [
        ...extractNegationTerms(input.query),
        ...structuredTerms.map((term) => term.trim().toLowerCase()).filter((term) => term.length > 0),
      ],
    ),
  ];
}

/**
 * Truncates an observation string to MAX_OBSERVATION_CHARS to prevent a single
 * tool result from exhausting the agent's token budget in one step.
 */
function capObservation(obs: string): string {
  if (obs.length <= MAX_OBSERVATION_CHARS) return obs;
  return obs.slice(0, MAX_OBSERVATION_CHARS) + `\n[observation truncated at ${MAX_OBSERVATION_CHARS} chars]`;
}

export async function executeAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  deps: AgentToolDeps,
  requestId: string,
  options?: AgentToolExecutionOptions,
): Promise<AgentToolResult> {
  try {
    const result = await executeAgentToolInner(toolName, input, deps, requestId, options);
    return { ...result, observation: capObservation(result.observation) };
  } catch (err) {
    // AbortError signals cooperative cancellation (caller disconnect, timeout abort).
    // MUST propagate so the orchestrator classifies it as terminationReason='aborted'
    // instead of treating it as a tool failure. Without this, abort signals are
    // silently swallowed and the loop continues with a fake error observation.
    if (isAbortError(err)) throw err;
    // Policy-block errors MUST propagate — they are security decisions, not
    // tool failures. Re-throw so the orchestrator can terminate the loop.
    if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
      throw err;
    }
    bootstrapLogger.warn({ err, tool: toolName, requestId }, '[agent-tools] tool execution failed');
    return {
      observation: `Tool "${toolName}" encountered an unexpected error. Try a different approach or query.`,
      rawResult: null,
    };
  }
}

/**
 * Execute multiple tool calls in parallel (Promise.all).
 *
 * Isolation contract:
 *  - Ordinary tool errors are caught per-call and returned as error observations.
 *  - Policy-block DomainErrors are re-thrown immediately (propagated from
 *    executeAgentTool) so the orchestrator terminates the loop. The caller
 *    (orchestrator) wraps executeAgentToolsBatch in try-catch for this.
 *
 * requestId convention: `${baseRequestId}-p${toolIndex}`
 */
export async function executeAgentToolsBatch(
  toolCalls: readonly { readonly tool: string; readonly input: Record<string, unknown> }[],
  deps: AgentToolDeps,
  baseRequestId: string,
  options?: AgentToolExecutionOptions,
): Promise<readonly AgentToolResult[]> {
  return Promise.all(
    toolCalls.map((call, i) =>
      executeAgentTool(call.tool, call.input, deps, `${baseRequestId}-p${i}`, options),
    ),
  );
}

/**
 * Strip null values from LLM tool inputs before Zod validation.
 * LLMs routinely emit {"max_price_krw": null} for optional fields they don't
 * intend to set. Zod's .optional() accepts undefined but rejects null, causing
 * "Expected number, received null" parse failures. Stripping nulls here lets
 * the schema stay strict (no .nullable()) while tolerating LLM output quirks.
 */
function stripNulls(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== null) result[k] = v;
  }
  return result;
}

async function executeAgentToolInner(
  toolName: string,
  input: Record<string, unknown>,
  deps: AgentToolDeps,
  requestId: string,
  options?: AgentToolExecutionOptions,
): Promise<AgentToolResult> {
  switch (toolName) {
    case 'search_wines': {
      const parseResult = SearchInputSchema.safeParse(stripNulls(input));
      if (!parseResult.success) {
        return { observation: `Invalid input for search_wines: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;

      // Enrich query with structured exclusion/price params so the existing
      // search pipeline (which understands natural language) applies them.
      // Truncate the BASE query before appending clauses so that structured
      // clauses (exclusions, price) are never silently truncated mid-token.
      // Slicing the enriched string after appending can cut e.g. "not Cabern"
      // (malformed exclusion) — truncating base-first guarantees clauses intact.
      const clauses = buildStructuredSearchClauses(parsed);
      const clausesStr = clauses.length > 0 ? `, ${clauses.join(', ')}` : '';
      // Truncate BASE query so that the full enriched string never exceeds the limit.
      // `Math.max(0, ...)` prevents negative slice when clauses alone exceed the limit;
      // in that extreme case the base query is dropped and only clauses are kept (still
      // bounded because appendStructuredQueryClauses just concatenates).
      const maxBaseLen = Math.max(0, MAX_ENRICHED_QUERY_LEN - clausesStr.length);
      const baseQueryCapped = parsed.query.slice(0, maxBaseLen);
      // Hard clamp on the final string — handles the edge case where clauses
      // themselves exceed MAX_ENRICHED_QUERY_LEN (very many exclusions).
      const enrichedRaw = appendStructuredQueryClauses(baseQueryCapped, clauses);
      const enrichedQuery = enrichedRaw.length > MAX_ENRICHED_QUERY_LEN
        ? enrichedRaw.slice(0, MAX_ENRICHED_QUERY_LEN)
        : enrichedRaw;

      // Build structured hard constraints from agent params (price, exclusions)
      // so they flow directly to Vespa as YQL filters.
      const structuredFilters = buildStructuredFilters(parsed);

      let response = await deps.searchUseCase.execute(
        {
          query: enrichedQuery,
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
          ...(parsed.retrieval_mode !== undefined
            ? { options: { mode: parsed.retrieval_mode, explain: false, clarification: false } }
            : {}),
          ...(structuredFilters.length > 0 ? { filters: structuredFilters } : {}),
        },
        requestId,
        { ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}) },
      );

      if (response.queryType === 'comparison') {
        return {
          observation: summarizeComparison(response),
          rawResult: response,
        };
      }

      // Activate diversity dedup when (a) agent explicitly set want_diversity=true, or
      // (b) query text contains diversity-intent keywords (WANTS_DIVERSITY_RE).
      // Structured param takes precedence — avoids regex false-positives on queries
      // that happen to contain "다른" or "variety" in a non-diversity context.
      const wantsDiversity = parsed.want_diversity === true || WANTS_DIVERSITY_RE.test(parsed.query);

      // Negation post-filter: exclude results whose identity fields contain negated terms.
      // Checks canonicalLabel, grapes array, and all NEGATION_ENTITY_STRING_FIELDS.
      const negTerms = collectExcludedTerms(parsed);
      if (negTerms.length > 0) {
        // Pre-compile all negation regexes once — not inside the filter callback —
        // to avoid O(results × terms) RegExp compilations per search call.
        // Previously new RegExp() was called inside the filter, creating up to
        // SEARCH_LIMIT_MAX × EXCLUDE_FILTER_MAX_COUNT (20 × 10 = 200) objects per call.
        const negRegs = negTerms.map((term) => {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
        });
        const filtered = response.results.filter((r) => {
          const entity = r.entity;
          // Build a single lowercased string from all identity-bearing fields.
          const parts: string[] = [entity.canonicalLabel.toLowerCase()];
          // Grape varieties array
          for (const g of entity.grapes ?? []) {
            parts.push(g.toLowerCase());
          }
          // Additional EntitySummary string fields from NEGATION_ENTITY_STRING_FIELDS
          for (const field of NEGATION_ENTITY_STRING_FIELDS) {
            const v = entity[field];
            if (typeof v === 'string' && v.length > 0) {
              parts.push(v.toLowerCase());
            }
          }
          const check = parts.join(' ');
          // Use Unicode-aware word boundary so "cabernet" doesn't match "cabernet franc"
          // as a full-word exclusion. \b is ASCII-only and silently fails on non-ASCII.
          return !negRegs.some((re) => re.test(check));
        });
        if (filtered.length < response.results.length) {
          const filteredResponse = { ...response, results: filtered } as typeof response;
          if (filtered.length === 0) {
            // All results matched the negation filter — return the unfiltered results with
            // a strong instruction to pick non-matching wines. This prevents the agent from
            // giving up with "찾을 수 없었습니다" when the index has relevant wines.
            // The agent MUST still exclude the negated items from its final recommendation.
            return {
              observation:
                `[NEGATION_FALLBACK: All ${response.results.length} result(s) matched excluded terms (${negTerms.join(', ')}). `
                + `Showing unfiltered results — YOU MUST skip any wine whose grape/region matches the excluded terms and recommend only the non-matching ones. `
                + `If all wines match, tell the user and suggest broadening.]\n`
                + summarizeSearchResults(response, wantsDiversity),
              rawResult: response,
            };
          }
          return {
            observation:
              summarizeSearchResults(filteredResponse, wantsDiversity)
              + `\n[Excluded ${response.results.length - filtered.length} result(s) matching negation terms: ${negTerms.join(', ')}]`,
            rawResult: filteredResponse,
          };
        }
      }

      // Price post-filter: when agent specified max_price_krw, drop results whose
      // priceRange exceeds the budget. The search pipeline does not have a native
      // price filter — max_price_krw is a text hint — so out-of-range results can
      // slip through. This post-filter gives the agent accurate budget-aware results.
      if (parsed.max_price_krw !== undefined) {
        const budgetKrw = parsed.max_price_krw;
        // Parse a priceRange string into KRW. Returns null when the format is
        // unrecognised (e.g. EUR, GBP) — those are kept to avoid false drops.
        // Returns undefined when price data is absent.
        const parsePriceAsKrw = (pr: string | undefined): number | null | undefined => {
          if (pr === undefined) return undefined; // no price data
          // USD: "$120" or "$1,234.56"
          const usdMatch = /^\$(\d[\d,]*(?:\.\d+)?)$/.exec(pr);
          if (usdMatch !== null) {
            const priceUsd = Number(usdMatch[1]!.replace(/,/g, ''));
            if (!Number.isFinite(priceUsd)) return null; // parse failure → keep
            return Math.round(priceUsd * KRW_PER_USD_APPROXIMATE);
          }
          // KRW: "120,000원" or "₩120000"
          const krwMatch = /^(?:₩|)(\d[\d,]*)(?:\s*원)?$/u.exec(pr.trim());
          if (krwMatch !== null) {
            const priceKrw = Number(krwMatch[1]!.replace(/,/g, ''));
            if (!Number.isFinite(priceKrw)) return null; // parse failure → keep
            return priceKrw;
          }
          return null; // unrecognised currency (EUR, GBP, etc.) → keep
        };
        const priceFiltered = response.results.filter((r) => {
          const priceKrw = parsePriceAsKrw(r.entity.priceRange);
          if (priceKrw === undefined) return false; // no price data → drop (strict budget)
          if (priceKrw === null) return true; // unrecognisable format → keep (benefit of doubt)
          return priceKrw <= budgetKrw;
        });
        // If strict filtering removed ALL results (sparse price_usd in index),
        // fall back to keeping wines with no price data so the agent can still
        // return something and the user gets guidance rather than an empty list.
        const strictEmpty = priceFiltered.length === 0 && response.results.length > 0;
        if (strictEmpty) {
          const lenient = response.results.filter((r) => {
            const priceKrw = parsePriceAsKrw(r.entity.priceRange);
            if (priceKrw === undefined || priceKrw === null) return true; // no data / unknown currency
            return priceKrw <= budgetKrw;
          });
          response = {
            ...response,
            results: lenient,
          } as typeof response;
        } else if (priceFiltered.length < response.results.length) {
          response = { ...response, results: priceFiltered } as typeof response;
        }
      }

      // Zero-result escalation: guide the agent to relax constraints one by one.
      if (response.results.length === 0) {
        return {
          observation: `[RETRIEVAL_QUALITY: unreliable — 0 results]\n검색 결과가 없습니다. 검색어: "${parsed.query}". 힌트: 조건을 하나씩 줄여서 재검색하세요 (예: 가격 조건 제거 → 품종만으로 재검색).`,
          rawResult: response,
        };
      }

      // Multi-constraint hint: when 3+ constraint types are detected, remind the
      // agent it can relax constraints if results are insufficient.
      let obs = summarizeSearchResults(response, wantsDiversity);
      const constraintHints = detectConstraintKeywords(parsed.query);
      if (constraintHints.length >= MIN_CONSTRAINTS_FOR_STAGED_HINT) {
        obs += `\n[감지된 조건 ${constraintHints.length}개: ${constraintHints.join(', ')}. 결과가 부족하면 조건을 하나씩 제거하며 재검색하세요.]`;
      }

      // Corrective RAG quality tag: structured annotation that classifies retrieval
      // quality so the agent can reliably decide whether to retry with relaxed constraints.
      // "partial" = results returned but count is low (1–2) with multi-constraint query —
      // agent should consider relaxing a NICE-TO-HAVE constraint before answering.
      // "reliable" = ≥3 results or no multi-constraint pressure.
      const qualityTag = (
        response.results.length < MIN_RESULTS_FOR_RELIABLE_QUALITY &&
        constraintHints.length >= MIN_CONSTRAINTS_FOR_STAGED_HINT
      )
        ? '[RETRIEVAL_QUALITY: partial — consider relaxing one NICE-TO-HAVE constraint before answering]'
        : '[RETRIEVAL_QUALITY: reliable]';
      obs = `${qualityTag}\n${obs}`;

      // Price filter context: when max_price_krw was applied, annotate observation
      // so the agent can state "예산 범위 내 검색 결과" even when per-wine prices
      // are missing from the index. This prevents judge=0 for price-constrained
      // scenarios where priceRange is sparse.
      if (parsed.max_price_krw !== undefined) {
        obs += `\n[PRICE_FILTER: 검색 결과는 ${parsed.max_price_krw}원 이하로 필터링되었습니다.]`;
      }

      return {
        observation: obs,
        rawResult: response,
      };
    }

    case 'compare_wines': {
      const parseResult = CompareInputSchema.safeParse(stripNulls(input));
      if (!parseResult.success) {
        return { observation: `Invalid input for compare_wines: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;
      if (deps.decomposedSearchExecute === undefined) {
        return { observation: 'Compare tool not available.', rawResult: null };
      }
      const response = await deps.decomposedSearchExecute(
        [parsed.query_a, parsed.query_b],
        'compare',
        `${parsed.query_a} vs ${parsed.query_b}`,
        requestId,
        Date.now(),
      );
      return {
        observation: summarizeComparison(response),
        rawResult: response,
      };
    }

    case 'check_drinking_window': {
      const parseResult = DrinkingWindowInputSchema.safeParse(stripNulls(input));
      if (!parseResult.success) {
        return { observation: `Invalid input for check_drinking_window: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;
      const targetYear = parsed.target_year ?? new Date().getFullYear();

      // Prefer direct entity lookup (O(1) Vespa GET) over the full search
      // pipeline (planner → retrieval → ranking → decision). The search-as-lookup
      // approach was fundamentally broken: it used the entity_id as a natural-language
      // query, which ran NL parsing, fuzzy matching, and ranking on an opaque ID.
      if (deps.entityLookup !== undefined) {
        const entityId = createCanonicalEntityId(parsed.entity_id);
        const doc = await deps.entityLookup(entityId);
        if (doc === undefined) {
          return { observation: `Wine ${parsed.entity_id} not found.`, rawResult: null };
        }
        const start = doc.drinkingWindowStart;
        const end = doc.drinkingWindowEnd;
        if (start !== undefined && end !== undefined) {
          const currentlyDrinkable = targetYear >= start && targetYear <= end;
          const dw: DrinkingWindowBlock = {
            drinkingWindowStart: start,
            drinkingWindowEnd: end,
            currentlyDrinkable,
            confidence: 'medium',
            ...(doc.drinkingWindowModelVersion !== undefined
              ? { modelVersion: doc.drinkingWindowModelVersion }
              : {}),
          };
          const statusLabel = currentlyDrinkable
            ? `currently drinkable (peak: ${start}–${end})`
            : targetYear < start
              ? `not yet at peak — hold until ${start}`
              : `past peak (window closed ${end})`;
          return {
            observation: `${sanitizeObservationField(doc.canonicalLabel)}: drinking window ${start}-${end}. As of ${targetYear}: ${statusLabel}.`,
            rawResult: dw,
          };
        }
        return {
          observation: `${sanitizeObservationField(doc.canonicalLabel)}: no drinking window data available.`,
          rawResult: null,
        };
      }

      // Fallback: search-as-lookup when entityLookup port is not wired.
      const searchResult = await deps.searchUseCase.execute(
        { query: parsed.entity_id, options: { mode: 'entity', explain: false, clarification: false } },
        requestId,
        { ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}) },
      );
      const firstResult = searchResult.queryType === 'search' ? searchResult.results[0] : undefined;
      if (firstResult === undefined) {
        return { observation: `Wine ${parsed.entity_id} not found.`, rawResult: null };
      }
      const dw = firstResult.drinkingWindow;
      if (dw !== undefined) {
        const statusLabelFallback = dw.currentlyDrinkable
          ? `currently drinkable (peak: ${dw.drinkingWindowStart}–${dw.drinkingWindowEnd})`
          : targetYear < dw.drinkingWindowStart
            ? `not yet at peak — hold until ${dw.drinkingWindowStart}`
            : `past peak (window closed ${dw.drinkingWindowEnd})`;
        return {
          observation: `${sanitizeObservationField(firstResult.entity.canonicalLabel)}: drinking window ${dw.drinkingWindowStart}-${dw.drinkingWindowEnd}. As of ${targetYear}: ${statusLabelFallback}. Confidence: ${dw.confidence}`,
          rawResult: dw,
        };
      }
      return {
        observation: `${sanitizeObservationField(firstResult.entity.canonicalLabel)}: no drinking window data available.`,
        rawResult: null,
      };
    }

    case 'get_food_pairings': {
      const parseResult = FoodPairingInputSchema.safeParse(stripNulls(input));
      if (!parseResult.success) {
        return { observation: `Invalid input for get_food_pairings: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;
      // Prefer explicit KRW budget; fall back to legacy USD field (converted).
      const budgetKrw = parsed.max_price_krw
        ?? (
          parsed.max_price !== undefined
            ? (() => {
                const converted = parsed.max_price * KRW_PER_USD_APPROXIMATE;
                // Guard against overflow (e.g. max_price = Number.MAX_VALUE → Infinity).
                // Clamp to MAX_PRICE_KRW_BOUND so the query never contains "Infinity원 이하".
                return Number.isFinite(converted)
                  ? Math.min(Math.round(converted), MAX_PRICE_KRW_BOUND)
                  : undefined;
              })()
            : undefined
        );
      const queryBase = `wines for ${parsed.food}${parsed.color ? ` ${parsed.color}` : ''}`;
      const query = appendStructuredQueryClauses(
        queryBase,
        budgetKrw !== undefined ? [`${budgetKrw}원 이하`] : [],
      );
      const responseWithContext = await deps.searchUseCase.execute(
        { query },
        requestId,
        { ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}) },
      );

      if (responseWithContext.queryType !== 'search') {
        return { observation: 'Unexpected response type for pairing search.', rawResult: responseWithContext };
      }
      // Enrich with pairing context so the LLM gives a richer answer that
      // explains WHY each wine pairs with the food (not just "here are results").
      const baseObs = summarizeSearchResults(responseWithContext);
      const pairingHint = [
        '',
        `PAIRING_CONTEXT: These wines were matched for "${parsed.food}" pairing.`,
        'When synthesizing your answer, explain WHY each wine pairs well with the food (acidity, tannin, body, flavour bridge).',
        'Include practical serving suggestions (temperature, decanting) if relevant.',
      ].join('\n');
      return {
        observation: baseObs + pairingHint,
        rawResult: responseWithContext,
      };
    }

    default:
      return { observation: `Unknown tool: ${toolName}`, rawResult: null };
  }
}

// ---------------------------------------------------------------------------
// Observation summarizers (compact for LLM context)
// ---------------------------------------------------------------------------

/**
 * Indirect prompt-injection defense for tool observations (Spotlighting,
 * Hines et al. 2024). Escapes instruction-look-alike tokens that could appear
 * in wine database fields (label, producer, region, etc.) and attempt to
 * hijack the LLM via role/system markers.
 *
 * The fields we sanitize are NOT user input — they come from the wine database
 * — but they can be poisoned at the data layer (e.g., a malicious producer name
 * in a scraped review). This is the "indirect prompt injection" attack vector
 * (Greshake et al. 2023; OWASP LLM Top 10 2025 #1).
 *
 * Escape strategy:
 *   1. ChatML role markers (<|im_start|>, <|im_end|>, <|system|>) — replace with [REDACTED_MARKER]
 *   2. Square-bracket directives ([SYSTEM:, [INST:, [/INST]) — replace with safe form
 *   3. XML-style instruction tags (<system>, <instructions>) — replace with [REDACTED]
 *   4. Newlines that could break out of the pipe-delimited line format — replace with space
 *
 * The function preserves wine semantics (region names, producer names) while
 * removing structural markers that the LLM treats as control tokens.
 */
/**
 * Unicode bidi / invisible control characters that can reorder or hide injection
 * text inside an otherwise innocuous-looking field. Greshake et al. 2023
 * (indirect prompt injection) and OWASP LLM01 both flag bidi-override attacks.
 * All these codepoints are stripped before any other sanitization.
 */
const BIDI_INVISIBLE_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/gu;

function sanitizeObservationField(value: string): string {
  // NFKC normalization: compatibility-decompose fullwidth / mathematical / stylistic
  // Latin variants so evasion via e.g. "ⅰgnore" or "ＳＹＳＴＥＭ" cannot bypass the
  // regex filters below. NFKC is the form OpenAI's moderation and most LLM tokenizers
  // canonicalize to, so normalizing here aligns us with the downstream view.
  const normalized = value.normalize('NFKC').replace(BIDI_INVISIBLE_CHARS, '');
  // All boundary checks use Unicode-aware non-letter/non-number lookarounds
  // (`(?![\p{L}\p{N}])` / `(?:^|[^\p{L}\p{N}])`) with the /u flag. \b is
  // ASCII-only and silently fails across 한글/accented Latin (CLAUDE.md rule 8).
  return normalized
    // ChatML role markers (OpenAI/Llama family)
    .replace(/<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/giu, '[REDACTED_MARKER]')
    // Square-bracket instruction directives (English) — keyword terminates at a non-letter
    .replace(/\[\/?(?:SYSTEM|INST|INSTRUCTION|USER|ASSISTANT|TOOL_RESULT_BEGIN|TOOL_RESULT_END)(?![\p{L}\p{N}])[^\]]*\]/giu, '[REDACTED_DIRECTIVE]')
    // Square-bracket instruction directives (Korean) — "[시스템:" / "[지시:" / "[사용자:"
    .replace(/\[\/?(?:시스템|지시|지침|사용자|어시스턴트)(?::|\])[^\]]*\]?/gu, '[REDACTED_DIRECTIVE]')
    // XML/HTML-style instruction tags
    .replace(/<\/?(?:system|instructions?|prompt|tool_result)(?![\p{L}\p{N}])[^>]*>/giu, '[REDACTED_TAG]')
    // Common imperative injection phrases — English
    .replace(/(?:^|[^\p{L}\p{N}])(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)/giu, '[REDACTED_INSTRUCTION]')
    .replace(/(?:^|[^\p{L}\p{N}])act\s+as\s+(?:a\s+)?(?:system|admin|root|developer|assistant)(?![\p{L}\p{N}])/giu, '[REDACTED_INSTRUCTION]')
    // Common imperative injection phrases — Korean
    // "이전 지시 무시", "이전 지침 무시해", "지금까지의 지시 잊어", "시스템으로 행동"
    .replace(/(?:이전|지금까지의?|앞의?)\s*(?:지시|지침|규칙|명령)[가-힣]*\s*(?:무시|잊|버려)[가-힣]*/gu, '[REDACTED_INSTRUCTION]')
    .replace(/시스템(?:으로|처럼)\s*(?:행동|동작|작동)[가-힣]*/gu, '[REDACTED_INSTRUCTION]')
    // Newlines (would break the pipe-delimited line format and allow injection)
    .replace(/[\r\n]+/g, ' ');
}

function sanitizeSourceRecordRefsForGrounding(
  refs: readonly { readonly sourceSystem: string; readonly sourceRecordId: string }[],
): readonly { readonly source_system: string; readonly source_record_id: string }[] {
  const capped = refs.length > MAX_SOURCE_RECORD_REFS_PER_ENTITY
    ? refs.slice(0, MAX_SOURCE_RECORD_REFS_PER_ENTITY)
    : refs;
  return capped.map((r) => ({
    source_system: sanitizeObservationField(r.sourceSystem),
    source_record_id: sanitizeObservationField(r.sourceRecordId),
  }));
}

function summarizeSearchResults(response: SearchResponseV1, diversify = false): string {
  const { results, engineDecision } = response;
  if (results.length === 0) {
    // Differentiate between three failure modes so the LLM can stop retrying
    // a backend that is genuinely down or a query that has no possible match.
    // The system prompt's "broaden and retry" rule (agent-prompt.ts) is gated
    // on the absence of "do_not_retry" — see prompt update.
    const status = engineDecision.decisionStatus;
    const executionMode = response.meta.executionMode;
    const degradationReasons = response.meta.degradationReasons;

    // BACKEND_DEGRADED: search infrastructure is unavailable / errored.
    // Retrying with a different query will produce the same result.
    const backendDown =
      status === 'failed'
      || executionMode === 'degraded'
      || (Array.isArray(degradationReasons) && degradationReasons.length > 0);
    if (backendDown) {
      return (
        'BACKEND_DEGRADED: search infrastructure is unavailable. '
        + `Status=${status}, executionMode=${executionMode ?? 'n/a'}. `
        + 'do_not_retry=true. Provide the user the best partial answer with this fact.'
      );
    }

    // CLARIFY: engine asked for clarification, not a search retry.
    if (engineDecision.nextAction === 'clarify') {
      return (
        'CLARIFY_REQUIRED: query was ambiguous. '
        + 'do_not_retry=true. Ask the user a single targeted clarification question.'
      );
    }

    // NO_MATCH: search ran successfully but the corpus has nothing matching.
    // The agent MAY broaden the query ONCE if the original was over-constrained.
    return (
      `NO_MATCH: search ran successfully (status=${status}) but found no wines. `
      + 'May retry once with a broader query if the original had multiple constraints. '
      + 'Otherwise tell the user no match exists.'
    );
  }

  // Optional producer-level dedup for diversity requests
  let displayResults = results;
  if (diversify && results.length > 3) {
    const seen = new Set<string>();
    displayResults = results.filter((r) => {
      const key = r.entity.producer ?? r.entity.entityId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const lines = displayResults.slice(0, SUMMARY_TOP_N).map((r, i) => {
    // v5: sanitize all string fields against indirect prompt injection
    // (Spotlighting pattern). Numeric/structured fields are not sanitized
    // because they cannot carry instruction markers.
    const parts = [
      `${i + 1}. ${sanitizeObservationField(r.entity.canonicalLabel)}`,
      `(id: ${r.entity.entityId})`,
    ];
    if (r.entity.producer) parts.push(`producer: ${sanitizeObservationField(r.entity.producer)}`);
    if (r.entity.region) parts.push(`region: ${sanitizeObservationField(r.entity.region)}`);
    if (r.entity.vintage) parts.push(`vintage: ${r.entity.vintage}`);
    if (r.entity.grapes !== undefined && r.entity.grapes.length > 0) {
      parts.push(`grapes: ${r.entity.grapes.slice(0, 3).map(sanitizeObservationField).join(', ')}`);
    }
    if (r.entity.style) parts.push(`style: ${sanitizeObservationField(r.entity.style)}`);
    if (r.entity.criticScore !== undefined && Number.isFinite(r.entity.criticScore)) parts.push(`critic: ${(r.entity.criticScore * 100).toFixed(0)}/100`);
    if (r.entity.alcoholPct !== undefined) parts.push(`alc: ${r.entity.alcoholPct}%`);
    if (r.entity.priceRange !== undefined) {
      parts.push(`price: ${sanitizeObservationField(r.entity.priceRange)}`);
    }
    if (r.drinkingWindow) {
      parts.push(`drink: ${r.drinkingWindow.drinkingWindowStart}-${r.drinkingWindow.drinkingWindowEnd}`);
    }
    if (r.entity.sourceRecordRefs !== undefined && r.entity.sourceRecordRefs.length > 0) {
      const shown = r.entity.sourceRecordRefs.slice(0, AGENT_OBSERVATION_SOURCE_RECORD_REFS_MAX);
      const refText = shown
        .map((ref) =>
          `${sanitizeObservationField(ref.sourceSystem)}:${sanitizeObservationField(ref.sourceRecordId)}`,
        )
        .join(', ');
      const suffix = r.entity.sourceRecordRefs.length > AGENT_OBSERVATION_SOURCE_RECORD_REFS_MAX ? ',…' : '';
      parts.push(`lineage: ${refText}${suffix}`);
    }
    return parts.join(' | ');
  });

  const summary = `Found ${results.length} results (showing top ${Math.min(SUMMARY_TOP_N, displayResults.length)}):\n${lines.join('\n')}`;
  return `${summary}\n${buildGroundingJsonFromSearch(response, displayResults)}`;
}

function summarizeComparison(response: ComparisonSearchResponse): string {
  // Cap at 2 sides: compare_wines is defined as a 2-wine tool; guard against
  // unexpected backend responses with more entities to prevent context window bloat.
  const sides = response.entities.slice(0, 2).map((e) => {
    const top = e.topResult;
    if (top === null) return `${sanitizeObservationField(e.subQuery)}: no result (status: ${e.resolutionStatus})`;
    // v5: sanitize all string fields against indirect prompt injection
    const parts = [
      `${sanitizeObservationField(e.subQuery)}: ${sanitizeObservationField(top.entity.canonicalLabel)}`,
      `entity_id: ${top.entity.entityId}`,
    ];
    if (top.entity.producer) parts.push(`producer: ${sanitizeObservationField(top.entity.producer)}`);
    if (top.entity.region) parts.push(`region: ${sanitizeObservationField(top.entity.region)}`);
    if (top.entity.vintage) parts.push(`vintage: ${top.entity.vintage}`);
    if (top.entity.grapes !== undefined && top.entity.grapes.length > 0) {
      parts.push(`grapes: ${top.entity.grapes.slice(0, 3).map(sanitizeObservationField).join(', ')}`);
    }
    if (top.entity.style) parts.push(`style: ${sanitizeObservationField(top.entity.style)}`);
    if (top.entity.criticScore !== undefined && Number.isFinite(top.entity.criticScore)) parts.push(`critic: ${(top.entity.criticScore * 100).toFixed(0)}/100`);
    if (top.entity.alcoholPct !== undefined) parts.push(`alc: ${top.entity.alcoholPct}%`);
    if (top.entity.priceRange !== undefined) {
      parts.push(`price: ${sanitizeObservationField(top.entity.priceRange)}`);
    }
    if (top.drinkingWindow) {
      parts.push(`drink: ${top.drinkingWindow.drinkingWindowStart}-${top.drinkingWindow.drinkingWindowEnd}`);
    }
    if (top.entity.sourceRecordRefs !== undefined && top.entity.sourceRecordRefs.length > 0) {
      const shown = top.entity.sourceRecordRefs.slice(0, AGENT_OBSERVATION_SOURCE_RECORD_REFS_MAX);
      const refText = shown
        .map((ref) =>
          `${sanitizeObservationField(ref.sourceSystem)}:${sanitizeObservationField(ref.sourceRecordId)}`,
        )
        .join(', ');
      const suffix = top.entity.sourceRecordRefs.length > AGENT_OBSERVATION_SOURCE_RECORD_REFS_MAX ? ',…' : '';
      parts.push(`lineage: ${refText}${suffix}`);
    }
    parts.push(`match: ${top.match.matchType}`);
    return parts.join(' | ');
  });

  // Build a rich observation that explicitly signals completion so the agent
  // doesn't thrash by calling search_wines for individual wines that are already
  // fully described above. The previous 2-line sparse observation lacked this
  // closure signal, causing the LLM to chain 2-3 unnecessary search_wines calls
  // ("let me look up more details on Side A...") which burned 15-25 seconds.
  const summary = [
    `Comparison (${response.comparisonIntent}):`,
    `Side A: ${sides[0]}`,
    `Side B: ${sides[1]}`,
    '',
    'COMPARISON_COMPLETE: Both wines are fully described above. You now have ALL data needed to synthesize your comparison answer. Do NOT call search_wines — the comparison result already contains everything.',
  ];
  return `${summary.join('\n')}\n${buildGroundingJsonFromComparison(response)}`;
}

interface GroundingWineFact {
  readonly entity_id: string;
  readonly canonical_label: string;
  readonly producer?: string;
  readonly region?: string;
  readonly vintage?: number;
  readonly grapes?: readonly string[];
  readonly style?: string;
  readonly critic_score_100?: number;
  readonly price?: string;
  /** Upstream lineage keys (sanitized); not public entity identifiers. */
  readonly source_record_refs?: readonly {
    readonly source_system: string;
    readonly source_record_id: string;
  }[];
}

function buildGroundingJsonFromSearch(
  response: SearchResponseV1,
  displayResults: readonly SearchResponseV1['results'][number][],
): string {
  const facts: GroundingWineFact[] = displayResults.slice(0, SUMMARY_TOP_N).map((r) => {
    const base: GroundingWineFact = {
      entity_id: r.entity.entityId,
      canonical_label: sanitizeObservationField(r.entity.canonicalLabel),
      ...(r.entity.producer !== undefined ? { producer: sanitizeObservationField(r.entity.producer) } : {}),
      ...(r.entity.region !== undefined ? { region: sanitizeObservationField(r.entity.region) } : {}),
      ...(r.entity.vintage !== undefined ? { vintage: r.entity.vintage } : {}),
      ...(r.entity.grapes !== undefined
        ? { grapes: r.entity.grapes.slice(0, 3).map((g) => sanitizeObservationField(g)) }
        : {}),
      ...(r.entity.style !== undefined ? { style: sanitizeObservationField(r.entity.style) } : {}),
      ...(r.entity.criticScore !== undefined && Number.isFinite(r.entity.criticScore) ? { critic_score_100: Math.round(r.entity.criticScore * 100) } : {}),
      ...(r.entity.priceRange !== undefined ? { price: sanitizeObservationField(r.entity.priceRange) } : {}),
      ...(r.entity.sourceRecordRefs !== undefined && r.entity.sourceRecordRefs.length > 0
        ? { source_record_refs: sanitizeSourceRecordRefsForGrounding(r.entity.sourceRecordRefs) }
        : {}),
    };
    return base;
  });

  return `GROUNDING_JSON: ${JSON.stringify({
    query_type: response.queryType,
    total_results: response.results.length,
    wines: facts,
  })}`;
}

function buildGroundingJsonFromComparison(response: ComparisonSearchResponse): string {
  const wines: GroundingWineFact[] = response.entities
    .slice(0, 2)
    .flatMap((entry) => {
      const top = entry.topResult;
      if (top === null) return [];
      const fact: GroundingWineFact = {
        entity_id: top.entity.entityId,
        canonical_label: sanitizeObservationField(top.entity.canonicalLabel),
        ...(top.entity.producer !== undefined ? { producer: sanitizeObservationField(top.entity.producer) } : {}),
        ...(top.entity.region !== undefined ? { region: sanitizeObservationField(top.entity.region) } : {}),
        ...(top.entity.vintage !== undefined ? { vintage: top.entity.vintage } : {}),
        ...(top.entity.grapes !== undefined
          ? { grapes: top.entity.grapes.slice(0, 3).map((g) => sanitizeObservationField(g)) }
          : {}),
        ...(top.entity.style !== undefined ? { style: sanitizeObservationField(top.entity.style) } : {}),
        ...(top.entity.criticScore !== undefined && Number.isFinite(top.entity.criticScore) ? { critic_score_100: Math.round(top.entity.criticScore * 100) } : {}),
        ...(top.entity.priceRange !== undefined ? { price: sanitizeObservationField(top.entity.priceRange) } : {}),
        ...(top.entity.sourceRecordRefs !== undefined && top.entity.sourceRecordRefs.length > 0
          ? { source_record_refs: sanitizeSourceRecordRefsForGrounding(top.entity.sourceRecordRefs) }
          : {}),
      };
      return [fact];
    });

  return `GROUNDING_JSON: ${JSON.stringify({
    query_type: 'comparison',
    total_results: wines.length,
    wines,
  })}`;
}
