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
import { coercePositiveInt } from '../../domain/shared/utils/zod-coerce.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { SearchExecutorPort } from '../search/port/search-executor.port.js';
import type {
  DecomposedSearchExecutionOptions,
  DecomposedSearchParentContext,
} from '../search/port/search-route-usecases.port.js';
import { createStageTimer } from '../../domain/shared/stage-timer.js';
import {
  buildCompareToolFieldShape,
  buildSearchToolStructuredPreferences,
  buildEntityIdToolField,
  buildFoodPairingFieldShape,
  buildSearchToolQueryField,
  buildSearchToolFieldShape,
  SEARCH_TOOL_MAX_STYLES,
  sanitizeOptionalToolNulls,
  validateSearchToolVintageRange,
  LOOKUP_WINE_LIMIT_MAX,
} from '../search/search-tool-contract.js';
import {
  buildFoodPairingStructuredFilters,
  buildFoodPairingStructuredPreferences,
  resolveFoodPairingBudgetKrw,
} from '../search/food-pairing-tool-policy.js';
import {
  appendStructuredQueryClauses,
  buildSearchToolSoftClauses,
} from '../search/search-tool-query-policy.js';
import {
  buildSearchToolRetrievalCoreQuery,
  shouldPreferTypedStructuredQuery,
  shouldPreserveRepresentativeAnchorOnlyQuery,
} from '../search/search-tool-retrieval-core.js';
import {
  buildCompareBaseRetrievalQueries,
  stripSideSpecificCompareSharedConstraints,
} from '../search/compare-tool-shared-constraints.js';
import {
  applySearchToolBudgetResultPolicy,
  applySearchToolNegationResultPolicy,
  collectSearchToolNegationTerms,
} from '../search/search-tool-result-policy.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import { buildComparisonContrast } from '../../domain/response/service/comparison-contrast.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
import type { DecisionStatus } from '../../domain/shared/types/index.js';
import type {
  ToolCallEvidenceFrame,
  ToolCallStructuredOutput,
} from '../../domain/agent/model/tool-call-evidence-frame.js';
import { buildToolCallEvidenceFrame } from '../../domain/agent/service/build-tool-call-evidence-frame.js';
import { KRW_PER_USD_APPROXIMATE, MAX_QUERY_LENGTH, MIN_PRODUCED_VINTAGE_YEAR, MAX_PRODUCED_VINTAGE_YEAR } from '../../domain/shared/constants.js';
import type {
  RetrievalDocument,
  RetrievalDrinkingWindowProjection,
} from '../../domain/retrieval/model/retrieval-document.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import type { CorpusCardinalityCache } from '../../domain/retrieval/service/corpus-cardinality-cache.js';
import type { NormalizedConstraint } from '../../domain/shared/types/constraint-bundle.js';
import type {
  RecipientProfileEvidenceAxis,
  RecipientProfileValue,
} from '../../domain/query/service/recipient-situation-profile.js';
import { recipientProfileEvidenceAxes } from '../../domain/query/service/recipient-situation-profile.js';
import { CURATED_ENTITY_ALIAS_CATALOG } from '../../domain/attribute/service/entity-alias-catalog.js';
import {
  SEARCH_TOOL_DIVERSITY_LIMIT_PER_TYPE,
  SEARCH_TOOL_DIVERSITY_MIN_LIMIT,
  SEARCH_TOOL_WANTS_DIVERSITY_RE,
  executeSearchWithTypedWineDiversityDiscovery,
  shouldRunTypedWineDiversityDiscovery,
  withWineTypeFilter,
} from '../search/search-tool-diversity.js';
import { isKnownAgentToolName } from '../../domain/agent/model/agent-tool-attempt-schema.js';
import { isAccessibleOnlineTastingQuery } from './agent-situational-query-policy.js';
import { closeFoodPairingMacroEvidence } from '../search/food-pairing-macro-evidence.js';

// ---------------------------------------------------------------------------
// Schema bounds — named constants so lint catches accidental magic numbers
// ---------------------------------------------------------------------------

/** Max characters for a search query string passed to the tool. SSoT: MAX_QUERY_LENGTH from constants.ts. */
const SEARCH_QUERY_MAX_LEN = MAX_QUERY_LENGTH;
/** Max results the agent can request in a single search call. */
const SEARCH_LIMIT_MAX = 20;
/** Max KRW price the agent can filter on (~100M KRW, safely above any real wine). */
const MAX_PRICE_KRW_BOUND = 100_000_000;
/** Top-N results shown in the observation string (controls context window usage). */
const SUMMARY_TOP_N = 3;
const GROUNDING_JSON_CLAIMABLE_ATTRIBUTES_COMPACT_MAX = 8;
const DECIMAL_GROUP_SIZE = 3;
/**
 * Max lineage `(source_system:source_record_id)` pairs per wine in the pipe-delimited
 * observation text — keeps agent context bounded; full list is in GROUNDING_JSON.
 */
const AGENT_OBSERVATION_SOURCE_RECORD_REFS_MAX = 3;
/** Max characters in any single observation string returned to the agent loop.
 * Truncation prevents a single tool result from exhausting the agent's token budget.
 * ~2000 chars ≈ 500 tokens (at 4 chars/token) — enough for 5 wine summaries. */
const MAX_OBSERVATION_CHARS = 2_000;
const GROUNDING_JSON_MARKER = 'GROUNDING_JSON: ';
const PARENTS_FIRST_TIME_PORTFOLIO_SLOTS: readonly RecipientProfilePortfolioSlot[] = [
  { id: 'sweet_light', requiredAxes: ['sweet_light'], excludedAxes: ['light_rose', 'low_tannin_red'] },
  { id: 'light_rose', requiredAxes: ['light_rose'] },
  { id: 'low_tannin_red', requiredAxes: ['low_tannin_red'] },
];
const EXACT_LOOKUP_OPTIONAL_VINTAGE_RE = /(?:19|20)\d{2}$/u;
const EXACT_LOOKUP_OPTIONAL_LEADING_VINTAGE_RE = /^(?:19|20)\d{2}/u;
const EXACT_LOOKUP_CHATEAU_PREFIX_RE = /^chateau/u;
const EXACT_LOOKUP_SUFFIX_MATCH_MIN_CHARS = 6;
const NON_EXACT_LOOKUP_INTENT_RE =
  /(?:같은\s*와인|대체|스타일|느낌|비교|(?:급)(?=$|[^\p{L}\p{N}])|명작|명품|와인\s*추천|추천(?!\s*(?:해줘|해주세요|해\s*줘)))/u;
const NON_EXACT_LOOKUP_SURFACE_CATALOG: readonly {
  readonly surface: string;
  readonly reason: string;
  readonly allowAugmentedQueryPrefix?: true;
}[] = [
  { surface: '모엣', reason: 'brand family, not a single cuvee' },
  { surface: '모엣샹동', reason: 'producer family, not a single cuvee' },
  { surface: '모엣 샹동', reason: 'producer family, not a single cuvee' },
  { surface: '모엣 로제', reason: 'brand family and style, not a single cuvee' },
  { surface: '샹동 로제', reason: 'nearby brand and style, not the Moët & Chandon Rosé Impérial cuvee' },
  { surface: '샹동 핑크', reason: 'nearby brand and style, not the Moët & Chandon Rosé Impérial cuvee' },
  { surface: '모엣 샴페인', reason: 'producer family and category, not a single cuvee' },
  { surface: '모엣샹동 샴페인', reason: 'producer family and category, not a single cuvee' },
  { surface: '모엣 임페리얼', reason: 'producer family plus cuvee family, not the requested exact rose cuvee' },
  { surface: '모엣샹동 임페리얼', reason: 'producer family plus cuvee family, not the requested exact rose cuvee' },
  { surface: '모엣 브뤼', reason: 'producer family plus style, not a single confirmed cuvee' },
  { surface: '샴페인', reason: 'category / region, not a single wine entity' },
  { surface: '프랑스 샴페인', reason: 'category / region, not a single wine entity' },
  { surface: '로제 샴페인', reason: 'category / style, not a single wine entity' },
  { surface: '핑크 샴페인', reason: 'category / style, not a single wine entity' },
  { surface: '포므롤', reason: 'appellation / region, not a single wine entity' },
  { surface: '포므롤 와인', reason: 'appellation / region category, not a single wine entity' },
  { surface: '마고', reason: 'underspecified appellation / estate surface' },
  { surface: '마고 와인', reason: 'underspecified appellation / estate surface' },
  { surface: '볼게리', reason: 'region / appellation, not a single wine entity' },
  { surface: '볼게리 레드', reason: 'region / category, not a single wine entity' },
  { surface: '수퍼 투스칸', reason: 'style category, not a single wine entity' },
  { surface: '슈퍼 투스칸', reason: 'style category, not a single wine entity' },
  { surface: '토스카나 레드', reason: 'region / category, not a single wine entity' },
  { surface: '메를로 명작', reason: 'descriptive grape category, not a single wine entity', allowAugmentedQueryPrefix: true },
  { surface: '카베르네 명작', reason: 'descriptive grape category, not a single wine entity', allowAugmentedQueryPrefix: true },
  { surface: '프랑스 명문 레드', reason: 'descriptive country/category query, not a single wine entity', allowAugmentedQueryPrefix: true },
  { surface: '이탈리아 명품 레드', reason: 'descriptive country/category query, not a single wine entity', allowAugmentedQueryPrefix: true },
  { surface: '카베르네 수퍼투스칸', reason: 'descriptive grape/style category, not a single wine entity', allowAugmentedQueryPrefix: true },
  { surface: '카베르네 슈퍼투스칸', reason: 'descriptive grape/style category, not a single wine entity', allowAugmentedQueryPrefix: true },
];

function appendObservationNote(obs: string, note: string): string {
  const groundingIndex = obs.lastIndexOf(GROUNDING_JSON_MARKER);
  if (groundingIndex < 0) {
    return `${obs}\n${note}`;
  }
  const head = obs.slice(0, groundingIndex).trimEnd();
  const grounding = obs.slice(groundingIndex);
  return `${head}\n${note}\n${grounding}`;
}

// ---------------------------------------------------------------------------
// Input schemas (same as tool-schemas.ts — reusing patterns)
// ---------------------------------------------------------------------------

function normalizeSingularStyleArrayInput(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record['style'])) {
    return input;
  }
  const styleValues = record['style'].filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0);
  const existingStyles = Array.isArray(record['styles'])
    ? record['styles'].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const mergedStyles = [...styleValues, ...existingStyles].slice(0, SEARCH_TOOL_MAX_STYLES);
  const { style: _style, ...rest } = record;
  return mergedStyles.length > 0 ? { ...rest, styles: mergedStyles } : rest;
}

const SearchInputObjectSchema = z.object({
  query: buildSearchToolQueryField({ maxLen: SEARCH_QUERY_MAX_LEN }),
  ...buildSearchToolFieldShape({
    limitMax: SEARCH_LIMIT_MAX,
    maxPriceKrwMax: MAX_PRICE_KRW_BOUND,
  }),
}).superRefine((data, ctx) => {
  validateSearchToolVintageRange(data, ctx);
});

/**
 * Runtime input contract for the `search_wines` tool. Exported so property-based
 * contract tests can fuzz the same schema the handler validates against
 * (see the `SearchInputSchema.safeParse(sanitizeOptionalToolNulls(input))` call
 * in the dispatcher). Do not duplicate the bounds in tests — import this.
 */
export const SearchInputSchema = z.preprocess(normalizeSingularStyleArrayInput, SearchInputObjectSchema);

/**
 * Runtime input contract for the `lookup_wine` tool. Deliberately minimal:
 * a required wine name/identity + an optional small result cap (≤
 * {@link LOOKUP_WINE_LIMIT_MAX}). No constraint filters — lookup is identity
 * resolution, not filtered search. Exported for property/contract tests.
 */
export const LookupWineInputSchema = z.object({
  query: buildSearchToolQueryField({ maxLen: SEARCH_QUERY_MAX_LEN }),
  // No upper bound here on purpose: an LLM passing limit:5 should not hard-fail
  // the whole tool call. The dispatcher clamps to LOOKUP_WINE_LIMIT_MAX.
  limit: coercePositiveInt.pipe(z.number().int().min(1)).optional(),
});

const CompareInputObjectSchema = z.object({
  query_a: buildSearchToolQueryField({
    maxLen: SEARCH_QUERY_MAX_LEN,
    requiredMessage: 'Query A must not be empty',
  }),
  query_b: buildSearchToolQueryField({
    maxLen: SEARCH_QUERY_MAX_LEN,
    requiredMessage: 'Query B must not be empty',
  }),
  ...buildCompareToolFieldShape({
    maxPriceKrwMax: MAX_PRICE_KRW_BOUND,
  }),
  country_a: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LEN).optional(),
  country_b: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LEN).optional(),
  region_a: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LEN).optional(),
  region_b: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LEN).optional(),
  appellation_a: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LEN).optional(),
  appellation_b: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LEN).optional(),
  grape_primary_a: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LEN).optional(),
  grape_primary_b: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LEN).optional(),
  wine_type_a: z.enum(['red', 'white', 'sparkling', 'rose', 'dessert']).optional(),
  wine_type_b: z.enum(['red', 'white', 'sparkling', 'rose', 'dessert']).optional(),
  vintage_min_a: coercePositiveInt.pipe(z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR)).optional(),
  vintage_min_b: coercePositiveInt.pipe(z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR)).optional(),
  vintage_max_a: coercePositiveInt.pipe(z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR)).optional(),
  vintage_max_b: coercePositiveInt.pipe(z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR)).optional(),
}).superRefine((data, ctx) => {
  validateSearchToolVintageRange(data, ctx);
  if (
    data.vintage_min_a !== undefined
    && data.vintage_max_a !== undefined
    && data.vintage_min_a > data.vintage_max_a
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['vintage_max_a'],
      message: `vintage_max_a (${data.vintage_max_a}) must be >= vintage_min_a (${data.vintage_min_a})`,
    });
  }
  if (
    data.vintage_min_b !== undefined
    && data.vintage_max_b !== undefined
    && data.vintage_min_b > data.vintage_max_b
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['vintage_max_b'],
      message: `vintage_max_b (${data.vintage_max_b}) must be >= vintage_min_b (${data.vintage_min_b})`,
    });
  }
});

const CompareInputSchema = z.preprocess(normalizeSingularStyleArrayInput, CompareInputObjectSchema);

/** Max length for entity_id to prevent unbounded strings reaching Vespa GET / NL parser.
 * Vespa document IDs are typically ≤200 chars; 500 is a conservative upper bound. */
