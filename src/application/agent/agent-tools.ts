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
import type { SearchExecutorPort } from '../search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import { createEntityId } from '../../domain/shared/types/index.js';
import { KRW_PER_USD_APPROXIMATE } from '../../domain/shared/constants.js';
import type { RetrievalDocument } from '../../domain/retrieval/model/retrieval-document.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';

// ---------------------------------------------------------------------------
// Schema bounds — named constants so lint catches accidental magic numbers
// ---------------------------------------------------------------------------

/** Max characters for a search query string passed to the tool. */
const SEARCH_QUERY_MAX_LEN = 500;
/** Max results the agent can request in a single search call. */
const SEARCH_LIMIT_MAX = 20;
/** Max KRW price the agent can filter on (~100M KRW, safely above any real wine). */
const MAX_PRICE_KRW_BOUND = 100_000_000;
/** Top-N results shown in the observation string (controls context window usage). */
const SUMMARY_TOP_N = 5;
/** Max characters in any single observation string returned to the agent loop.
 * Truncation prevents a single tool result from exhausting the agent's token budget.
 * ~2000 chars ≈ 500 tokens (at 4 chars/token) — enough for 5 wine summaries. */
const MAX_OBSERVATION_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Input schemas (same as tool-schemas.ts — reusing patterns)
// ---------------------------------------------------------------------------

const SearchInputSchema = z.object({
  query: z.string().min(1).max(SEARCH_QUERY_MAX_LEN),
  // .int() implies finite (no NaN/Infinity) per Zod semantics; .min/.max add domain bounds
  limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
  retrieval_mode: z.enum(['auto', 'entity', 'hybrid', 'mixed']).optional(),
  /** Grape varieties to exclude from results (e.g. ["Cabernet Sauvignon", "Merlot"]). */
  exclude_grapes: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  /** Countries/regions to exclude (e.g. ["France", "프랑스"]). */
  exclude_regions: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  /** Maximum price in KRW. Agent can pass "$50" style — normalized below. */
  max_price_krw: z.number().int().min(0).max(MAX_PRICE_KRW_BOUND).optional(),
});

const CompareInputSchema = z.object({
  query_a: z.string().min(1).max(SEARCH_QUERY_MAX_LEN),
  query_b: z.string().min(1).max(SEARCH_QUERY_MAX_LEN),
});

/** Max length for entity_id to prevent unbounded strings reaching Vespa GET / NL parser.
 * Vespa document IDs are typically ≤200 chars; 500 is a conservative upper bound. */
const ENTITY_ID_MAX_LEN = 500;
/** Conservative lower bound for valid wine drinking-window years. */
const DRINKING_WINDOW_MIN_YEAR = 1700;
/** Conservative upper bound for valid wine drinking-window years. */
const DRINKING_WINDOW_MAX_YEAR = 2200;

const DrinkingWindowInputSchema = z.object({
  entity_id: z.string().min(1).max(ENTITY_ID_MAX_LEN),
  target_year: z.number().int().min(DRINKING_WINDOW_MIN_YEAR).max(DRINKING_WINDOW_MAX_YEAR).optional(),
});

/** Max food description length — prevents unbounded strings in the food pairing query.
 * Food pairing queries are short (e.g. "steak", "파스타"); 200 chars is generous. */
const FOOD_MAX_LEN = 200;

