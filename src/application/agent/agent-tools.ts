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
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { SearchExecutorPort } from '../search/port/search-executor.port.js';
import type {
  DecomposedSearchExecutionOptions,
  DecomposedSearchParentContext,
} from '../search/port/search-route-usecases.port.js';
import { createStageTimer } from '../../observability/stage-timer.js';
import {
  buildCompareToolFieldShape,
  buildSearchToolStyleDerivedFilters,
  buildEntityIdToolField,
  buildFoodPairingFieldShape,
  buildSearchToolQueryField,
  buildSearchToolFieldShape,
  sanitizeOptionalToolNulls,
  validateSearchToolVintageRange,
} from '../search/search-tool-contract.js';
import {
  buildFoodPairingColorClause,
  resolveFoodPairingBudgetKrw,
} from '../search/food-pairing-tool-policy.js';
import {
  appendStructuredQueryClauses,
  buildSearchToolSoftClauses,
} from '../search/search-tool-query-policy.js';
import { buildSearchToolRetrievalCoreQuery } from '../search/search-tool-retrieval-core.js';
import {
  applySearchToolBudgetResultPolicy,
  applySearchToolNegationResultPolicy,
  collectSearchToolNegationTerms,
} from '../search/search-tool-result-policy.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
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
import {
  SEARCH_TOOL_DIVERSITY_LIMIT_PER_TYPE,
  SEARCH_TOOL_DIVERSITY_MIN_LIMIT,
  SEARCH_TOOL_WANTS_DIVERSITY_RE,
  executeSearchWithTypedWineDiversityDiscovery,
  shouldRunTypedWineDiversityDiscovery,
  withWineTypeFilter,
} from '../search/search-tool-diversity.js';
import { isKnownAgentToolName } from './agent-tool-attempt-schema.js';

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

const SearchInputSchema = z.object({
  query: buildSearchToolQueryField({ maxLen: SEARCH_QUERY_MAX_LEN }),
  ...buildSearchToolFieldShape({
    limitMax: SEARCH_LIMIT_MAX,
    maxPriceKrwMax: MAX_PRICE_KRW_BOUND,
  }),
}).superRefine((data, ctx) => {
  validateSearchToolVintageRange(data, ctx);
});

const CompareInputSchema = z.object({
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
}).superRefine((data, ctx) => {
  validateSearchToolVintageRange(data, ctx);
});

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
 * Must not exceed MAX_QUERY_LENGTH (500) — the security gate in query-sanitizer.ts rejects
 * queries longer than MAX_QUERY_LENGTH, so an enriched query built to 700 chars would always
 * be rejected. Capping here at MAX_QUERY_LENGTH ensures the enriched query passes the gate.
 *
 * Domain rationale: Vespa YQL parser has a 4 KB query limit; downstream NL parser
 * operates well within 500 chars. The previously used value of 700 was inconsistent
 * with the security gate constant.
 */
const MAX_ENRICHED_QUERY_LEN = MAX_QUERY_LENGTH; // 500 — must match security gate

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
  readonly min_price_krw?: number | undefined;
  readonly max_price_krw?: number | undefined;
  readonly max_alcohol_pct?: number | undefined;
  readonly wine_type?: string | undefined;
  readonly country?: string | undefined;
  readonly vintage_min?: number | undefined;
  readonly vintage_max?: number | undefined;
  readonly appellation?: string | undefined;
  readonly style?: string | undefined;
  readonly styles?: readonly string[] | undefined;
  readonly certification?: string | undefined;
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

  // Wine type
  if (input.wine_type !== undefined) {
    filters.push({ attribute: 'wine_type', operator: '=', value: input.wine_type, source_phrase: input.wine_type, confidence: 1.0, mapping_version: v });
  }

  // Alcohol upper bound
  if (input.max_alcohol_pct !== undefined) {
    filters.push({ attribute: 'alcohol_pct', operator: '<=', value: input.max_alcohol_pct, source_phrase: `${input.max_alcohol_pct}% 이하`, confidence: 1.0, mapping_version: v });
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

  filters.push(...buildSearchToolStyleDerivedFilters(input));

  // Style: NOT a hard Vespa filter — Vespa style values are compound strings like
  // "medium red", "bold red", "light red", "medium white", "full white". An exact-match
  // filter for agent-emitted values like "light" or "oaked" always returns 0 hits.
  // Style is passed as a soft text hint via appendStructuredQueryClauses() instead.

  // Certification: NOT a hard filter — the index has separate boolean fields `organic`
  // and `biodynamic`, not a `certification` string field. A YQL filter on a nonexistent
  // field returns 0 hits. Certification is appended as a text hint to the query.

  return filters;
}