const ENTITY_ID_MAX_LEN = 500;
// Drinking-window year bounds: imported from SSoT (src/domain/shared/constants.ts).
// Do NOT redefine locally — see CLAUDE.md rule 30.
const DRINKING_WINDOW_MIN_YEAR = MIN_PRODUCED_VINTAGE_YEAR;
const DRINKING_WINDOW_MAX_YEAR = MAX_PRODUCED_VINTAGE_YEAR;

const DrinkingWindowInputSchema = z.object({
  entity_id: buildEntityIdToolField({ maxLen: ENTITY_ID_MAX_LEN }),
  target_year: coercePositiveInt.pipe(z.number().int().min(DRINKING_WINDOW_MIN_YEAR).max(DRINKING_WINDOW_MAX_YEAR)).optional(),
});

const FoodPairingInputSchema = z.object(
  buildFoodPairingFieldShape({
    foodRequiredMessage: 'String must contain at least 1 character(s)',
    maxPriceKrwMax: MAX_PRICE_KRW_BOUND,
  }),
);

// ---------------------------------------------------------------------------
// Tool result type
// ---------------------------------------------------------------------------

export interface AgentToolResult {
  /** Human-readable observation for the LLM context window. */
  readonly observation: string;
  /** Raw structured result (for inclusion in final response). */
  readonly rawResult: unknown;
  /**
   * ADR-009 Phase 0: optional typed evidence frame. Emitted when the caller
   * (orchestrator / parallel batch dispatcher) supplies a `toolCallId` in
   * {@link AgentToolExecutionOptions}. Absent when the caller is a legacy
   * pre-ADR-009 site (feature flag off, direct unit-test invocation).
   */
  readonly evidenceFrame?: ToolCallEvidenceFrame | undefined;
}

/**
 * Internal-only result shape from each per-tool branch. Not part of the
 * public dispatcher contract — the wrapper translates this into
 * `AgentToolResult` and optionally attaches an `evidenceFrame`.
 */
interface AgentToolInnerResult {
  readonly observation: string;
  readonly rawResult: unknown;
  readonly structuredOutput: ToolCallStructuredOutput;
}

export interface AgentToolExecutionOptions {
  readonly abortSignal?: AbortSignal | undefined;
  /**
   * ADR-009 Phase 0: when provided, the wrapper builds a
   * {@link ToolCallEvidenceFrame} keyed on this ID and attaches it to the
   * result. Callers that do not need frames (legacy tests, shadow-disabled
   * runs) omit this field; the wrapper then returns only observation +
   * rawResult.
   */
  readonly toolCallId?: string | undefined;
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
    parentContext?: DecomposedSearchParentContext,
    options?: DecomposedSearchExecutionOptions,
    retrievalSubQueries?: readonly string[],
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
  /** Narrow exact entity projection for check_drinking_window.
   *  Production callers should provide this so drinkability checks are not
   *  coupled to full RetrievalDocument hydration. */
  readonly drinkingWindowEntityLookup?: (
    id: CanonicalEntityId,
  ) => Promise<RetrievalDrinkingWindowProjection | undefined>;
  /** Step-local grounded projection cache built from previous search/compare tool outputs. */
  readonly groundedDrinkingWindowLookup?: (
    id: CanonicalEntityId,
  ) => RetrievalDrinkingWindowProjection | undefined;
  /** Corpus cardinality cache for distinguishing corpus exhaustion from query specificity.
   *  When undefined, all 0-result responses are tagged as `unreliable` (legacy behavior). */
  readonly corpusCardinality?: CorpusCardinalityCache | undefined;
}

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

// SSOT: tool name validation delegated to agent-tool-attempt-schema.ts
export const isKnownTool = isKnownAgentToolName;

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
 * Must not exceed MAX_QUERY_LENGTH — the security gate in query-sanitizer.ts rejects
 * queries longer than MAX_QUERY_LENGTH, so an enriched query exceeding it would always
 * be rejected. Capping here at MAX_QUERY_LENGTH ensures the enriched query passes the gate.
 *
 * Domain rationale: Vespa YQL parser has a 4 KB query limit; MAX_QUERY_LENGTH (the
 * regex-screening ceiling) stays well within it. Sourced from the constant so this stays
 * in lockstep with the security gate.
 */
const MAX_ENRICHED_QUERY_LEN = MAX_QUERY_LENGTH; // SSoT: must match security gate

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

/** Agent mapping version for structured filter provenance. */
const AGENT_FILTER_VERSION = 'agent_v1';

interface StructuredSearchConstraintInput {
  readonly exclude_grapes?: readonly string[] | undefined;
  readonly exclude_regions?: readonly string[] | undefined;
  readonly exclude_wine_types?: readonly string[] | undefined;
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly max_alcohol_pct?: number | undefined;
  readonly grape_primary?: string | undefined;
  readonly wine_type?: string | undefined;
  readonly country?: string | undefined;
  readonly region?: string | undefined;
  readonly vintage_min?: number | undefined;
  readonly vintage_max?: number | undefined;
  readonly appellation?: string | undefined;
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly certification?: string | undefined;
  readonly occasion?: readonly string[] | undefined;
  readonly gift_suitability_min?: number | undefined;
  readonly beginner_suitability_min?: number | undefined;
  readonly producer_prestige_min?: number | undefined;
  readonly popularity_min?: number | undefined;
  readonly recipient_profile?: RecipientProfileValue | undefined;
  readonly sweetness_min?: number | undefined;
  readonly sweetness_max?: number | undefined;
  readonly acidity_min?: number | undefined;
  readonly acidity_max?: number | undefined;
  readonly tannin_max?: number | undefined;
  readonly drinking_window?: 'now' | undefined;
  readonly drinking_window_target_year?: number | undefined;
}

interface CompareSideSearchOverrides {
  readonly country?: string | undefined;
  readonly region?: string | undefined;
  readonly appellation?: string | undefined;
  readonly grape_primary?: string | undefined;
  readonly wine_type?: string | undefined;
  readonly vintage_min?: number | undefined;
  readonly vintage_max?: number | undefined;
}

/**
 * Converts agent tool structured params to NormalizedConstraints that flow
 * directly to Vespa as hard YQL filters.
 *
 * Price is intentionally NOT a Vespa hard filter — many wines lack price_usd
 * data, so a hard filter would silently drop valid results. Price filtering
 * is handled by the agent-level post-filter instead.
 */
function buildStructuredFilters(input: StructuredSearchConstraintInput): readonly NormalizedConstraint[] {
  const filters: NormalizedConstraint[] = [];
  const v = AGENT_FILTER_VERSION;

  // Exclusions
  for (const grape of input.exclude_grapes ?? []) {
    filters.push({ attribute: 'grape_primary', operator: 'exclude', value: grape, source_phrase: grape, confidence: 1.0, mapping_version: v });
  }
  for (const region of input.exclude_regions ?? []) {
    filters.push({ attribute: 'region', operator: 'exclude', value: region, source_phrase: region, confidence: 1.0, mapping_version: v });
  }
  for (const wineType of input.exclude_wine_types ?? []) {
    filters.push({ attribute: 'wine_type', operator: 'exclude', value: wineType, source_phrase: wineType, confidence: 1.0, mapping_version: v });
  }

  if (input.grape_primary !== undefined) {
    filters.push({ attribute: 'grape_primary', operator: '=', value: input.grape_primary, source_phrase: input.grape_primary, confidence: 1.0, mapping_version: v });
  }

  // Wine type
  if (input.wine_type !== undefined) {
    filters.push({ attribute: 'wine_type', operator: '=', value: input.wine_type, source_phrase: input.wine_type, confidence: 1.0, mapping_version: v });
  }

  // Country
  if (input.country !== undefined) {
    filters.push({ attribute: 'country', operator: '=', value: input.country, source_phrase: input.country, confidence: 1.0, mapping_version: v });
  }

  // Region
  if (input.region !== undefined) {
    filters.push({ attribute: 'region', operator: '=', value: input.region, source_phrase: input.region, confidence: 1.0, mapping_version: v });
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

function buildStructuredPreferences(input: StructuredSearchConstraintInput): readonly NormalizedConstraint[] {
  return buildSearchToolStructuredPreferences(input, AGENT_FILTER_VERSION);
}

function buildStructuredQuery(
  input: StructuredSearchConstraintInput & {
    readonly query: string;
    readonly preserveRepresentativeSearch?: boolean | undefined;
  },
): string {
  const retrievalCoreQuery = buildSearchToolRetrievalCoreQuery(input);
  const clauses = shouldPreferTypedStructuredQuery(input) || shouldPreserveRepresentativeAnchorOnlyQuery(input)
    ? []
    : buildSearchToolSoftClauses(input);
  return appendStructuredQueryClauses(retrievalCoreQuery, clauses);
}

function buildComparisonOriginalQuery(
  input: StructuredSearchConstraintInput & {
    readonly query_a: string;
    readonly query_b: string;
  },
): string {
  const sharedClauses = buildSearchToolSoftClauses(input);
  const base = `${input.query_a} vs ${input.query_b}`;
  return appendStructuredQueryClauses(base, sharedClauses);
}

function buildCompareSideOverrides(
  input: z.infer<typeof CompareInputSchema>,
): readonly [CompareSideSearchOverrides, CompareSideSearchOverrides] {
  return [
    {
      ...(input.country_a !== undefined ? { country: input.country_a } : {}),
      ...(input.region_a !== undefined ? { region: input.region_a } : {}),
      ...(input.appellation_a !== undefined ? { appellation: input.appellation_a } : {}),
      ...(input.grape_primary_a !== undefined ? { grape_primary: input.grape_primary_a } : {}),
      ...(input.wine_type_a !== undefined ? { wine_type: input.wine_type_a } : {}),
      ...(input.vintage_min_a !== undefined ? { vintage_min: input.vintage_min_a } : {}),
      ...(input.vintage_max_a !== undefined ? { vintage_max: input.vintage_max_a } : {}),
    },
    {
      ...(input.country_b !== undefined ? { country: input.country_b } : {}),
      ...(input.region_b !== undefined ? { region: input.region_b } : {}),
      ...(input.appellation_b !== undefined ? { appellation: input.appellation_b } : {}),
      ...(input.grape_primary_b !== undefined ? { grape_primary: input.grape_primary_b } : {}),
      ...(input.wine_type_b !== undefined ? { wine_type: input.wine_type_b } : {}),
      ...(input.vintage_min_b !== undefined ? { vintage_min: input.vintage_min_b } : {}),
      ...(input.vintage_max_b !== undefined ? { vintage_max: input.vintage_max_b } : {}),
    },
  ] as const;
}

function buildCompareSideOnlyFilters(
  overrides: CompareSideSearchOverrides,
): readonly NormalizedConstraint[] {
  return buildStructuredFilters({
    ...(overrides.country !== undefined ? { country: overrides.country } : {}),
    ...(overrides.region !== undefined ? { region: overrides.region } : {}),
    ...(overrides.appellation !== undefined ? { appellation: overrides.appellation } : {}),
    ...(overrides.grape_primary !== undefined ? { grape_primary: overrides.grape_primary } : {}),
    ...(overrides.wine_type !== undefined ? { wine_type: overrides.wine_type } : {}),
    ...(overrides.vintage_min !== undefined ? { vintage_min: overrides.vintage_min } : {}),
    ...(overrides.vintage_max !== undefined ? { vintage_max: overrides.vintage_max } : {}),
  });
}

function hasExactVintageSideSearch(
  overrides: CompareSideSearchOverrides,
): boolean {
  return overrides.vintage_min !== undefined
    && overrides.vintage_max !== undefined
    && overrides.vintage_min === overrides.vintage_max;
}

function recomputeComparisonOverallStatus(
  entities: readonly ComparisonSearchResponse['entities'][number][],
): DecisionStatus {
  if (entities.every((entity) => entity.resolutionStatus === 'resolved')) {
    return 'resolved';
  }
  if (entities.some((entity) => entity.resolutionStatus === 'ambiguous')) {
    return 'ambiguous';
  }
  return 'failed';
}

async function rescueExactComparisonResponse(
  response: ComparisonSearchResponse,
  deps: AgentToolDeps,
  requestId: string,
  rawSubQueries: readonly [string, string],
  sharedFilters: readonly NormalizedConstraint[],
  sharedPreferences: readonly NormalizedConstraint[],
  sideSpecificFilters: readonly [
    readonly NormalizedConstraint[],
    readonly NormalizedConstraint[],
  ],
  sideOverrides: readonly [CompareSideSearchOverrides, CompareSideSearchOverrides],
  options?: AgentToolExecutionOptions,
): Promise<ComparisonSearchResponse> {
  const rescuedEntities = await Promise.all(response.entities.map(async (entity, index) => {
    if (
      !hasExactVintageSideSearch(sideOverrides[index]!)
      || (entity.topResult !== null && entity.resolutionStatus === 'resolved')
    ) {
      return entity;
    }

    const rescued = await deps.searchUseCase.execute(
      {
        query: rawSubQueries[index]!,
        options: { mode: 'entity', explain: false, clarification: false },
        ...(sharedFilters.length > 0 || sideSpecificFilters[index]!.length > 0
          ? {
              filters: [
                ...sharedFilters,
                ...sideSpecificFilters[index]!,
              ],
            }
          : {}),
        ...(sharedPreferences.length > 0 ? { preferences: sharedPreferences } : {}),
      },
      `${requestId}-compare-rescue-${index}`,
      { ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}) },
    );

    if (rescued.queryType !== 'search' || rescued.results.length === 0) {
      return entity;
    }
    if (rescued.engineDecision.decisionStatus !== 'resolved') {
      return {
        subQuery: entity.subQuery,
        comparisonMode: 'entity',
        topResult: null,
        resultCount: 0,
        resolutionStatus: 'failed',
        allResults: [],
      };
    }

    return {
      subQuery: entity.subQuery,
      comparisonMode: 'entity',
      topResult: rescued.results[0] ?? null,
      resultCount: rescued.results.length,
      resolutionStatus: rescued.engineDecision.decisionStatus,
      allResults: rescued.results,
    };
  })) as ComparisonSearchResponse['entities'];

  if (rescuedEntities.every((entity, index) => entity === response.entities[index])) {
    return response;
  }

  return {
    ...response,
    entities: rescuedEntities,
    overallStatus: recomputeComparisonOverallStatus(rescuedEntities),
  };
}

interface SearchToolAlcoholPreferenceResult {
  readonly response: SearchResponseV1;
  readonly demotedCount: number;
  readonly unknownCount: number;
}