const FoodPairingInputSchema = z.object({
  food: z.string().min(1).max(FOOD_MAX_LEN),
  /** Budget in Korean Won (KRW). Use this instead of USD amounts. */
  max_price_krw: z.number().int().min(0).max(MAX_PRICE_KRW_BOUND).optional(),
  /** Legacy USD price field — accepted for backwards compat but converted internally. */
  max_price: z.number().finite().min(0).optional(),
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
  readonly entityLookup?: ((id: EntityId) => Promise<RetrievalDocument | undefined>) | undefined;
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
 * Maximum length of the enriched query string (original query + appended exclusion/price params).
 * The base query is max 500 chars; exclusion/price params can add ~200 chars.
 * Domain rationale: Vespa YQL parser has a 4 KB query limit; downstream NL parser
 * has its own 700-char soft limit for reliable constraint extraction.
 */
const MAX_ENRICHED_QUERY_LEN = 700;

/** Regex for diversity-intent detection. Korean included → /u flag required (rule 8). */
const WANTS_DIVERSITY_RE = /(?:diverse|different|다른|다르게|각각|variety)/iu;

/**
 * Keyword → label pairs for constraint detection.
 * Module-scope to avoid per-call allocation (deterministic, never changes).
 * All Korean patterns use /u flag and avoid \b (ASCII-only boundary).
 */
const CONSTRAINT_KEYWORDS: ReadonlyArray<[RegExp, string]> = [
  // Sensory attributes — require adjacent Korean context or full English words
  // to avoid matching unrelated words (e.g. /oak/ matching "Oakville" region).
  [/타닌|(?<![a-z])tannin(?![a-z])/iu, '타닌'],
  [/과일향|(?<![a-z])fruity(?![a-z])|(?<![a-z])fruit(?![a-z])/iu, '과일향'],
  // '오크' is rare as a standalone Korean word outside wine context; "oak" scoped to
  // prevent matching place names like "Oakville", "Oakland" — require non-alpha boundary.
  [/오크(?!빌|랜드|먼트)|(?<![a-zA-Z])oak(?:ed|ing|y)?(?![a-zA-Z])/iu, '오크'],
  [/미네랄|(?<![a-z])mineral/iu, '미네랄'],
  // '산도' is safe (wine-specific); "acid" scoped to word boundary equivalent
  [/산도|(?<![a-z])acid(?:ic|ity|s)?(?![a-z])/iu, '산도'],
  // '바디' safe; "body" scoped to avoid "somebody", "everybody" etc.
  [/바디감?|(?<![a-z])body(?![a-z])/iu, '바디'],
  // '당도' safe; "sweet" scoped to avoid "sweetspot", "sweetheart" etc.
  [/당도|(?<![a-z])sweet(?:ness|ish)?(?![a-zA-Z])/iu, '당도'],
  // Price — numeric-anchored, safe
  [/[0-9]+\s*만?\s*원|[$€]\s*[0-9]+/u, '가격'],
  [/비건|(?<![a-z])vegan(?![a-z])/iu, '비건'],
  [/유기농|(?<![a-z])organic(?![a-z])/iu, '유기농'],
  // Vintage — numeric-anchored, safe
  [/[0-9]{4}\s*년|(?<![a-z])vintage\s+[0-9]{4}/iu, '빈티지'],
  // Country names — safe (proper nouns, distinct)
  [/이탈리아|프랑스|스페인|독일|한국|(?<![a-z])italy|france|spain|germany(?![a-z])/iu, '국가'],
  // Wine type — safe (domain-specific terms)
  [/레드|화이트|스파클링|로제|(?<![a-z])red|white|sparkling|ros[eé](?![a-z])/iu, '와인타입'],
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
  return `${baseQuery}, ${clauses.join(', ')}`;
}

function buildStructuredSearchClauses(input: {
  readonly exclude_grapes?: readonly string[] | undefined;
  readonly exclude_regions?: readonly string[] | undefined;
  readonly max_price_krw?: number | undefined;
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
  return clauses;
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
): Promise<AgentToolResult> {
  try {
    const result = await executeAgentToolInner(toolName, input, deps, requestId);
    return { ...result, observation: capObservation(result.observation) };
  } catch (err) {
    // Policy-block errors MUST propagate — they are security decisions, not
    // tool failures. Re-throw so the orchestrator can terminate the loop.
    if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
      throw err;
    }
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
): Promise<readonly AgentToolResult[]> {
  return Promise.all(
    toolCalls.map((call, i) =>
      executeAgentTool(call.tool, call.input, deps, `${baseRequestId}-p${i}`),
    ),
  );
}

async function executeAgentToolInner(
  toolName: string,
  input: Record<string, unknown>,
  deps: AgentToolDeps,
  requestId: string,
): Promise<AgentToolResult> {
  switch (toolName) {
    case 'search_wines': {
      const parseResult = SearchInputSchema.safeParse(input);
      if (!parseResult.success) {
        return { observation: `Invalid input for search_wines: ${parseResult.error.issues.map((i) => i.message).join(', ')}`, rawResult: null };
      }
      const parsed = parseResult.data;

      // Enrich query with structured exclusion/price params so the existing
      // search pipeline (which understands natural language) applies them.
      let enrichedQuery = appendStructuredQueryClauses(parsed.query, buildStructuredSearchClauses(parsed));

      if (enrichedQuery.length > MAX_ENRICHED_QUERY_LEN) {
        enrichedQuery = enrichedQuery.slice(0, MAX_ENRICHED_QUERY_LEN);
      }

      const response = await deps.searchUseCase.execute(
        {
          query: enrichedQuery,
          ...(parsed.retrieval_mode !== undefined
            ? { options: { mode: parsed.retrieval_mode, explain: false, clarification: false } }
            : {}),
        },
        requestId,
      );

      if (response.queryType === 'comparison') {
        return {
          observation: summarizeComparison(response),
          rawResult: response,
        };
      }

      // Activate diversity dedup when query contains diversity hints (WANTS_DIVERSITY_RE is module-scope)
      const wantsDiversity = WANTS_DIVERSITY_RE.test(parsed.query);

      // Negation post-filter: exclude results whose identity fields contain negated terms.
      // Checks canonicalLabel, grapes array, and all NEGATION_ENTITY_STRING_FIELDS.
      const negTerms = collectExcludedTerms(parsed);
      if (negTerms.length > 0) {
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
          return !negTerms.some((term) => {
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
            return re.test(check);
          });
        });
        if (filtered.length < response.results.length) {
          const filteredResponse = { ...response, results: filtered } as typeof response;
          if (filtered.length === 0) {
            return {
              observation: `검색 결과가 없습니다 (${response.results.length}개가 제외 조건과 일치). 검색어: "${parsed.query}". 힌트: 조건을 하나씩 줄여서 재검색하세요 (예: 가격 조건 제거 → 품종만으로 재검색).`,
              rawResult: filteredResponse,
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

      // Zero-result escalation: guide the agent to relax constraints one by one.
      if (response.results.length === 0) {
        return {
          observation: `검색 결과가 없습니다. 검색어: "${parsed.query}". 힌트: 조건을 하나씩 줄여서 재검색하세요 (예: 가격 조건 제거 → 품종만으로 재검색).`,
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

      return {
        observation: obs,
        rawResult: response,
      };
    }

    case 'compare_wines': {
      const parseResult = CompareInputSchema.safeParse(input);
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
      const parseResult = DrinkingWindowInputSchema.safeParse(input);
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
        const entityId = createEntityId(parsed.entity_id);
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
            observation: `${doc.canonicalLabel}: drinking window ${start}-${end}. As of ${targetYear}: ${statusLabel}.`,
            rawResult: dw,
          };
        }
        return {
          observation: `${doc.canonicalLabel}: no drinking window data available.`,
          rawResult: null,
        };
      }

      // Fallback: search-as-lookup when entityLookup port is not wired.
      const searchResult = await deps.searchUseCase.execute(
        { query: parsed.entity_id, options: { mode: 'entity', explain: false, clarification: false } },
        requestId,
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
          observation: `${firstResult.entity.canonicalLabel}: drinking window ${dw.drinkingWindowStart}-${dw.drinkingWindowEnd}. As of ${targetYear}: ${statusLabelFallback}. Confidence: ${dw.confidence}`,
          rawResult: dw,
        };
      }
      return {
        observation: `${firstResult.entity.canonicalLabel}: no drinking window data available.`,
        rawResult: null,
      };
    }

    case 'get_food_pairings': {
      const parseResult = FoodPairingInputSchema.safeParse(input);
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
      const response = await deps.searchUseCase.execute({ query }, requestId);

      if (response.queryType !== 'search') {
        return { observation: 'Unexpected response type for pairing search.', rawResult: response };
      }
      // Enrich with pairing context so the LLM gives a richer answer that
      // explains WHY each wine pairs with the food (not just "here are results").
      const baseObs = summarizeSearchResults(response);
      const pairingHint = [
        '',
        `PAIRING_CONTEXT: These wines were matched for "${parsed.food}" pairing.`,
        'When synthesizing your answer, explain WHY each wine pairs well with the food (acidity, tannin, body, flavour bridge).',
        'Include practical serving suggestions (temperature, decanting) if relevant.',
      ].join('\n');
      return {
        observation: baseObs + pairingHint,
        rawResult: response,
      };
    }

    default:
      return { observation: `Unknown tool: ${toolName}`, rawResult: null };
  }
}

// ---------------------------------------------------------------------------
// Observation summarizers (compact for LLM context)
// ---------------------------------------------------------------------------

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
    const parts = [
      `${i + 1}. ${r.entity.canonicalLabel}`,
      `(id: ${r.entity.entityId})`,
    ];
    if (r.entity.producer) parts.push(`producer: ${r.entity.producer}`);
    if (r.entity.region) parts.push(`region: ${r.entity.region}`);
    if (r.entity.vintage) parts.push(`vintage: ${r.entity.vintage}`);
    // Grapes: helps agent verify negation constraints and give richer answers
    if (r.entity.grapes !== undefined && r.entity.grapes.length > 0) {
      parts.push(`grapes: ${r.entity.grapes.slice(0, 3).join(', ')}`);
    }
    // Price: agents need price context for budget recommendations
    if (r.entity.priceRange !== undefined) {
      parts.push(`price: ${r.entity.priceRange}`);
    }
    if (r.drinkingWindow) {
      parts.push(`drink: ${r.drinkingWindow.drinkingWindowStart}-${r.drinkingWindow.drinkingWindowEnd}`);
    }
    return parts.join(' | ');
  });

  return `Found ${results.length} results (showing top ${Math.min(SUMMARY_TOP_N, displayResults.length)}):\n${lines.join('\n')}`;
}

function summarizeComparison(response: ComparisonSearchResponse): string {
  const sides = response.entities.map((e) => {
    const top = e.topResult;
    if (top === null) return `${e.subQuery}: no result (status: ${e.resolutionStatus})`;
    const parts = [
      `${e.subQuery}: ${top.entity.canonicalLabel}`,
      `entity_id: ${top.entity.entityId}`,
    ];
    if (top.entity.producer) parts.push(`producer: ${top.entity.producer}`);
    if (top.entity.region) parts.push(`region: ${top.entity.region}`);
    if (top.entity.vintage) parts.push(`vintage: ${top.entity.vintage}`);
    if (top.entity.grapes !== undefined && top.entity.grapes.length > 0) {
      parts.push(`grapes: ${top.entity.grapes.slice(0, 3).join(', ')}`);
    }
    if (top.entity.priceRange !== undefined) {
      parts.push(`price: ${top.entity.priceRange}`);
    }
    if (top.drinkingWindow) {
      parts.push(`drink: ${top.drinkingWindow.drinkingWindowStart}-${top.drinkingWindow.drinkingWindowEnd}`);
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
  return summary.join('\n');
}