function buildStructuredQuery(input: StructuredSearchConstraintInput & { readonly query: string }): string {
  const retrievalCoreQuery = buildSearchToolRetrievalCoreQuery(input);
  const clauses = buildSearchToolSoftClauses(input);
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

/**
 * Truncates an observation string to MAX_OBSERVATION_CHARS to prevent a single
 * tool result from exhausting the agent's token budget in one step.
 */
function capObservation(obs: string): string {
  if (obs.length <= MAX_OBSERVATION_CHARS) return obs;
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
  const observation = capObservation(inner.observation);
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

function buildSearchRequestForAgentQuery(
  query: string,
  limit: number | undefined,
  retrievalMode: z.infer<typeof SearchInputSchema>['retrieval_mode'],
  filters: readonly NormalizedConstraint[],
): Parameters<SearchExecutorPort['execute']>[0] {
  return {
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(retrievalMode !== undefined
      ? { options: { mode: retrievalMode, explain: false, clarification: false } }
      : {}),
    ...(filters.length > 0 ? { filters } : {}),
  };
}

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
      const clauses = buildSearchToolSoftClauses(parsed);
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

      const wantsDiversity = parsed.want_diversity === true || SEARCH_TOOL_WANTS_DIVERSITY_RE.test(parsed.query);
      const effectiveLimit = wantsDiversity
        ? Math.max(parsed.limit ?? SEARCH_TOOL_DIVERSITY_MIN_LIMIT, SEARCH_TOOL_DIVERSITY_MIN_LIMIT)
        : parsed.limit;

      const baseRequest = buildSearchRequestForAgentQuery(
        enrichedQuery,
        effectiveLimit,
        parsed.retrieval_mode,
        structuredFilters,
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
            parsed.retrieval_mode,
            withWineTypeFilter(structuredFilters, wineType, 'agent_tool_diversity_v1'),
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
                + summarizeSearchResults(response, wantsDiversity),
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
            observation:
              summarizeSearchResults(response, wantsDiversity)
              + `\n[Excluded ${negationFiltered.filteredCount} result(s) matching negation terms: ${negTerms.join(', ')}]`,
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

      // Price filter context: when a budget bound/range was applied, annotate
      // the observation so the agent can explicitly cite the enforced range even
      // when some per-wine prices are sparse in the index.
      const priceFilterObservation = buildPriceFilterObservation(parsed);
      if (priceFilterObservation !== undefined) {
        obs += `\n${priceFilterObservation}`;
      }

      return {
        observation: obs,
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
      const sharedFilters = buildStructuredFilters(parsed);
      const subQueries = [
        buildStructuredQuery({ ...parsed, query: parsed.query_a }),
        buildStructuredQuery({ ...parsed, query: parsed.query_b }),
      ] as const;
      const response = await deps.decomposedSearchExecute(
        subQueries,
        'compare',
        buildComparisonOriginalQuery(parsed),
        requestId,
        Date.now(),
        sharedFilters.length > 0 ? { filters: sharedFilters } : undefined,
        options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : undefined,
      );
      return {
        observation: summarizeComparison(response),
        rawResult: response,
        structuredOutput: { kind: 'comparison_result', response },
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

      if (deps.drinkingWindowEntityLookup !== undefined) {
        const entity = await deps.drinkingWindowEntityLookup(entityId);
        if (entity === undefined) {
          return {
            observation: `Wine ${parsed.entity_id} not found.`,
            rawResult: null,
            structuredOutput: { kind: 'tool_error', errorCode: 'ENTITY_NOT_FOUND', message: `entity ${parsed.entity_id} not found` },
          };
        }
        return buildDrinkingWindowToolResult(entity, targetYear);
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
        return buildDrinkingWindowToolResult(doc, targetYear);
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
      const queryBase = `wines for ${parsed.food}${buildFoodPairingColorClause(parsed)}`;
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
        return {
          observation: 'Unexpected response type for pairing search.',
          rawResult: responseWithContext,
          structuredOutput: { kind: 'tool_error', errorCode: 'UNEXPECTED_RESPONSE_TYPE', message: `expected search, got ${responseWithContext.queryType}` },
        };
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

  const displayResults = diversify
    ? selectDiverseSummaryResults(results, SUMMARY_TOP_N)
    : results;

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
    if (r.entity.wineType) parts.push(`wine_type: ${sanitizeObservationField(r.entity.wineType)}`);
    if (r.entity.vintage) parts.push(`vintage: ${r.entity.vintage}`);
    if (r.entity.grapes !== undefined && r.entity.grapes.length > 0) {
      parts.push(`grapes: ${r.entity.grapes.slice(0, 3).map(sanitizeObservationField).join(', ')}`);
    }
    if (r.entity.style) parts.push(`style: ${sanitizeObservationField(r.entity.style)}`);
    if (r.entity.criticScore !== undefined && Number.isFinite(r.entity.criticScore)) parts.push(`critic: ${(r.entity.criticScore * 100).toFixed(0)}/100`);
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
  return `${summary}\n${buildGroundingJsonFromSearch(response, displayResults)}`;
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
  readonly wine_type?: string;
  readonly vintage?: number;
  readonly grapes?: readonly string[];
  readonly style?: string;
  readonly critic_score_100?: number;
  readonly price?: string;
  readonly price_krw_approx?: number;
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
  return `${sanitizeObservationField(priceRange)} (~${priceKrwApprox.toLocaleString('ko-KR')}원)`;
}

function buildGroundingJsonFromSearch(
  response: SearchResponseV1,
  displayResults: readonly SearchResponseV1['results'][number][],
): string {
  const facts: GroundingWineFact[] = displayResults.slice(0, SUMMARY_TOP_N).map((r) => {
    const priceKrwApprox = parseObservationPriceKrw(r.entity.priceRange);
    const base: GroundingWineFact = {
      entity_id: r.entity.entityId,
      canonical_label: sanitizeObservationField(r.entity.canonicalLabel),
      ...(r.entity.producer !== undefined ? { producer: sanitizeObservationField(r.entity.producer) } : {}),
      ...(r.entity.region !== undefined ? { region: sanitizeObservationField(r.entity.region) } : {}),
      ...(r.entity.wineType !== undefined ? { wine_type: sanitizeObservationField(r.entity.wineType) } : {}),
      ...(r.entity.vintage !== undefined ? { vintage: r.entity.vintage } : {}),
      ...(r.entity.grapes !== undefined
        ? { grapes: r.entity.grapes.slice(0, 3).map((g) => sanitizeObservationField(g)) }
        : {}),
      ...(r.entity.style !== undefined ? { style: sanitizeObservationField(r.entity.style) } : {}),
      ...(r.entity.criticScore !== undefined && Number.isFinite(r.entity.criticScore) ? { critic_score_100: Math.round(r.entity.criticScore * 100) } : {}),
      ...(r.entity.priceRange !== undefined ? { price: sanitizeObservationField(r.entity.priceRange) } : {}),
      ...(priceKrwApprox !== undefined ? { price_krw_approx: priceKrwApprox } : {}),
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
      const priceKrwApprox = parseObservationPriceKrw(top.entity.priceRange);
      const fact: GroundingWineFact = {
        entity_id: top.entity.entityId,
        canonical_label: sanitizeObservationField(top.entity.canonicalLabel),
        ...(top.entity.producer !== undefined ? { producer: sanitizeObservationField(top.entity.producer) } : {}),
        ...(top.entity.region !== undefined ? { region: sanitizeObservationField(top.entity.region) } : {}),
        ...(top.entity.wineType !== undefined ? { wine_type: sanitizeObservationField(top.entity.wineType) } : {}),
        ...(top.entity.vintage !== undefined ? { vintage: top.entity.vintage } : {}),
        ...(top.entity.grapes !== undefined
          ? { grapes: top.entity.grapes.slice(0, 3).map((g) => sanitizeObservationField(g)) }
          : {}),
        ...(top.entity.style !== undefined ? { style: sanitizeObservationField(top.entity.style) } : {}),
        ...(top.entity.criticScore !== undefined && Number.isFinite(top.entity.criticScore) ? { critic_score_100: Math.round(top.entity.criticScore * 100) } : {}),
        ...(top.entity.priceRange !== undefined ? { price: sanitizeObservationField(top.entity.priceRange) } : {}),
        ...(priceKrwApprox !== undefined ? { price_krw_approx: priceKrwApprox } : {}),
      };
      return [fact];
    });

  return `GROUNDING_JSON: ${JSON.stringify({
    query_type: 'comparison',
    total_results: wines.length,
    wines,
  })}`;
}