function applySearchToolAlcoholPreference(
  response: SearchResponseV1,
  maxAlcoholPct: number | undefined,
): SearchToolAlcoholPreferenceResult {
  if (maxAlcoholPct === undefined) {
    return { response, demotedCount: 0, unknownCount: 0 };
  }

  const preferred: SearchResponseV1['results'][number][] = [];
  const unknown: SearchResponseV1['results'][number][] = [];
  const demoted: SearchResponseV1['results'][number][] = [];

  for (const result of response.results) {
    const alcoholPct = result.entity.alcoholPct;
    if (alcoholPct === undefined) {
      unknown.push(result);
      continue;
    }
    if (alcoholPct <= maxAlcoholPct) {
      preferred.push(result);
      continue;
    }
    demoted.push(result);
  }

  const reordered = [...preferred, ...unknown, ...demoted];
  const reorderedResponse = reordered.every((result, index) => result === response.results[index])
    ? response
    : { ...response, results: reordered };

  return {
    response: reorderedResponse,
    demotedCount: demoted.length,
    unknownCount: unknown.length,
  };
}

function buildPriceFilterObservation(input: {
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
}): string | undefined {
  if (input.min_price_krw !== undefined && input.max_price_krw !== undefined) {
    return `[PRICE_FILTER: 검색 결과는 ${input.min_price_krw}원 이상 ${input.max_price_krw}원 이하로 필터링되었습니다.]`;
  }
  if (input.min_price_krw !== undefined) {
    return `[PRICE_FILTER: 검색 결과는 ${input.min_price_krw}원 이상으로 필터링되었습니다.]`;
  }
  if (input.max_price_krw !== undefined) {
    return `[PRICE_FILTER: 검색 결과는 ${input.max_price_krw}원 이하로 필터링되었습니다.]`;
  }
  return undefined;
}

function compactGroundingJsonForObservationCap(
  grounding: string,
  maxChars: number,
): string | undefined {
  const rawJson = grounding.slice(GROUNDING_JSON_MARKER.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson) as unknown;
  } catch (err) {
    void err;
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const source = parsed as Record<string, unknown>;
  const wines = Array.isArray(source['wines']) ? source['wines'] : [];
  const comparisonLegs = Array.isArray(source['comparison_legs']) ? source['comparison_legs'] : [];
  const compactWines = wines
    .filter((wine): wine is Record<string, unknown> =>
      wine !== null && typeof wine === 'object' && !Array.isArray(wine))
    .map((wine) => ({
      ...(typeof wine['entity_id'] === 'string' ? { entity_id: wine['entity_id'] } : {}),
      ...(typeof wine['canonical_label'] === 'string' ? { canonical_label: wine['canonical_label'] } : {}),
      ...(typeof wine['producer'] === 'string' ? { producer: wine['producer'] } : {}),
      ...(typeof wine['region'] === 'string' ? { region: wine['region'] } : {}),
      ...(typeof wine['wine_type'] === 'string' ? { wine_type: wine['wine_type'] } : {}),
      ...(typeof wine['vintage'] === 'number' ? { vintage: wine['vintage'] } : {}),
      ...(Array.isArray(wine['grapes'])
        ? { grapes: wine['grapes'].filter((grape): grape is string => typeof grape === 'string').slice(0, 2) }
        : {}),
      ...(typeof wine['style'] === 'string' ? { style: wine['style'] } : {}),
      ...(typeof wine['sweetness'] === 'number' ? { sweetness: wine['sweetness'] } : {}),
      ...(typeof wine['recipient_profile'] === 'string' ? { recipient_profile: wine['recipient_profile'] } : {}),
      ...(Array.isArray(wine['profile_evidence'])
        ? { profile_evidence: wine['profile_evidence'].filter((axis): axis is string => typeof axis === 'string') }
        : {}),
      ...(Array.isArray(wine['matched_constraints'])
        ? { matched_constraints: wine['matched_constraints'].filter((attribute): attribute is string => typeof attribute === 'string') }
        : {}),
      ...(Array.isArray(wine['unmet_constraints'])
        ? { unmet_constraints: wine['unmet_constraints'].filter((attribute): attribute is string => typeof attribute === 'string') }
        : {}),
      ...(Array.isArray(wine['inferred_constraints'])
        ? { inferred_constraints: wine['inferred_constraints'].filter((attribute): attribute is string => typeof attribute === 'string') }
        : {}),
      ...(Array.isArray(wine['claimable_attributes'])
        ? { claimable_attributes: wine['claimable_attributes'].filter((attribute): attribute is string => typeof attribute === 'string') }
        : {}),
      ...(typeof wine['alcohol_pct'] === 'number' ? { alcohol_pct: wine['alcohol_pct'] } : {}),
      ...(typeof wine['price_usd'] === 'number' ? { price_usd: wine['price_usd'] } : {}),
      ...(typeof wine['price'] === 'string' ? { price: wine['price'] } : {}),
      ...(typeof wine['price_krw_approx'] === 'number' ? { price_krw_approx: wine['price_krw_approx'] } : {}),
    }));
  const compactComparisonLegs = comparisonLegs
    .filter((leg): leg is Record<string, unknown> =>
      leg !== null && typeof leg === 'object' && !Array.isArray(leg))
    .map((leg) => ({
      ...(typeof leg['sub_query'] === 'string' ? { sub_query: leg['sub_query'] } : {}),
      ...(typeof leg['comparison_mode'] === 'string' ? { comparison_mode: leg['comparison_mode'] } : {}),
      ...(typeof leg['canonical_concept'] === 'string' ? { canonical_concept: leg['canonical_concept'] } : {}),
      ...(typeof leg['concept_entity_type'] === 'string' ? { concept_entity_type: leg['concept_entity_type'] } : {}),
      ...(typeof leg['aggregate_result_count'] === 'number'
        ? { aggregate_result_count: leg['aggregate_result_count'] }
        : {}),
      ...(Array.isArray(leg['prototype_axis'])
        ? {
            prototype_axis: leg['prototype_axis']
              .filter((item): item is Record<string, unknown> =>
                item !== null && typeof item === 'object' && !Array.isArray(item))
              .slice(0, 2)
              .map((item) => ({
                ...(typeof item['entity_id'] === 'string' ? { entity_id: item['entity_id'] } : {}),
                ...(typeof item['canonical_label'] === 'string'
                  ? { canonical_label: item['canonical_label'] }
                  : {}),
                ...(typeof item['wine_type'] === 'string' ? { wine_type: item['wine_type'] } : {}),
                ...(typeof item['region'] === 'string' ? { region: item['region'] } : {}),
                ...(Array.isArray(item['grapes'])
                  ? {
                      grapes: item['grapes']
                        .filter((grape): grape is string => typeof grape === 'string')
                        .slice(0, 2),
                    }
                  : {}),
              })),
          }
        : {}),
    }));

  const wineProjectionTiers = [
    compactWines,
    compactWines.map((wine) => ({
      ...wine,
      ...(Array.isArray(wine.claimable_attributes)
        ? {
            claimable_attributes: wine.claimable_attributes
              .filter((attribute) =>
                attribute.startsWith('profile_evidence:')
                || attribute.startsWith('matched_constraint:')
                || attribute === 'recipient_profile')
              .slice(0, GROUNDING_JSON_CLAIMABLE_ATTRIBUTES_COMPACT_MAX),
          }
        : {}),
    })),
    compactWines.map(({ claimable_attributes: _claimableAttributes, ...wine }) => wine),
    compactWines.map((wine) => ({
      ...(wine.entity_id !== undefined ? { entity_id: wine.entity_id } : {}),
      ...(wine.canonical_label !== undefined ? { canonical_label: wine.canonical_label } : {}),
      ...(wine.wine_type !== undefined ? { wine_type: wine.wine_type } : {}),
      ...(wine.grapes !== undefined ? { grapes: wine.grapes } : {}),
      ...(wine.style !== undefined ? { style: wine.style } : {}),
      ...(wine.sweetness !== undefined ? { sweetness: wine.sweetness } : {}),
      ...(wine.recipient_profile !== undefined ? { recipient_profile: wine.recipient_profile } : {}),
      ...(wine.profile_evidence !== undefined ? { profile_evidence: wine.profile_evidence } : {}),
      ...(wine.matched_constraints !== undefined ? { matched_constraints: wine.matched_constraints } : {}),
      ...(wine.price !== undefined ? { price: wine.price } : {}),
      ...(wine.price_krw_approx !== undefined ? { price_krw_approx: wine.price_krw_approx } : {}),
    })),
  ];

  for (let count = compactWines.length; count >= 1; count -= 1) {
    for (const projectedWines of wineProjectionTiers) {
      const candidate = `${GROUNDING_JSON_MARKER}${JSON.stringify({
        query_type: source['query_type'],
        total_results: source['total_results'],
        wines: projectedWines.slice(0, count),
        ...(compactComparisonLegs.length > 0 ? { comparison_legs: compactComparisonLegs } : {}),
        truncated_for_observation_cap: count < compactWines.length || projectedWines !== compactWines,
      })}`;
      if (candidate.length <= maxChars) {
        return candidate;
      }
    }
  }

  const first = compactWines[0];
  if (first === undefined) {
    return undefined;
  }
  const minimal = `${GROUNDING_JSON_MARKER}${JSON.stringify({
    query_type: source['query_type'],
    total_results: source['total_results'],
    wines: [{
      ...(first['entity_id'] !== undefined ? { entity_id: first['entity_id'] } : {}),
      ...(first['canonical_label'] !== undefined ? { canonical_label: first['canonical_label'] } : {}),
    }],
    ...(compactComparisonLegs.length > 0
      ? { comparison_legs: compactComparisonLegs.map((leg) => ({
        ...(leg['sub_query'] !== undefined ? { sub_query: leg['sub_query'] } : {}),
        ...(leg['canonical_concept'] !== undefined ? { canonical_concept: leg['canonical_concept'] } : {}),
        ...(leg['concept_entity_type'] !== undefined ? { concept_entity_type: leg['concept_entity_type'] } : {}),
        ...(leg['aggregate_result_count'] !== undefined
          ? { aggregate_result_count: leg['aggregate_result_count'] }
          : {}),
      })) }
      : {}),
    truncated_for_observation_cap: true,
  })}`;
  return minimal.length <= maxChars ? minimal : undefined;
}

function buildGroundingJsonFromStructuredOutput(
  structuredOutput: ToolCallStructuredOutput | undefined,
): string | undefined {
  if (structuredOutput === undefined) {
    return undefined;
  }

  switch (structuredOutput.kind) {
    case 'search_result_set': {
      return buildGroundingJsonFromSearch(
        {
          queryType: 'search',
          results: structuredOutput.resultSet,
        } as SearchResponseV1,
        structuredOutput.resultSet.slice(0, SUMMARY_TOP_N),
      );
    }
    case 'food_pairing': {
      return buildGroundingJsonFromSearch(
        {
          queryType: 'search',
          results: structuredOutput.resultSet,
        } as SearchResponseV1,
        structuredOutput.resultSet.slice(0, SUMMARY_TOP_N),
      );
    }
    case 'comparison_result':
      return buildGroundingJsonFromComparison(structuredOutput.response);
    case 'drinking_window':
    case 'tool_error':
    case 'no_op':
      return undefined;
  }
}

/**
 * Truncates an observation string to MAX_OBSERVATION_CHARS to prevent a single
 * tool result from exhausting the agent's token budget in one step.
 */
function capObservation(
  obs: string,
  structuredOutput?: ToolCallStructuredOutput,
): string {
  if (obs.length <= MAX_OBSERVATION_CHARS) return obs;
  const groundingIndex = obs.lastIndexOf(GROUNDING_JSON_MARKER);
  if (groundingIndex >= 0) {
    const grounding = obs.slice(groundingIndex);
    const head = obs.slice(0, groundingIndex).trimEnd();
    const truncationNotice = `\n[observation summary truncated to preserve grounding JSON]\n`;
    const availableHeadChars = MAX_OBSERVATION_CHARS - grounding.length - truncationNotice.length;
    if (availableHeadChars > 0) {
      return `${head.slice(0, availableHeadChars)}${truncationNotice}${grounding}`;
    }
    const compactGrounding = compactGroundingJsonForObservationCap(
      grounding,
      MAX_OBSERVATION_CHARS - truncationNotice.length,
    );
    if (compactGrounding !== undefined) {
      return `${truncationNotice}${compactGrounding}`;
    }
  }

  const structuredGrounding = buildGroundingJsonFromStructuredOutput(structuredOutput);
  if (structuredGrounding !== undefined) {
    const availableGroundingChars = MAX_OBSERVATION_CHARS - `\n[observation summary truncated to preserve grounding JSON]\n`.length;
    const compactStructuredGrounding = compactGroundingJsonForObservationCap(
      structuredGrounding,
      availableGroundingChars,
    );
    if (compactStructuredGrounding !== undefined) {
      return `\n[observation summary truncated to preserve grounding JSON]\n${compactStructuredGrounding}`;
    }
    if (structuredGrounding.length <= availableGroundingChars) {
      return `\n[observation summary truncated to preserve grounding JSON]\n${structuredGrounding}`;
    }
    if (structuredGrounding.length <= MAX_OBSERVATION_CHARS) {
      return structuredGrounding;
    }
  }

  return obs.slice(0, MAX_OBSERVATION_CHARS) + `\n[observation truncated at ${MAX_OBSERVATION_CHARS} chars]`;
}

/**
 * Wrap an inner tool result into the public `AgentToolResult`, capping the
 * observation and optionally building the ADR-009 evidence frame.
 *
 * Frame emission is gated on the caller supplying a `toolCallId` in
 * `options`. Legacy callers that don't provide one get the pre-ADR-009
 * shape (`observation` + `rawResult` only).
 */
function finalizeToolResult(
  inner: AgentToolInnerResult,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  requestId: string,
  toolCallId: string | undefined,
  invokedAt: Date,
  durationMs: number,
): AgentToolResult {
  const observation = capObservation(inner.observation, inner.structuredOutput);
  if (toolCallId === undefined) {
    return { observation, rawResult: inner.rawResult };
  }
  const evidenceFrame = buildToolCallEvidenceFrame({
    toolCallId,
    toolName,
    requestId,
    input,
    structuredOutput: inner.structuredOutput,
    observation,
    invokedAt,
    durationMs,
  });
  return { observation, rawResult: inner.rawResult, evidenceFrame };
}

export async function executeAgentTool(
  toolName: string,
  input: Record<string, unknown>,
  deps: AgentToolDeps,
  requestId: string,
  options?: AgentToolExecutionOptions,
): Promise<AgentToolResult> {
  const invokedAt = new Date();
  const startMs = Date.now();
  const toolCallId = options?.toolCallId;
  try {
    const inner = await executeAgentToolInner(toolName, input, deps, requestId, options);
    return finalizeToolResult(
      inner,
      toolName,
      input,
      requestId,
      toolCallId,
      invokedAt,
      Date.now() - startMs,
    );
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
    // Other DomainErrors are enumerated tool-level failures (validation,
    // missing entity, ambiguity, etc.) — convert them to a structured
    // observation so the agent loop can try a different approach.
    if (err instanceof DomainError) {
      bootstrapLogger.warn(
        { err, tool: toolName, requestId, code: err.code },
        '[agent-tools] domain error returned as observation',
      );
      const inner: AgentToolInnerResult = {
        observation: `Tool "${toolName}" failed with ${err.code}: ${err.message}`,
        rawResult: null,
        structuredOutput: { kind: 'tool_error', errorCode: err.code, message: err.message },
      };
      return finalizeToolResult(
        inner,
        toolName,
        input,
        requestId,
        toolCallId,
        invokedAt,
        Date.now() - startMs,
      );
    }
    // Unknown errors are NOT enumerated tool-level failures — they are
    // infrastructure or programmer errors (DB outage, OOM, type confusion).
    // CLAUDE.md: catch blocks in use-case code MUST NOT fabricate
    // success-shaped responses from unexpected errors. Propagate to the
    // orchestrator's outer error handler so the request fails loud.
    throw err;
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
 *
 * ADR-009: when the caller provides `options.toolCallId`, each batch item
 * receives a derived `toolCallId` of the form `${baseToolCallId}-p${i}` so
 * every evidence frame in the batch has a unique id aligned with its
 * position in the `actionPairs` array.
 */
export async function executeAgentToolsBatch(
  toolCalls: readonly { readonly tool: string; readonly input: Record<string, unknown> }[],
  deps: AgentToolDeps,
  baseRequestId: string,
  options?: AgentToolExecutionOptions,
): Promise<readonly AgentToolResult[]> {
  const baseToolCallId = options?.toolCallId;
  return Promise.all(
    toolCalls.map((call, i) => {
      const perItemOptions: AgentToolExecutionOptions = {
        ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
        ...(baseToolCallId !== undefined ? { toolCallId: `${baseToolCallId}-p${i}` } : {}),
      };
      return executeAgentTool(call.tool, call.input, deps, `${baseRequestId}-p${i}`, perItemOptions);
    }),
  );
}

function buildDrinkingWindowToolResult(
  entity: RetrievalDrinkingWindowProjection,
  targetYear: number,
): AgentToolInnerResult {
  const start = entity.drinkingWindowStart;
  const end = entity.drinkingWindowEnd;
  if (start !== undefined && end !== undefined) {
    const currentlyDrinkable = targetYear >= start && targetYear <= end;
    const dw: DrinkingWindowBlock = {
      drinkingWindowStart: start,
      drinkingWindowEnd: end,
      currentlyDrinkable,
      confidence: 'medium',
      ...(entity.drinkingWindowModelVersion !== undefined
        ? { modelVersion: entity.drinkingWindowModelVersion }
        : {}),
    };
    const statusLabel = currentlyDrinkable
      ? `currently drinkable (peak: ${start}–${end})`
      : targetYear < start
        ? `not yet at peak — hold until ${start}`
        : `past peak (window closed ${end})`;
    return {
      observation: `${sanitizeObservationField(entity.canonicalLabel)}: drinking window ${start}-${end}. As of ${targetYear}: ${statusLabel}.`,
      rawResult: dw,
      structuredOutput: { kind: 'drinking_window', entityId: entity.entityId, window: dw, targetYear },
    };
  }
  return {
    observation: `${sanitizeObservationField(entity.canonicalLabel)}: no drinking window data available.`,
    rawResult: null,
    structuredOutput: { kind: 'no_op', reason: 'drinking window data absent on entity' },
  };
}

function buildDrinkingWindowProjectionFromSearchResult(
  result: unknown,
  fallbackEntity: RetrievalDrinkingWindowProjection,
): RetrievalDrinkingWindowProjection | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const entityRecord = typeof record['entity'] === 'object' && record['entity'] !== null
    ? record['entity'] as Record<string, unknown>
    : undefined;
  const drinkingWindowRecord = typeof record['drinkingWindow'] === 'object' && record['drinkingWindow'] !== null
    ? record['drinkingWindow'] as Record<string, unknown>
    : undefined;
  const start = drinkingWindowRecord?.['drinkingWindowStart'];
  const end = drinkingWindowRecord?.['drinkingWindowEnd'];
  if (typeof start !== 'number' || typeof end !== 'number') {
    return undefined;
  }
  const entityId = typeof entityRecord?.['entityId'] === 'string'
    ? createCanonicalEntityId(entityRecord['entityId'])
    : fallbackEntity.entityId;
  const canonicalLabel = typeof entityRecord?.['canonicalLabel'] === 'string'
    ? entityRecord['canonicalLabel']
    : fallbackEntity.canonicalLabel;
  const modelVersion = typeof drinkingWindowRecord?.['modelVersion'] === 'string'
    ? drinkingWindowRecord['modelVersion']
    : fallbackEntity.drinkingWindowModelVersion;
  return {
    ...fallbackEntity,
    entityId,
    canonicalLabel,
    drinkingWindowStart: start,
    drinkingWindowEnd: end,
    ...(modelVersion !== undefined ? { drinkingWindowModelVersion: modelVersion } : {}),
  };
}

async function buildDrinkingWindowToolResultWithSearchFallback(
  entity: RetrievalDrinkingWindowProjection,
  targetYear: number,
  deps: AgentToolDeps,
  requestId: string,
  options?: AgentToolExecutionOptions,
): Promise<AgentToolInnerResult> {
  const direct = buildDrinkingWindowToolResult(entity, targetYear);
  if (direct.structuredOutput.kind !== 'no_op') {
    return direct;
  }

  const searchResult = await deps.searchUseCase.execute(
    { query: entity.canonicalLabel, options: { mode: 'entity', explain: false, clarification: false } },
    requestId,
    { ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}) },
  );
  if (searchResult.queryType !== 'search') {
    return direct;
  }

  const matchedResult = searchResult.results.find((result) => {
    const searchEntityId = result.entity.entityId;
    if (searchEntityId === entity.entityId) {
      return true;
    }
    return result.entity.canonicalLabel === entity.canonicalLabel;
  });
  const fallbackProjection = matchedResult !== undefined
    ? buildDrinkingWindowProjectionFromSearchResult(matchedResult, entity)
    : undefined;
  return fallbackProjection !== undefined
    ? buildDrinkingWindowToolResult(fallbackProjection, targetYear)
    : direct;
}

function buildSearchRequestForAgentQuery(
  query: string,
  limit: number | undefined,
  retrievalMode: z.infer<typeof SearchInputSchema>['retrieval_mode'],
  filters: readonly NormalizedConstraint[],
  preferences: readonly NormalizedConstraint[] = [],
): Parameters<SearchExecutorPort['execute']>[0] {
  return {
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(retrievalMode !== undefined
      ? { options: { mode: retrievalMode, explain: false, clarification: false } }
      : {}),
    ...(filters.length > 0 ? { filters } : {}),
    ...(preferences.length > 0 ? { preferences } : {}),
  };
}

const SEARCH_TOOL_SET_FILTER_ATTRIBUTES = new Set([
  'appellation',
  'country',
  'grape_primary',
  'region',
  'wine_type',
]);

function normalizeSearchToolRetrievalMode(
  retrievalMode: z.infer<typeof SearchInputSchema>['retrieval_mode'],
  filters: readonly NormalizedConstraint[],
  preferences: readonly NormalizedConstraint[],
): z.infer<typeof SearchInputSchema>['retrieval_mode'] {
  if (retrievalMode !== 'entity') {
    return retrievalMode;
  }
  const hasSetFilter = filters.some((constraint) =>
    constraint.operator === '=' && SEARCH_TOOL_SET_FILTER_ATTRIBUTES.has(constraint.attribute),
  );
  if (hasSetFilter || preferences.length > 0) {
    return 'hybrid';
  }
  return retrievalMode;
}

// Food-pairing macro-evidence closure (PairingEvidenceClosureInput +
// collectFoodPairingMacroEvidenceAxes + closeFoodPairingMacroEvidence) is
// owned by the SSoT module
// `src/application/search/food-pairing-macro-evidence.ts` and imported at
// the top of this file. The `FoodPairingUseCase` shares the same helper so
// the two routes (legacy agent tool branch + new use case) never drift on
// the lift-pairing-constraint rule (CLAUDE.md rule 25/30).

async function executeAgentToolInner(
  toolName: string,
  input: Record<string, unknown>,
  deps: AgentToolDeps,
  requestId: string,
  options?: AgentToolExecutionOptions,
): Promise<AgentToolInnerResult> {
  switch (toolName) {
    case 'search_wines': {
      const parseResult = SearchInputSchema.safeParse(sanitizeOptionalToolNulls(input));
      if (!parseResult.success) {
        const msg = parseResult.error.issues.map((i) => i.message).join(', ');
        return {
          observation: `Invalid input for search_wines: ${msg}`,
          rawResult: null,
          structuredOutput: { kind: 'tool_error', errorCode: 'INVALID_INPUT', message: msg },
        };
      }
      const parsed = parseResult.data;
      const retrievalCoreQuery = buildSearchToolRetrievalCoreQuery(parsed);

      // Enrich query with structured exclusion/price params so the existing
      // search pipeline (which understands natural language) applies them.
      // Truncate the BASE query before appending clauses so that structured
      // clauses (exclusions, price) are never silently truncated mid-token.
      // Slicing the enriched string after appending can cut e.g. "not Cabern"
      // (malformed exclusion) — truncating base-first guarantees clauses intact.
      const clauses = shouldPreferTypedStructuredQuery(parsed) || shouldPreserveRepresentativeAnchorOnlyQuery(parsed)
        ? []
        : buildSearchToolSoftClauses(parsed);
      const clausesStr = clauses.length > 0 ? `, ${clauses.join(', ')}` : '';
      // Truncate BASE query so that the full enriched string never exceeds the limit.
      // `Math.max(0, ...)` prevents negative slice when clauses alone exceed the limit;
      // in that extreme case the base query is dropped and only clauses are kept (still
      // bounded because appendStructuredQueryClauses just concatenates).
      const maxBaseLen = Math.max(0, MAX_ENRICHED_QUERY_LEN - clausesStr.length);
      const baseQueryCapped = retrievalCoreQuery.slice(0, maxBaseLen);
      // Hard clamp on the final string — handles the edge case where clauses
      // themselves exceed MAX_ENRICHED_QUERY_LEN (very many exclusions).
      const enrichedRaw = appendStructuredQueryClauses(baseQueryCapped, clauses);
      const enrichedQuery = enrichedRaw.length > MAX_ENRICHED_QUERY_LEN
        ? enrichedRaw.slice(0, MAX_ENRICHED_QUERY_LEN)
        : enrichedRaw;
      const diversityDiscoveryQuery = enrichedQuery;

      // Build structured hard constraints from agent params (price, exclusions)
      // so they flow directly to Vespa as YQL filters.
      const structuredFilters = buildStructuredFilters(parsed);
      const structuredPreferences = buildStructuredPreferences(parsed);
      const effectiveRetrievalMode = normalizeSearchToolRetrievalMode(
        parsed.retrieval_mode,
        structuredFilters,
        structuredPreferences,
      );

      const wantsDiversity = parsed.want_diversity === true || SEARCH_TOOL_WANTS_DIVERSITY_RE.test(parsed.query);
      const effectiveLimit = wantsDiversity
        ? Math.max(parsed.limit ?? SEARCH_TOOL_DIVERSITY_MIN_LIMIT, SEARCH_TOOL_DIVERSITY_MIN_LIMIT)
        : parsed.limit;

      const baseRequest = buildSearchRequestForAgentQuery(
        enrichedQuery,
        effectiveLimit,
        effectiveRetrievalMode,
        structuredFilters,
        structuredPreferences,
      );

      // Create a per-tool-call StageTimer so pipeline stage latencies
      // propagate to the SearchResponseV1.stageTimings field — surfaced in
      // bench reports as the latencyBreakdown section.
      const toolStageTimer = createStageTimer();

      let response: SearchResponseV1 | ComparisonSearchResponse;
      response = await executeSearchWithTypedWineDiversityDiscovery({
        searchUseCase: deps.searchUseCase,
        requestId,
        fallbackRequest: baseRequest,
        effectiveLimit: effectiveLimit ?? SEARCH_TOOL_DIVERSITY_MIN_LIMIT,
        shouldRun: shouldRunTypedWineDiversityDiscovery({
          query: parsed.query,
          wantsDiversity,
          wineType: parsed.wine_type,
        }),
        buildTypedRequest: (wineType) =>
          buildSearchRequestForAgentQuery(
            diversityDiscoveryQuery,
            SEARCH_TOOL_DIVERSITY_LIMIT_PER_TYPE,
            effectiveRetrievalMode,
            withWineTypeFilter(structuredFilters, wineType, 'agent_tool_diversity_v1'),
            structuredPreferences,
          ),
        ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
        ...(deps.corpusCardinality !== undefined ? { corpusCardinality: deps.corpusCardinality } : {}),
        stageTimer: toolStageTimer,
      });

      if (response.queryType === 'comparison') {
        return {
          observation: summarizeComparison(response),
          rawResult: response,
          structuredOutput: { kind: 'comparison_result', response },
        };
      }

      // Negation post-filter: exclude results whose identity fields contain negated terms.
      // Checks canonicalLabel, grapes array, and all NEGATION_ENTITY_STRING_FIELDS.
      const negTerms = collectSearchToolNegationTerms(parsed);
      if (negTerms.length > 0) {
        const negationFiltered = applySearchToolNegationResultPolicy(response, negTerms);
        if (negationFiltered.filteredCount > 0) {
          if (negationFiltered.fallbackToUnfiltered) {
            return {
              observation:
                `[NEGATION_FALLBACK: All ${response.results.length} result(s) matched excluded terms (${negTerms.join(', ')}). `
                + `Showing unfiltered results — YOU MUST skip any wine whose grape/region matches the excluded terms and recommend only the non-matching ones. `
                + `If all wines match, tell the user and suggest broadening.]\n`
                + summarizeSearchResults(response, wantsDiversity, {
                  requestedQuery: parsed.query,
                  requestedRetrievalMode: effectiveRetrievalMode,
                  requestedRecipientProfile: parsed.recipient_profile,
                }),
              rawResult: response,
              structuredOutput: {
                kind: 'search_result_set',
                resultSet: response.results,
                resultCount: response.results.length,
              },
            };
          }
          response = negationFiltered.response;
          return {
            observation: appendObservationNote(
              summarizeSearchResults(response, wantsDiversity, {
                requestedQuery: parsed.query,
                requestedRetrievalMode: effectiveRetrievalMode,
                requestedRecipientProfile: parsed.recipient_profile,
              }),
              `[Excluded ${negationFiltered.filteredCount} result(s) matching negation terms: ${negTerms.join(', ')}]`,
            ),
            rawResult: response,
            structuredOutput: {
              kind: 'search_result_set',
              resultSet: response.results,
              resultCount: response.results.length,
            },
          };
        }
      }

      // Price post-filter: when agent specified a budget bound/range, drop results
      // whose priceRange falls outside it. The search pipeline does not have a
      // native price filter — price bounds are text hints — so out-of-range
      // results can slip through. This post-filter gives the agent accurate
      // budget-aware results.
      if (parsed.min_price_krw !== undefined || parsed.max_price_krw !== undefined) {
        response = applySearchToolBudgetResultPolicy(
          response,
          {
            minKrw: parsed.min_price_krw,
            maxKrw: parsed.max_price_krw,
          },
          { krwPerUsd: KRW_PER_USD_APPROXIMATE },
        ).response;
      }

      const alcoholPreference = applySearchToolAlcoholPreference(response, parsed.max_alcohol_pct);
      response = alcoholPreference.response;

      // Zero-result escalation: guide the agent to relax constraints one by one,
      // or signal corpus exhaustion when the wine type has very few entries.
      if (response.results.length === 0) {
        const corpusLimited =
          typeof parsed.wine_type === 'string'
          && parsed.wine_type.length > 0
          && (deps.corpusCardinality?.isCorpusLimited(parsed.wine_type) ?? false);
        const tag = corpusLimited
          ? `[RETRIEVAL_QUALITY: corpus_limited — this wine type has very few entries in the database]\n이 타입의 와인이 데이터베이스에 매우 적습니다. 검색어: "${parsed.query}". 재검색하지 말고, 가능한 범위에서 답변하거나 더 넓은 카테고리를 제안하세요.`
          : `[RETRIEVAL_QUALITY: unreliable — 0 results]\n검색 결과가 없습니다. 검색어: "${parsed.query}". 힌트: 조건을 하나씩 줄여서 재검색하세요 (예: 가격 조건 제거 → 품종만으로 재검색).`;
        return {
          observation: tag,
          rawResult: response,
          structuredOutput: { kind: 'search_result_set', resultSet: [], resultCount: 0 },
        };
      }

      // Multi-constraint hint: when 3+ constraint types are detected, remind the
      // agent it can relax constraints if results are insufficient.
      const summaryContext = {
        requestedQuery: parsed.query,
        requestedRetrievalMode: effectiveRetrievalMode,
        requestedRecipientProfile: parsed.recipient_profile,
      };
      const exactLookupContractViolation = needsResolvedExactLabelContractGuard(response, summaryContext);
      let obs = summarizeSearchResults(response, wantsDiversity, summaryContext);
      const constraintHints = detectConstraintKeywords(parsed.query);
      if (constraintHints.length >= MIN_CONSTRAINTS_FOR_STAGED_HINT) {
        obs = appendObservationNote(
          obs,
          `[감지된 조건 ${constraintHints.length}개: ${constraintHints.join(', ')}. 결과가 부족하면 조건을 하나씩 제거하며 재검색하세요.]`,
        );
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
      if (isAccessibleOnlineTastingQuery(parsed.query)) {
        obs = appendObservationNote(
          obs,
          '[ACCESSIBILITY_GROUNDING: User asked for wines all online-tasting participants can access. This corpus does not expose retailer inventory, supermarket listings, or real-time stock. Use only grounded wine/price/popularity fields; do not claim a specific store carries a bottle. Explicitly tell the user to confirm availability through their chosen retailer before the event.]',
        );
      }

      // Price filter context: when a budget bound/range was applied, annotate
      // the observation so the agent can explicitly cite the enforced range even
      // when some per-wine prices are sparse in the index.
      const priceFilterObservation = buildPriceFilterObservation(parsed);
      if (priceFilterObservation !== undefined) {
        obs = appendObservationNote(obs, priceFilterObservation);
      }
      if (parsed.max_alcohol_pct !== undefined && (alcoholPreference.demotedCount > 0 || alcoholPreference.unknownCount > 0)) {
        obs = appendObservationNote(
          obs,
          `[ALCOHOL_PREFERENCE: ${parsed.max_alcohol_pct}% 이하를 우선 정렬했습니다. 검증된 초과 도수 ${alcoholPreference.demotedCount}개 결과는 뒤로 보냈고, 도수 정보가 없는 후보 ${alcoholPreference.unknownCount}개는 유지했습니다.]`,
        );
      }

      return {
        observation: obs,
        rawResult: response,
        structuredOutput: {
          kind: 'search_result_set',
          resultSet: exactLookupContractViolation !== undefined ? [] : response.results,
          resultCount: exactLookupContractViolation !== undefined ? 0 : response.results.length,
        },
      };
    }

    case 'lookup_wine': {
      const parseResult = LookupWineInputSchema.safeParse(sanitizeOptionalToolNulls(input));
      if (!parseResult.success) {
        const msg = parseResult.error.issues.map((i) => i.message).join(', ');
        return {
          observation: `Invalid input for lookup_wine: ${msg}`,
          rawResult: null,
          structuredOutput: { kind: 'tool_error', errorCode: 'INVALID_INPUT', message: msg },
        };
      }
      const parsed = parseResult.data;
      const limit = Math.min(parsed.limit ?? LOOKUP_WINE_LIMIT_MAX, LOOKUP_WINE_LIMIT_MAX);

      // High-precision identity resolution: force the entity route, no filters.
      // This is the dedicated "find THIS wine" primitive; constraint-filtered
      // discovery belongs to search_wines.
      const response = await deps.searchUseCase.execute(
        {
          query: parsed.query,
          limit,
          options: { mode: 'entity', explain: false, clarification: false },
        },
        requestId,
        { ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}) },
      );

      if (response.queryType !== 'search') {
        return {
          observation: 'Unexpected response type for wine lookup.',
          rawResult: response,
          structuredOutput: { kind: 'tool_error', errorCode: 'UNEXPECTED_RESPONSE_TYPE', message: `expected search, got ${response.queryType}` },
        };
      }

      if (response.results.length === 0) {
        return {
          observation: `[LOOKUP_QUALITY: not_found — 0 exact matches]\n"${parsed.query}"에 해당하는 와인을 찾지 못했습니다. 이름 철자를 확인하거나, 조건 탐색이 필요하면 search_wines 를 사용하세요.`,
          rawResult: response,
          structuredOutput: { kind: 'search_result_set', resultSet: [], resultCount: 0 },
        };
      }

      const obs = summarizeSearchResults(response, false, {
        requestedQuery: parsed.query,
        requestedRetrievalMode: 'entity',
      });
      return {
        observation: `[LOOKUP_RESULT: ${response.results.length} exact match(es)]\n${obs}`,
        rawResult: response,
        structuredOutput: {
          kind: 'search_result_set',
          resultSet: response.results,
          resultCount: response.results.length,
        },
      };
    }

    case 'compare_wines': {
      const parseResult = CompareInputSchema.safeParse(sanitizeOptionalToolNulls(input));
      if (!parseResult.success) {
        const msg = parseResult.error.issues.map((i) => i.message).join(', ');
        return {
          observation: `Invalid input for compare_wines: ${msg}`,
          rawResult: null,
          structuredOutput: { kind: 'tool_error', errorCode: 'INVALID_INPUT', message: msg },
        };
      }
      const parsed = parseResult.data;
      if (deps.decomposedSearchExecute === undefined) {
        return {
          observation: 'Compare tool not available.',
          rawResult: null,
          structuredOutput: { kind: 'no_op', reason: 'decomposedSearchExecute port not wired' },
        };
      }
      const sharedContextInput = stripSideSpecificCompareSharedConstraints(parsed);
      const sharedFilters = buildStructuredFilters(sharedContextInput);
      const sharedPreferences = buildStructuredPreferences(sharedContextInput);
      const baseRetrievalQueries = buildCompareBaseRetrievalQueries(parsed);
      const [sideAOverrides, sideBOverrides] = buildCompareSideOverrides(parsed);
      const sideSpecificFilters = [
        buildCompareSideOnlyFilters(sideAOverrides),
        buildCompareSideOnlyFilters(sideBOverrides),
      ] as const;
      const retrievalSubQueries = [
        buildStructuredQuery({
          ...sharedContextInput,
          query: baseRetrievalQueries[0],
          grape_primary: sideAOverrides.grape_primary ?? sharedContextInput.grape_primary,
          wine_type: sideAOverrides.wine_type ?? sharedContextInput.wine_type,
          country: sideAOverrides.country ?? sharedContextInput.country,
          region: sideAOverrides.region ?? sharedContextInput.region,
          appellation: sideAOverrides.appellation ?? sharedContextInput.appellation,
          vintage_min: sideAOverrides.vintage_min ?? sharedContextInput.vintage_min,
          vintage_max: sideAOverrides.vintage_max ?? sharedContextInput.vintage_max,
          preserveRepresentativeSearch: true,
        }),
        buildStructuredQuery({
          ...sharedContextInput,
          query: baseRetrievalQueries[1],
          grape_primary: sideBOverrides.grape_primary ?? sharedContextInput.grape_primary,
          wine_type: sideBOverrides.wine_type ?? sharedContextInput.wine_type,
          country: sideBOverrides.country ?? sharedContextInput.country,
          region: sideBOverrides.region ?? sharedContextInput.region,
          appellation: sideBOverrides.appellation ?? sharedContextInput.appellation,
          vintage_min: sideBOverrides.vintage_min ?? sharedContextInput.vintage_min,
          vintage_max: sideBOverrides.vintage_max ?? sharedContextInput.vintage_max,
          preserveRepresentativeSearch: true,
        }),
      ] as const;
      const rawSubQueries = [parsed.query_a, parsed.query_b] as const;
      const response = await deps.decomposedSearchExecute(
        rawSubQueries,
        'compare',
        buildComparisonOriginalQuery(sharedContextInput),
        requestId,
        Date.now(),
        sharedFilters.length > 0 || sharedPreferences.length > 0 || sideSpecificFilters.some((entries) => entries.length > 0)
          ? {
              ...(sharedFilters.length > 0 ? { filters: sharedFilters } : {}),
              ...(sharedPreferences.length > 0 ? { preferences: sharedPreferences } : {}),
              ...(sideSpecificFilters.some((entries) => entries.length > 0)
                ? {
                    perSideFilters: sideSpecificFilters.map((entries) =>
                      entries.length > 0 ? entries : undefined,
                    ) as [
                      readonly NormalizedConstraint[] | undefined,
                      readonly NormalizedConstraint[] | undefined,
                    ],
                  }
                : {}),
            }
          : undefined,
        options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : undefined,
        retrievalSubQueries,
      );
      const rescuedResponse = await rescueExactComparisonResponse(
        response,
        deps,
        requestId,
        retrievalSubQueries,
        sharedFilters,
        sharedPreferences,
        sideSpecificFilters,
        [sideAOverrides, sideBOverrides] as const,
        options,
      );
      return {
        observation: summarizeComparison(rescuedResponse),
        rawResult: rescuedResponse,
        structuredOutput: { kind: 'comparison_result', response: rescuedResponse },
      };
    }

    case 'check_drinking_window': {
      const parseResult = DrinkingWindowInputSchema.safeParse(sanitizeOptionalToolNulls(input));
      if (!parseResult.success) {
        const msg = parseResult.error.issues.map((i) => i.message).join(', ');
        return {
          observation: `Invalid input for check_drinking_window: ${msg}`,
          rawResult: null,
          structuredOutput: { kind: 'tool_error', errorCode: 'INVALID_INPUT', message: msg },
        };
      }
      const parsed = parseResult.data;
      const targetYear = parsed.target_year ?? new Date().getFullYear();
      const entityId = createCanonicalEntityId(parsed.entity_id);
      const groundedProjection = deps.groundedDrinkingWindowLookup?.(entityId);
      if (groundedProjection !== undefined) {
        const grounded = buildDrinkingWindowToolResult(groundedProjection, targetYear);
        if (grounded.structuredOutput.kind !== 'no_op') {
          return grounded;
        }
      }

      if (deps.drinkingWindowEntityLookup !== undefined) {
        const entity = await deps.drinkingWindowEntityLookup(entityId);
        if (entity === undefined) {
          return {
            observation: `Wine ${parsed.entity_id} not found.`,
            rawResult: null,
            structuredOutput: { kind: 'tool_error', errorCode: 'ENTITY_NOT_FOUND', message: `entity ${parsed.entity_id} not found` },
          };
        }
        return buildDrinkingWindowToolResultWithSearchFallback(
          entity,
          targetYear,
          deps,
          requestId,
          options,
        );
      }

      // Prefer direct entity lookup (O(1) Vespa GET) over the full search
      // pipeline (planner → retrieval → ranking → decision). The search-as-lookup
      // approach was fundamentally broken: it used the entity_id as a natural-language
      // query, which ran NL parsing, fuzzy matching, and ranking on an opaque ID.
      if (deps.entityLookup !== undefined) {
        const doc = await deps.entityLookup(entityId);
        if (doc === undefined) {
          return {
            observation: `Wine ${parsed.entity_id} not found.`,
            rawResult: null,
            structuredOutput: { kind: 'tool_error', errorCode: 'ENTITY_NOT_FOUND', message: `entity ${parsed.entity_id} not found` },
          };
        }
        return buildDrinkingWindowToolResultWithSearchFallback(
          doc,
          targetYear,
          deps,
          requestId,
          options,
        );
      }

      // Fallback: search-as-lookup when entityLookup port is not wired.
      const searchResult = await deps.searchUseCase.execute(
        { query: parsed.entity_id, options: { mode: 'entity', explain: false, clarification: false } },
        requestId,
        { ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}) },
      );
      const firstResult = searchResult.queryType === 'search' ? searchResult.results[0] : undefined;
      if (firstResult === undefined) {
        return {
          observation: `Wine ${parsed.entity_id} not found.`,
          rawResult: null,
          structuredOutput: { kind: 'tool_error', errorCode: 'ENTITY_NOT_FOUND', message: `entity ${parsed.entity_id} not found via search fallback` },
        };
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
          structuredOutput: {
            kind: 'drinking_window',
            entityId: firstResult.entity.entityId,
            window: dw,
            targetYear,
          },
        };
      }
      return {
        observation: `${sanitizeObservationField(firstResult.entity.canonicalLabel)}: no drinking window data available.`,
        rawResult: null,
        structuredOutput: { kind: 'no_op', reason: 'drinking window data absent on entity (search fallback)' },
      };
    }

    case 'get_food_pairings': {
      const parseResult = FoodPairingInputSchema.safeParse(sanitizeOptionalToolNulls(input));
      if (!parseResult.success) {
        const msg = parseResult.error.issues.map((i) => i.message).join(', ');
        return {
          observation: `Invalid input for get_food_pairings: ${msg}`,
          rawResult: null,
          structuredOutput: { kind: 'tool_error', errorCode: 'INVALID_INPUT', message: msg },
        };
      }
      const parsed = parseResult.data;
      const budgetKrw = resolveFoodPairingBudgetKrw(parsed, {
        krwPerUsd: KRW_PER_USD_APPROXIMATE,
        maxPriceKrwCap: MAX_PRICE_KRW_BOUND,
      });
      const queryBase = `wine pairing for ${parsed.food}`;
      const query = appendStructuredQueryClauses(
        queryBase,
        [
          ...(budgetKrw !== undefined ? [`${budgetKrw}원 이하`] : []),
          ...(parsed.styles !== undefined ? [...parsed.styles] : []),
          ...(parsed.pairing_tags !== undefined ? [...parsed.pairing_tags] : []),
        ],
      );
      const structuredFilters = buildFoodPairingStructuredFilters(parsed, AGENT_FILTER_VERSION);
      const structuredPreferences = buildFoodPairingStructuredPreferences(parsed, AGENT_FILTER_VERSION);
      const rawResponseWithContext = await deps.searchUseCase.execute(
        {
          query,
          options: { mode: 'hybrid', explain: false, clarification: false },
          ...(structuredFilters.length > 0 ? { filters: structuredFilters } : {}),
          ...(structuredPreferences.length > 0 ? { preferences: structuredPreferences } : {}),
        },
        requestId,
        { ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}) },
      );

      if (rawResponseWithContext.queryType !== 'search') {
        return {
          observation: 'Unexpected response type for pairing search.',
          rawResult: rawResponseWithContext,
          structuredOutput: { kind: 'tool_error', errorCode: 'UNEXPECTED_RESPONSE_TYPE', message: `expected search, got ${rawResponseWithContext.queryType}` },
        };
      }
      const responseWithContext = closeFoodPairingMacroEvidence(rawResponseWithContext, parsed);
      // Enrich with pairing context so the LLM gives a richer answer that
      // explains WHY each wine pairs with the food (not just "here are results").
      const baseObs = summarizeSearchResults(responseWithContext);
      const hasSpicyPairingObjective = parsed.pairing_tags?.includes('spicy_food') === true;
      const hasSweetHeatBalanceObjective = parsed.styles?.some((style) => style === 'off_dry' || style === 'sweet') === true;
      const pairingHint = [
        '',
        `PAIRING_CONTEXT: These wines were matched for "${parsed.food}" pairing.`,
        ...(parsed.styles !== undefined && parsed.styles.length > 0
          ? [`PAIRING_OBJECTIVE_STYLES: ${parsed.styles.join(', ')}`]
          : []),
        ...(parsed.pairing_tags !== undefined && parsed.pairing_tags.length > 0
          ? [`PAIRING_OBJECTIVE_TAGS: ${parsed.pairing_tags.join(', ')}`]
          : []),
        ...(hasSpicyPairingObjective || hasSweetHeatBalanceObjective
          ? ['PAIRING_STYLE_GUIDANCE: For spicy food, explicitly preserve the heat-balance objective: off-dry or slightly sweet, refreshing acidity, and low tannin. If GROUNDING_JSON lacks sweetness/acidity/tannin for a candidate, say that field is unavailable instead of reframing the match as generic dry white.']
          : []),
        'When synthesizing your answer, explain WHY each wine pairs well with the food (acidity, tannin, body, flavour bridge).',
        'Include practical serving suggestions (temperature, decanting) if relevant.',
      ].join('\n');
      return {
        observation: `${pairingHint.trim()}\n${baseObs}`,
        rawResult: responseWithContext,
        structuredOutput: {
          kind: 'food_pairing',
          resultSet: responseWithContext.results,
          resultCount: responseWithContext.results.length,
          food: parsed.food,
        },
      };
    }

    default:
      return {
        observation: `Unknown tool: ${toolName}`,
        rawResult: null,
        structuredOutput: { kind: 'no_op', reason: `unknown tool: ${toolName}` },
      };
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

interface SearchObservationSummaryContext {
  readonly requestedQuery?: string | undefined;
  readonly requestedRetrievalMode?: z.infer<typeof SearchInputSchema>['retrieval_mode'] | undefined;
  readonly requestedRecipientProfile?: RecipientProfileValue | undefined;
}

function isPricePositioningQuestion(query: string | undefined): boolean {
  if (query === undefined) {
    return false;
  }
  return /(?:비싼\s*편|비싼편|고가|가격대|price\s*position|expensive|cheap|가격\s*포지션)/iu.test(query);
}

function normalizeExactLookupLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .normalize('NFKC')
    .replace(/&/gu, 'and')
    .replace(/[^a-z0-9가-힣]+/gu, '');
}

function buildExactLookupAliasVariants(canonicalValue: string): readonly string[] {
  const variants = new Set<string>([canonicalValue]);
  for (const alias of CURATED_ENTITY_ALIAS_CATALOG) {
    if (
      alias.mappedAttribute === 'appellation'
      && alias.resolutionMode === 'direct'
      && alias.canonicalValue === canonicalValue
    ) {
      variants.add(alias.surface);
    }
  }
  return [...variants];
}

// EXPORT NOTE: this helper is exported solely so that
// `test/regression/entity-lookup-provenance-properties.regression.test.ts`
// can run a parity check against a richer reference implementation that also
// returns provenance/surface. Do NOT change the return shape without updating
// the parity test in lockstep — the test depends on the exported function
// returning the same `canonicalValue` as the test's reference implementation
// for every CURATED catalog surface.
export function resolveCuratedExactLookupTarget(query: string | undefined): { readonly canonicalValue: string; readonly acceptedVariants: readonly string[] } | undefined {
  if (query === undefined) return undefined;
  const normalizedQuery = normalizeExactLookupLabel(query).replace(EXACT_LOOKUP_OPTIONAL_VINTAGE_RE, '');
  if (normalizedQuery.length === 0) return undefined;

  const candidates = CURATED_ENTITY_ALIAS_CATALOG
    .filter((alias) =>
      alias.mappedAttribute === 'appellation'
      && alias.resolutionMode === 'direct'
      && normalizeExactLookupLabel(alias.surface) === normalizedQuery,
    )
    .sort((a, b) => b.surface.length - a.surface.length);
  const target = candidates[0];
  if (target === undefined) return undefined;
  return {
    canonicalValue: target.canonicalValue,
    acceptedVariants: buildExactLookupAliasVariants(target.canonicalValue),
  };
}

function resolveCuratedNonExactLookupPolicy(query: string | undefined): { readonly surface: string; readonly reason: string } | undefined {
  if (query === undefined) return undefined;
  const normalizedQuery = normalizeExactLookupLabel(query);
  const exactSurfacePolicy = NON_EXACT_LOOKUP_SURFACE_CATALOG.find((entry) =>
    normalizeExactLookupLabel(entry.surface) === normalizedQuery
    || (
      entry.allowAugmentedQueryPrefix === true
      && normalizedQuery.startsWith(normalizeExactLookupLabel(entry.surface))
    ),
  );
  if (exactSurfacePolicy !== undefined) return exactSurfacePolicy;

  if (!NON_EXACT_LOOKUP_INTENT_RE.test(query)) {
    return undefined;
  }
  const embeddedExactAlias = CURATED_ENTITY_ALIAS_CATALOG
    .filter((alias) =>
      alias.mappedAttribute === 'appellation'
      && alias.resolutionMode === 'direct',
    )
    .sort((a, b) => b.surface.length - a.surface.length)
    .find((alias) => {
      const normalizedAlias = normalizeExactLookupLabel(alias.surface);
      return normalizedAlias.length > 0 && normalizedQuery.includes(normalizedAlias);
    });
  if (embeddedExactAlias === undefined) {
    return undefined;
  }
  return {
    surface: query.trim(),
    reason: `non-exact lookup intent around ${embeddedExactAlias.canonicalValue}; not a single confirmed wine entity request`,
  };
}

function exactLookupLabelMatchesTarget(label: string, acceptedVariants: readonly string[]): boolean {
  const normalizedLabel = normalizeExactLookupLabel(label);
  const normalizedLabelWithoutLeadingVintage = normalizedLabel.replace(EXACT_LOOKUP_OPTIONAL_LEADING_VINTAGE_RE, '');
  return acceptedVariants.some((variant) => {
    const normalizedVariant = normalizeExactLookupLabel(variant);
    if (normalizedVariant.length === 0) return false;
    const normalizedVariantWithoutChateau = normalizedVariant.replace(EXACT_LOOKUP_CHATEAU_PREFIX_RE, '');
    const accepted = new Set([normalizedVariant, normalizedVariantWithoutChateau].filter((value) => value.length > 0));
    return [...accepted].some((candidate) =>
      normalizedLabel === candidate
      || normalizedLabelWithoutLeadingVintage === candidate
      || normalizedLabel === `chateau${candidate}`
      || normalizedLabelWithoutLeadingVintage === `chateau${candidate}`
      || normalizedLabel.replace(EXACT_LOOKUP_OPTIONAL_VINTAGE_RE, '') === candidate
      || normalizedLabel.replace(EXACT_LOOKUP_OPTIONAL_VINTAGE_RE, '') === `chateau${candidate}`
      || exactLookupLabelIsRepeatedGrandVinSurface(label, candidate),
    );
  });
}

function exactLookupCanonicalLabelMatchesTarget(label: string, acceptedVariants: readonly string[]): boolean {
  if (exactLookupLabelMatchesTarget(label, acceptedVariants)) return true;

  const normalizedLabel = normalizeExactLookupLabel(label);
  const normalizedLabelWithoutLeadingVintage = normalizedLabel.replace(EXACT_LOOKUP_OPTIONAL_LEADING_VINTAGE_RE, '');
  return acceptedVariants.some((variant) => {
    const normalizedVariant = normalizeExactLookupLabel(variant);
    if (normalizedVariant.length === 0) return false;
    const normalizedVariantWithoutChateau = normalizedVariant.replace(EXACT_LOOKUP_CHATEAU_PREFIX_RE, '');
    const accepted = new Set([normalizedVariant, normalizedVariantWithoutChateau].filter((value) => value.length > 0));
    return [...accepted].some((candidate) =>
      candidate.length >= EXACT_LOOKUP_SUFFIX_MATCH_MIN_CHARS
      && normalizedLabelWithoutLeadingVintage.length > candidate.length
      && normalizedLabelWithoutLeadingVintage.endsWith(candidate),
    );
  });
}

function exactLookupLabelIsRepeatedGrandVinSurface(label: string, normalizedTarget: string): boolean {
  const normalizedLabel = normalizeExactLookupLabel(label.replace(/\([^)]*\)/gu, ' '))
    .replace(EXACT_LOOKUP_OPTIONAL_LEADING_VINTAGE_RE, '')
    .replace(EXACT_LOOKUP_OPTIONAL_VINTAGE_RE, '');
  const targetForms = [
    normalizedTarget,
    `chateau${normalizedTarget.replace(EXACT_LOOKUP_CHATEAU_PREFIX_RE, '')}`,
  ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);

  return targetForms.some((targetForm) =>
    normalizedLabel.length > targetForm.length
    && normalizedLabel.split(targetForm).join('').length === 0,
  );
}

function exactLookupResultMatchesTarget(
  result: SearchResponseV1['results'][number],
  acceptedVariants: readonly string[],
): boolean {
  if (exactLookupCanonicalLabelMatchesTarget(result.entity.canonicalLabel, acceptedVariants)) {
    return true;
  }

  const fields = [
    result.entity.producer,
    result.entity.appellation,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return fields.some((field) => exactLookupLabelMatchesTarget(field, acceptedVariants));
}

function needsResolvedExactLabelContractGuard(
  response: SearchResponseV1,
  context: SearchObservationSummaryContext | undefined,
): { readonly target: string; readonly observedLabels: readonly string[]; readonly nonExactReason?: string | undefined } | undefined {
  const observedLabels = response.results
    .map((result) => result.entity.canonicalLabel)
    .filter((label) => label.trim().length > 0);
  if (observedLabels.length === 0) return undefined;

  const nonExactPolicy = resolveCuratedNonExactLookupPolicy(context?.requestedQuery);
  if (nonExactPolicy !== undefined) {
    return {
      target: nonExactPolicy.surface,
      nonExactReason: nonExactPolicy.reason,
      observedLabels,
    };
  }

  const target = resolveCuratedExactLookupTarget(context?.requestedQuery);
  if (target === undefined) return undefined;
  const hasExactLabelMatch = hasCuratedExactLookupConfirmedEvidence(response.results, target.acceptedVariants);
  return hasExactLabelMatch
    ? undefined
    : { target: target.canonicalValue, observedLabels };
}

function hasCuratedExactLookupConfirmedEvidence(
  results: readonly SearchResponseV1['results'][number][],
  acceptedVariants: readonly string[],
): boolean {
  if (results.some((result) => exactLookupCanonicalLabelMatchesTarget(result.entity.canonicalLabel, acceptedVariants))) {
    return true;
  }
  const identityMatches = results.filter((result) => exactLookupResultMatchesTarget(result, acceptedVariants));
  return identityMatches.length === 1;
}

function hasCuratedExactLookupIdentityEvidence(
  response: SearchResponseV1,
  context: SearchObservationSummaryContext | undefined,
): boolean {
  const target = resolveCuratedExactLookupTarget(context?.requestedQuery);
  if (target === undefined) return false;
  return hasCuratedExactLookupConfirmedEvidence(response.results, target.acceptedVariants);
}

function selectCuratedExactLookupSummaryResults(
  results: readonly SearchResponseV1['results'][number][],
  context: SearchObservationSummaryContext | undefined,
): readonly SearchResponseV1['results'][number][] | undefined {
  const target = resolveCuratedExactLookupTarget(context?.requestedQuery);
  if (target === undefined) return undefined;

  const canonicalMatches = results.filter((result) =>
    exactLookupCanonicalLabelMatchesTarget(result.entity.canonicalLabel, target.acceptedVariants),
  );
  if (canonicalMatches.length > 0) return canonicalMatches;

  const identityMatches = results.filter((result) =>
    exactLookupResultMatchesTarget(result, target.acceptedVariants),
  );
  return identityMatches.length === 1 ? identityMatches : undefined;
}

function summarizeSearchResults(
  response: SearchResponseV1,
  diversify = false,
  context?: SearchObservationSummaryContext,
): string {
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

  const exactLookupDisplayResults = selectCuratedExactLookupSummaryResults(results, context);
  const displayResults = exactLookupDisplayResults ?? (context?.requestedRecipientProfile !== undefined
    ? selectRecipientProfileSummaryResults(results, SUMMARY_TOP_N, context.requestedRecipientProfile)
    : diversify
      ? selectDiverseSummaryResults(results, SUMMARY_TOP_N)
      : results);

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
    if (r.entity.closure) parts.push(`closure: ${sanitizeObservationField(r.entity.closure)}`);
    if (r.entity.country) parts.push(`country: ${sanitizeObservationField(r.entity.country)}`);
    if (r.entity.producerPrestige !== undefined) parts.push(`producer_prestige: ${r.entity.producerPrestige}`);
    if (Number.isFinite(r.match.scoreComponents.popularity)) parts.push(`popularity_score: ${r.match.scoreComponents.popularity}`);
    if (r.entity.wineType) parts.push(`wine_type: ${sanitizeObservationField(r.entity.wineType)}`);
    if (r.entity.vintage) parts.push(`vintage: ${r.entity.vintage}`);
    if (r.entity.grapes !== undefined && r.entity.grapes.length > 0) {
      parts.push(`grapes: ${r.entity.grapes.slice(0, 3).map(sanitizeObservationField).join(', ')}`);
    }
    if (r.entity.style) parts.push(`style: ${sanitizeObservationField(r.entity.style)}`);
    if (r.entity.criticScore !== undefined && Number.isFinite(r.entity.criticScore)) parts.push(`critic: ${(r.entity.criticScore * 100).toFixed(0)}/100`);
    if (r.entity.body !== undefined) parts.push(`body: ${r.entity.body}`);
    if (r.entity.tannin !== undefined) parts.push(`tannin: ${r.entity.tannin}`);
    if (r.entity.acidity !== undefined) parts.push(`acidity: ${r.entity.acidity}`);
    if (r.entity.sweetness !== undefined) parts.push(`sweetness: ${r.entity.sweetness}`);
    if (context?.requestedRecipientProfile !== undefined) {
      const profileEvidenceAxes = recipientProfileEvidenceAxes(
        resultToRecipientProfileCandidate(r),
        context.requestedRecipientProfile,
      );
      if (profileEvidenceAxes.length > 0) {
        parts.push(`recipient_profile: ${context.requestedRecipientProfile}`);
        parts.push(`profile_evidence: ${profileEvidenceAxes.join(', ')}`);
      }
    }
    if (r.entity.alcoholPct !== undefined) parts.push(`alc: ${r.entity.alcoholPct}%`);
    if (r.entity.priceRange !== undefined) {
      parts.push(`price: ${buildObservationPriceText(r.entity.priceRange)}`);
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
  const isEntityResolutionResponse =
    response.retrievalMode === 'entity_lookup'
    || response.retrievalMode === 'entity_resolution'
    || context?.requestedRetrievalMode === 'entity';
  const resolvedExactLabelContractViolation = needsResolvedExactLabelContractGuard(response, context);
  const curatedExactIdentityEvidence = hasCuratedExactLookupIdentityEvidence(response, context);
  const needsExactResolutionGuard =
    (engineDecision.decisionStatus !== 'resolved' && isEntityResolutionResponse && !curatedExactIdentityEvidence)
    || resolvedExactLabelContractViolation !== undefined;
  const resolutionGuard = !needsExactResolutionGuard
    ? ''
    : (
      'EXACT_LOOKUP_NEGATIVE: DO NOT answer with any listed wine label as the exact answer. '
      + 'Say no single exact wine entity is confirmed by current evidence; ask for a clarifying exact label or constraints.\n'
      + `RESOLUTION_NOT_CONFIRMED: engine decision is ${engineDecision.decisionStatus}`
      + ` with next_action=${engineDecision.nextAction}. `
      + (
        resolvedExactLabelContractViolation === undefined
          ? ''
          : (
            `Exact-label contract target=${resolvedExactLabelContractViolation.target}`
            + (
              resolvedExactLabelContractViolation.nonExactReason === undefined
                ? ''
                : `; non_exact_surface_reason=${resolvedExactLabelContractViolation.nonExactReason}. `
                  + 'This query is a brand/category/region surface, not a confirmed single wine entity. '
                  + 'For exact-lookup answers, do not name any returned wine label as the answer; ask for clarification or state that the surface is not a single exact entity. '
                  + 'Never say "candidate", "example", "confirmed one item", "정확한 1종", "후보", "예시", or "확인된 항목" for this query. '
            )
            + `; observed_count=${resolvedExactLabelContractViolation.observedLabels.length}. `
          )
      )
      + 'Treat listed wines as candidates/evidence only; do not state any candidate as the confirmed exact match. '
      + 'For exact-entity questions, ask a targeted clarification or explicitly say the exact wine is not confirmed by current evidence.\n'
    );
  if (resolvedExactLabelContractViolation !== undefined) {
    return (
      resolutionGuard
      + `Exact-lookup negative surface: "${sanitizeObservationField(resolvedExactLabelContractViolation.target)}" is not a single confirmed wine entity. `
      + 'Returned wine labels are intentionally withheld from this observation so the final answer cannot promote them as exact matches.\n'
      + `GROUNDING_JSON: ${JSON.stringify({
        query_type: response.queryType,
        total_results: response.results.length,
        wines: [],
        exact_lookup_negative: {
          target: resolvedExactLabelContractViolation.target,
          reason: resolvedExactLabelContractViolation.nonExactReason
            ?? 'no single canonical exact label was confirmed for the curated exact-lookup target',
        },
      })}`
    );
  }
  const resolvedExactTarget = !needsExactResolutionGuard && isEntityResolutionResponse && (
    engineDecision.decisionStatus === 'resolved'
    || curatedExactIdentityEvidence
  )
    ? resolveCuratedExactLookupTarget(context?.requestedQuery)
    : undefined;
  const positiveExactResolution = resolvedExactTarget === undefined
    ? ''
    : `EXACT_LOOKUP_CONFIRMED: exact-label target=${resolvedExactTarget.canonicalValue}; `
      + 'you may answer that this is the confirmed exact entity from current evidence. '
      + 'Do not restate query suffix-noise such as region/country/type/grape/vintage as factual attributes unless those exact attributes appear in the listed result fields or GROUNDING_JSON.\n';
  const pricePositioningGuard = isPricePositioningQuestion(context?.requestedQuery)
    ? (
        'PRICE_POSITIONING_INSUFFICIENT_CONTEXT: The user asks for relative price positioning. '
        + 'A single observed bottle/vintage price is not distributional market evidence. '
        + 'Do not answer that the wine/category is expensive, cheap, or "비싼 편" as a general positioning claim. '
        + 'Only state the observed grounded price fields and say broader price positioning is not confirmed by current evidence.\n'
      )
    : '';
  return `${positiveExactResolution}${resolutionGuard}${pricePositioningGuard}${summary}\n${buildGroundingJsonFromSearch(response, displayResults, context?.requestedRecipientProfile)}`;
}

function normalizeDiversityKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function buildDiversityAxes(
  result: SearchResponseV1['results'][number],
): readonly string[] {
  const firstGrape = result.entity.grapes?.[0];
  return [
    normalizeDiversityKey(result.entity.wineType),
    normalizeDiversityKey(result.entity.region),
    normalizeDiversityKey(result.entity.style),
    normalizeDiversityKey(result.entity.producer),
    normalizeDiversityKey(firstGrape),
  ].filter((value): value is string => value !== undefined);
}

function selectDiverseSummaryResults(
  results: readonly SearchResponseV1['results'][number][],
  limit: number,
): readonly SearchResponseV1['results'][number][] {
  if (results.length <= limit) {
    return results;
  }

  const selected: SearchResponseV1['results'][number][] = [];
  const selectedIds = new Set<string>();
  const coveredAxes = new Set<string>();

  while (selected.length < limit) {
    let bestIndex = -1;
    let bestNoveltyScore = -1;

    for (let index = 0; index < results.length; index += 1) {
      const candidate = results[index];
      if (candidate === undefined || selectedIds.has(candidate.entity.entityId)) {
        continue;
      }
      const noveltyScore = buildDiversityAxes(candidate)
        .reduce((score, axis) => score + (coveredAxes.has(axis) ? 0 : 1), 0);
      if (noveltyScore > bestNoveltyScore) {
        bestNoveltyScore = noveltyScore;
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const chosen = results[bestIndex]!;
    selected.push(chosen);
    selectedIds.add(chosen.entity.entityId);
    for (const axis of buildDiversityAxes(chosen)) {
      coveredAxes.add(axis);
    }
  }

  if (selected.length < limit) {
    for (const candidate of results) {
      if (!selectedIds.has(candidate.entity.entityId)) {
        selected.push(candidate);
        selectedIds.add(candidate.entity.entityId);
      }
      if (selected.length >= limit) {
        break;
      }
    }
  }

  return selected;
}

function resultToRecipientProfileCandidate(
  result: SearchResponseV1['results'][number],
) {
  return {
    wineType: result.entity.wineType,
    style: result.entity.style,
    grapePrimary: result.entity.grapes?.[0],
    grapes: result.entity.grapes,
    region: result.entity.region,
    occasion: result.entity.occasion,
    body: result.entity.body,
    tannin: result.entity.tannin,
    acidity: result.entity.acidity,
    sweetness: result.entity.sweetness,
    producerPrestige: result.entity.producerPrestige,
    popularityScore: result.match.scoreComponents.popularity,
  };
}

interface RecipientProfilePortfolioSlot {
  readonly id: string;
  readonly requiredAxes: readonly RecipientProfileEvidenceAxis[];
  readonly excludedAxes?: readonly RecipientProfileEvidenceAxis[] | undefined;
}

interface RecipientProfileSelectionCandidate {
  readonly result: SearchResponseV1['results'][number];
  readonly index: number;
  readonly axes: readonly RecipientProfileEvidenceAxis[];
  readonly portfolioSlotIds: readonly string[];
}

interface RecipientProfileSelectionObjective {
  readonly portfolioCoverageCount: number;
  readonly portfolioCoverageBySlot: readonly boolean[];
  readonly axisCoverageCount: number;
  readonly matchedCandidateCount: number;
  readonly relevanceSum: number;
  readonly sourceOrderSum: number;
}

function recipientProfilePortfolioSlots(profile: RecipientProfileValue): readonly RecipientProfilePortfolioSlot[] {
  switch (profile) {
    case 'parents_first_time':
      return PARENTS_FIRST_TIME_PORTFOLIO_SLOTS;
    default:
      return [];
  }
}

function axesSatisfyPortfolioSlot(
  axes: readonly RecipientProfileEvidenceAxis[],
  slot: RecipientProfilePortfolioSlot,
): boolean {
  const axisSet = new Set(axes);
  const hasRequiredAxes = slot.requiredAxes.every((axis) => axisSet.has(axis));
  if (!hasRequiredAxes) {
    return false;
  }
  return !(slot.excludedAxes ?? []).some((axis) => axisSet.has(axis));
}

function buildRecipientProfileSelectionCandidate(
  result: SearchResponseV1['results'][number],
  index: number,
  profile: RecipientProfileValue,
  portfolioSlots: readonly RecipientProfilePortfolioSlot[],
): RecipientProfileSelectionCandidate {
  const axes = recipientProfileEvidenceAxes(resultToRecipientProfileCandidate(result), profile);
  return {
    result,
    index,
    axes,
    portfolioSlotIds: portfolioSlots
      .filter((slot) => axesSatisfyPortfolioSlot(axes, slot))
      .map((slot) => slot.id),
  };
}

function evaluateRecipientProfileSelection(
  candidates: readonly RecipientProfileSelectionCandidate[],
  portfolioSlots: readonly RecipientProfilePortfolioSlot[],
): RecipientProfileSelectionObjective {
  const coveredSlotIds = new Set(candidates.flatMap((candidate) => candidate.portfolioSlotIds));
  const coveredAxes = new Set(candidates.flatMap((candidate) => candidate.axes));
  return {
    portfolioCoverageCount: coveredSlotIds.size,
    portfolioCoverageBySlot: portfolioSlots.map((slot) => coveredSlotIds.has(slot.id)),
    axisCoverageCount: coveredAxes.size,
    matchedCandidateCount: candidates.filter((candidate) => candidate.axes.length > 0).length,
    relevanceSum: candidates.reduce(
      (sum, candidate) =>
        sum + (Number.isFinite(candidate.result.relevanceScore) ? candidate.result.relevanceScore : 0),
      0,
    ),
    sourceOrderSum: candidates.reduce((sum, candidate) => sum + candidate.index, 0),
  };
}

function compareRecipientProfileSelectionObjective(
  left: RecipientProfileSelectionObjective,
  right: RecipientProfileSelectionObjective,
): number {
  if (left.portfolioCoverageCount !== right.portfolioCoverageCount) {
    return left.portfolioCoverageCount - right.portfolioCoverageCount;
  }
  for (let index = 0; index < left.portfolioCoverageBySlot.length; index += 1) {
    const leftCovered = left.portfolioCoverageBySlot[index] === true;
    const rightCovered = right.portfolioCoverageBySlot[index] === true;
    if (leftCovered !== rightCovered) {
      return leftCovered ? 1 : -1;
    }
  }
  if (left.axisCoverageCount !== right.axisCoverageCount) {
    return left.axisCoverageCount - right.axisCoverageCount;
  }
  if (left.matchedCandidateCount !== right.matchedCandidateCount) {
    return left.matchedCandidateCount - right.matchedCandidateCount;
  }
  if (left.relevanceSum !== right.relevanceSum) {
    return left.relevanceSum - right.relevanceSum;
  }
  return right.sourceOrderSum - left.sourceOrderSum;
}

function orderRecipientProfileSelection(
  selection: readonly RecipientProfileSelectionCandidate[],
  portfolioSlots: readonly RecipientProfilePortfolioSlot[],
): readonly SearchResponseV1['results'][number][] {
  const selected = [...selection];
  const ordered: RecipientProfileSelectionCandidate[] = [];
  const usedIds = new Set<string>();

  for (const slot of portfolioSlots) {
    const slotCandidate = selected
      .filter((candidate) =>
        !usedIds.has(candidate.result.entity.entityId)
        && candidate.portfolioSlotIds.includes(slot.id))
      .sort((left, right) => {
        const relevanceDelta = right.result.relevanceScore - left.result.relevanceScore;
        return relevanceDelta !== 0 ? relevanceDelta : left.index - right.index;
      })[0];
    if (slotCandidate !== undefined) {
      ordered.push(slotCandidate);
      usedIds.add(slotCandidate.result.entity.entityId);
    }
  }

  ordered.push(
    ...selected
      .filter((candidate) => !usedIds.has(candidate.result.entity.entityId))
      .sort((left, right) => left.index - right.index),
  );
  return ordered.map((candidate) => candidate.result);
}

function selectRecipientProfileSummaryResults(
  results: readonly SearchResponseV1['results'][number][],
  limit: number,
  profile: RecipientProfileValue,
): readonly SearchResponseV1['results'][number][] {
  const selectionSize = Math.min(limit, results.length);
  if (selectionSize <= 0) {
    return [];
  }

  const portfolioSlots = recipientProfilePortfolioSlots(profile);
  const candidates = results.map((result, index) =>
    buildRecipientProfileSelectionCandidate(result, index, profile, portfolioSlots));
  let bestSelection: readonly RecipientProfileSelectionCandidate[] = [];
  let bestObjective: RecipientProfileSelectionObjective | undefined;

  function visit(startIndex: number, currentSelection: readonly RecipientProfileSelectionCandidate[]): void {
    if (currentSelection.length === selectionSize) {
      const objective = evaluateRecipientProfileSelection(currentSelection, portfolioSlots);
      if (
        bestObjective === undefined
        || compareRecipientProfileSelectionObjective(objective, bestObjective) > 0
      ) {
        bestObjective = objective;
        bestSelection = currentSelection;
      }
      return;
    }
    const remainingSlots = selectionSize - currentSelection.length;
    for (let index = startIndex; index <= candidates.length - remainingSlots; index += 1) {
      const candidate = candidates[index];
      if (candidate !== undefined) {
        visit(index + 1, [...currentSelection, candidate]);
      }
    }
  }

  visit(0, []);
  return orderRecipientProfileSelection(bestSelection, portfolioSlots);
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
    if (top.entity.closure) parts.push(`closure: ${sanitizeObservationField(top.entity.closure)}`);
    if (top.entity.country) parts.push(`country: ${sanitizeObservationField(top.entity.country)}`);
    if (top.entity.producerPrestige !== undefined) parts.push(`producer_prestige: ${top.entity.producerPrestige}`);
    if (top.entity.vintage) parts.push(`vintage: ${top.entity.vintage}`);
    if (top.entity.grapes !== undefined && top.entity.grapes.length > 0) {
      parts.push(`grapes: ${top.entity.grapes.slice(0, 3).map(sanitizeObservationField).join(', ')}`);
    }
    if (top.entity.style) parts.push(`style: ${sanitizeObservationField(top.entity.style)}`);
    if (top.entity.criticScore !== undefined && Number.isFinite(top.entity.criticScore)) parts.push(`critic: ${(top.entity.criticScore * 100).toFixed(0)}/100`);
    if (top.entity.body !== undefined) parts.push(`body: ${top.entity.body}`);
    if (top.entity.tannin !== undefined) parts.push(`tannin: ${top.entity.tannin}`);
    if (top.entity.acidity !== undefined) parts.push(`acidity: ${top.entity.acidity}`);
    if (top.entity.sweetness !== undefined) parts.push(`sweetness: ${top.entity.sweetness}`);
    if (top.entity.alcoholPct !== undefined) parts.push(`alc: ${top.entity.alcoholPct}%`);
    if (top.entity.priceRange !== undefined) {
      parts.push(`price: ${buildObservationPriceText(top.entity.priceRange)}`);
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
    if (e.conceptAggregate !== undefined) {
      parts.push(`comparison_concept: ${sanitizeObservationField(e.conceptAggregate.canonicalConcept)}`);
      parts.push(`concept_axis: ${sanitizeObservationField(e.conceptAggregate.conceptEntityType)}`);
      parts.push(`prototype_count: ${e.conceptAggregate.aggregateResultCount}`);
      const prototypePreview = e.conceptAggregate.prototypeAxis
        .slice(0, 3)
        .map((item) => sanitizeObservationField(item.entity.canonicalLabel))
        .join(', ');
      if (prototypePreview.length > 0) {
        parts.push(`prototype_preview: ${prototypePreview}`);
      }
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
  readonly closure?: string;
  readonly country?: string;
  readonly producer_prestige?: number;
  readonly popularity_score?: number;
  readonly wine_type?: string;
  readonly vintage?: number;
  readonly grapes?: readonly string[];
  readonly style?: string;
  readonly critic_score_100?: number;
  readonly body?: number;
  readonly tannin?: number;
  readonly acidity?: number;
  readonly alcohol_pct?: number;
  readonly sweetness?: number;
  readonly pairing_tags?: readonly string[];
  readonly occasion?: readonly string[];
  readonly recipient_profile?: RecipientProfileValue;
  readonly profile_evidence?: readonly string[];
  readonly matched_constraints?: readonly string[];
  readonly unmet_constraints?: readonly string[];
  readonly inferred_constraints?: readonly string[];
  readonly claimable_attributes?: readonly string[];
  readonly price_usd?: number;
  readonly price?: string;
  readonly price_krw_approx?: number;
}

interface ComparisonGroundingLeg {
  readonly sub_query: string;
  readonly comparison_mode?: string;
  readonly canonical_concept?: string;
  readonly concept_entity_type?: string;
  readonly aggregate_result_count?: number;
  readonly representative_result?: GroundingWineFact | undefined;
  readonly prototype_axis?: readonly GroundingWineFact[] | undefined;
}

function parseObservationPriceUsd(priceRange: string | undefined): number | undefined {
  if (priceRange === undefined) {
    return undefined;
  }
  const usdMatch = /^\$(\d[\d,]*(?:\.\d+)?)$/.exec(priceRange.trim());
  if (usdMatch === null) {
    return undefined;
  }
  const usd = Number(usdMatch[1]!.replace(/,/g, ''));
  return Number.isFinite(usd) ? usd : undefined;
}

function parseObservationPriceKrw(priceRange: string | undefined): number | undefined {
  if (priceRange === undefined) {
    return undefined;
  }
  const trimmed = priceRange.trim();
  const usdMatch = /^\$(\d[\d,]*(?:\.\d+)?)$/.exec(trimmed);
  if (usdMatch !== null) {
    const usd = Number(usdMatch[1]!.replace(/,/g, ''));
    return Number.isFinite(usd) ? Math.round(usd * KRW_PER_USD_APPROXIMATE) : undefined;
  }
  const krwMatch = /^(?:₩|)(\d[\d,]*)(?:\s*원)?$/u.exec(trimmed);
  if (krwMatch !== null) {
    const krw = Number(krwMatch[1]!.replace(/,/g, ''));
    return Number.isFinite(krw) ? krw : undefined;
  }
  return undefined;
}

function buildObservationPriceText(priceRange: string): string {
  const priceKrwApprox = parseObservationPriceKrw(priceRange);
  if (priceKrwApprox === undefined) {
    return sanitizeObservationField(priceRange);
  }
  const groupedKrw = priceKrwApprox
    .toString()
    .replace(new RegExp(`\\B(?=(?:\\d{${DECIMAL_GROUP_SIZE}})+(?!\\d))`, 'gu'), ',');
  return `${sanitizeObservationField(priceRange)} (~${groupedKrw}원)`;
}

function uniqueClaimableAttributes(attributes: readonly string[]): readonly string[] {
  return [...new Set(attributes.filter((attribute) => attribute.trim().length > 0))];
}

function buildClaimableAttributes(
  item: SearchResponseV1['results'][number],
  profileEvidence: readonly RecipientProfileEvidenceAxis[],
  priceUsd: number | undefined,
  priceKrwApprox: number | undefined,
): readonly string[] {
  const attributes: string[] = ['canonical_label', 'entity_id'];
  if (item.entity.producer !== undefined) attributes.push('producer');
  if (item.entity.region !== undefined) attributes.push('region');
  if (item.entity.closure !== undefined) attributes.push('closure');
  if (item.entity.country !== undefined) attributes.push('country');
  if (item.entity.producerPrestige !== undefined) attributes.push('producer_prestige');
  if (Number.isFinite(item.match.scoreComponents.popularity)) attributes.push('popularity_score');
  if (item.entity.wineType !== undefined) attributes.push('wine_type');
  if (item.entity.vintage !== undefined) attributes.push('vintage');
  if (item.entity.grapes !== undefined && item.entity.grapes.length > 0) attributes.push('grapes');
  if (item.entity.style !== undefined) attributes.push('style');
  if (item.entity.criticScore !== undefined && Number.isFinite(item.entity.criticScore)) attributes.push('critic_score_100');
  if (item.entity.body !== undefined) attributes.push('body');
  if (item.entity.tannin !== undefined) attributes.push('tannin');
  if (item.entity.acidity !== undefined) attributes.push('acidity');
  if (item.entity.alcoholPct !== undefined) attributes.push('alcohol_pct');
  if (item.entity.sweetness !== undefined) attributes.push('sweetness');
  if (item.entity.pairingTags !== undefined && item.entity.pairingTags.length > 0) attributes.push('pairing_tags');
  if (item.entity.occasion !== undefined && item.entity.occasion.length > 0) attributes.push('occasion');
  if (profileEvidence.length > 0) {
    attributes.push('recipient_profile');
    attributes.push(...profileEvidence.map((axis) => `profile_evidence:${axis}`));
  }
  attributes.push(...item.constraints.matched.map((attribute) => `matched_constraint:${attribute}`));
  attributes.push(...item.constraints.inferred.map((attribute) => `inferred_constraint:${attribute}`));
  if (priceUsd !== undefined) attributes.push('price_usd');
  if (item.entity.priceRange !== undefined) attributes.push('price');
  if (priceKrwApprox !== undefined) attributes.push('price_krw_approx');
  return uniqueClaimableAttributes(attributes);
}

function buildGroundingFactFromResultItem(
  item: SearchResponseV1['results'][number],
  recipientProfile?: RecipientProfileValue,
): GroundingWineFact {
  const priceUsd = parseObservationPriceUsd(item.entity.priceRange);
  const priceKrwApprox = parseObservationPriceKrw(item.entity.priceRange);
  const profileEvidence = recipientProfile === undefined
    ? []
    : recipientProfileEvidenceAxes(resultToRecipientProfileCandidate(item), recipientProfile);
  const claimableAttributes = buildClaimableAttributes(item, profileEvidence, priceUsd, priceKrwApprox);
  return {
    entity_id: item.entity.entityId,
    canonical_label: sanitizeObservationField(item.entity.canonicalLabel),
    ...(item.entity.producer !== undefined ? { producer: sanitizeObservationField(item.entity.producer) } : {}),
    ...(item.entity.region !== undefined ? { region: sanitizeObservationField(item.entity.region) } : {}),
    ...(item.entity.closure !== undefined ? { closure: sanitizeObservationField(item.entity.closure) } : {}),
    ...(item.entity.country !== undefined ? { country: sanitizeObservationField(item.entity.country) } : {}),
    ...(item.entity.producerPrestige !== undefined ? { producer_prestige: item.entity.producerPrestige } : {}),
    ...(Number.isFinite(item.match.scoreComponents.popularity) ? { popularity_score: item.match.scoreComponents.popularity } : {}),
    ...(item.entity.wineType !== undefined ? { wine_type: sanitizeObservationField(item.entity.wineType) } : {}),
    ...(item.entity.vintage !== undefined ? { vintage: item.entity.vintage } : {}),
    ...(item.entity.grapes !== undefined
      ? { grapes: item.entity.grapes.slice(0, 3).map((g) => sanitizeObservationField(g)) }
      : {}),
    ...(item.entity.style !== undefined ? { style: sanitizeObservationField(item.entity.style) } : {}),
    ...(item.entity.criticScore !== undefined && Number.isFinite(item.entity.criticScore) ? { critic_score_100: Math.round(item.entity.criticScore * 100) } : {}),
    ...(item.entity.body !== undefined ? { body: item.entity.body } : {}),
    ...(item.entity.tannin !== undefined ? { tannin: item.entity.tannin } : {}),
    ...(item.entity.acidity !== undefined ? { acidity: item.entity.acidity } : {}),
    ...(item.entity.alcoholPct !== undefined ? { alcohol_pct: item.entity.alcoholPct } : {}),
    ...(item.entity.sweetness !== undefined ? { sweetness: item.entity.sweetness } : {}),
    ...(item.entity.pairingTags !== undefined
      ? { pairing_tags: item.entity.pairingTags.map((tag) => sanitizeObservationField(tag)) }
      : {}),
    ...(item.entity.occasion !== undefined
      ? { occasion: item.entity.occasion.map((tag) => sanitizeObservationField(tag)) }
      : {}),
    ...(recipientProfile !== undefined && profileEvidence.length > 0
      ? { recipient_profile: recipientProfile, profile_evidence: profileEvidence }
      : {}),
    ...(item.constraints.matched.length > 0 ? { matched_constraints: item.constraints.matched } : {}),
    ...(item.constraints.unmet.length > 0 ? { unmet_constraints: item.constraints.unmet } : {}),
    ...(item.constraints.inferred.length > 0 ? { inferred_constraints: item.constraints.inferred } : {}),
    ...(claimableAttributes.length > 0 ? { claimable_attributes: claimableAttributes } : {}),
    ...(priceUsd !== undefined ? { price_usd: priceUsd } : {}),
    ...(item.entity.priceRange !== undefined ? { price: sanitizeObservationField(item.entity.priceRange) } : {}),
    ...(priceKrwApprox !== undefined ? { price_krw_approx: priceKrwApprox } : {}),
  };
}

function buildGroundingJsonFromSearch(
  response: SearchResponseV1,
  displayResults: readonly SearchResponseV1['results'][number][],
  recipientProfile?: RecipientProfileValue,
): string {
  const facts: GroundingWineFact[] = displayResults
    .slice(0, SUMMARY_TOP_N)
    .map((item) => buildGroundingFactFromResultItem(item, recipientProfile));

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
      return [buildGroundingFactFromResultItem(top)];
    });
  const comparisonLegs: ComparisonGroundingLeg[] = response.entities.slice(0, 2).map((entry) => ({
    sub_query: sanitizeObservationField(entry.subQuery),
    ...(entry.comparisonMode !== undefined ? { comparison_mode: entry.comparisonMode } : {}),
    ...(entry.canonicalConcept !== undefined ? { canonical_concept: sanitizeObservationField(entry.canonicalConcept) } : {}),
    ...(entry.conceptEntityType !== undefined ? { concept_entity_type: entry.conceptEntityType } : {}),
    ...(entry.conceptAggregate !== undefined
      ? {
          aggregate_result_count: entry.conceptAggregate.aggregateResultCount,
          representative_result:
            entry.conceptAggregate.representativeResult !== null
              ? buildGroundingFactFromResultItem(entry.conceptAggregate.representativeResult)
              : undefined,
          prototype_axis: entry.conceptAggregate.prototypeAxis.map((item) => buildGroundingFactFromResultItem(item)),
        }
      : {}),
  }));

  // Deterministic, order-symmetric side-by-side contrast over the resolved
  // comparands. This replaces "eyeball two free-text legs" with a structural
  // attribute alignment (agree/differ verdict + numeric spread per attribute),
  // giving the agent an explicit pairwise-balance / contrast signal.
  const contrastEntities = response.entities
    .slice(0, 2)
    .flatMap((entry) => {
      const top = entry.topResult ?? entry.conceptAggregate?.representativeResult ?? null;
      return top !== null ? [top.entity] : [];
    });
  const contrast = buildComparisonContrast(contrastEntities);

  return `GROUNDING_JSON: ${JSON.stringify({
    query_type: 'comparison',
    total_results: wines.length,
    wines,
    comparison_legs: comparisonLegs,
    contrast,
  })}`;
}
