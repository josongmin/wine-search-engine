/**
 * Zod schemas for the new POST /v1/wine-search endpoint.
 *
 * This is the public HTTP surface for the Plan-then-Execute wine-search
 * orchestrator (replacement of the ReAct-style /v1/agent loop). It is a
 * breaking redesign vs /v1/agent — the response shape is intentionally
 * leaner and disambiguated:
 *
 *   - `steps[]` is a single uniform array (the legacy `action` vs
 *     `actions[]` duality is gone — every step carries a `tool_calls[]`
 *     and `observations[]` list, even when there is only one of each).
 *   - `meta.termination` is a single nested record (`reason`, `layer`,
 *     `degraded_reason`) instead of a flat trio of optional fields.
 *   - `meta.policy_blocked` is a typed boolean (no more inferring blocked
 *     state from `termination_reason` + `fallback_trace`).
 *
 * All schemas chain `.strict()` per CLAUDE.md rule 10. None of these are
 * LLM tool-call shapes — they are HTTP contract shapes that MUST fail
 * closed on unknown keys.
 *
 * Every numeric bound is a named const (rule 15) with a domain
 * justification comment. String/array bounds reuse module-scoped
 * constants from `../constants.js` where parity with the existing
 * /v1/agent contract matters (`MAX_AGENT_HTTP_QUERY_CHARS`,
 * `MAX_AGENT_STEPS_CAP`).
 */

import { z } from 'zod';
import {
  MAX_AGENT_HTTP_QUERY_CHARS,
  MAX_AGENT_STEPS_CAP,
} from '../constants.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Per-step natural-language summary (string-rendered planner/synthesizer
 *  decision). Sized to fit an LLM-paraphrased justification of a single
 *  reasoning step without inflating response bytes. */
export const STEP_SUMMARY_MAX_CHARS = 500;

/** Maximum parallel tool invocations per step. Aligned with the parallel
 *  batch cap in `agent-tool-execution-support.ts` (parallel batches fan out
 *  at most 4 search/pairing/drinkability calls per step). */
export const STEP_TOOL_CALL_MAX = 4;

/** Per-observation text cap. Observations are tool-output summaries that the
 *  orchestrator passes back to the LLM and surfaces in the response. Sized
 *  to fit a grounded JSON envelope plus a short rendered preview. */
export const STEP_OBSERVATION_MAX_CHARS = 2_000;

/** Maximum observations per step. Each tool call produces at most one
 *  observation, and the parallel batch cap is `STEP_TOOL_CALL_MAX = 4`. Soft
 *  ceiling at 8 leaves headroom for future multi-observation tools (e.g. a
 *  pairing tool that emits a primary + secondary observation). */
export const STEP_OBSERVATION_MAX = 8;

/** Maximum length of the synthesizer's final answer string. Mirrors
 *  `SYNTHESIS_MAX_ANSWER_CHARS = 3000` in
 *  `src/application/wine-search/synthesis-schemas.ts` (3 paragraphs of
 *  Korean answer + citations). Sized to match exactly so HTTP truncation
 *  never silently clips a valid synthesized answer. */
export const ANSWER_MAX_CHARS = 3_000;

/**
 * Step-array cap: analyzer + router + runner + mini-loop + synthesizer can
 * each emit one or more steps within a single execution. With a
 * `max_steps = MAX_AGENT_STEPS_CAP (=10)` budget for the tool-call loop, the
 * full step array can carry the tool-loop steps plus a fixed pre/post
 * envelope. We allow `MAX_AGENT_STEPS_CAP * 2 = 20` slots so a 10-step
 * loop with analyzer/router/synth bookends still fits.
 */
export const WINE_SEARCH_STEPS_MAX = MAX_AGENT_STEPS_CAP * 2;

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/**
 * Token accounting block — matches `TokenUsage` in
 * `src/domain/ai/port/structured-llm.port.ts` (camelCase internal,
 * snake_case at the HTTP boundary). Adapters MUST coerce missing/NaN
 * fields to 0 before returning (rule from the structured-llm port).
 */
export const TokenUsageSchema = z.object({
  input_tokens: z.number().int().finite().min(0),
  output_tokens: z.number().int().finite().min(0),
  cache_read_tokens: z.number().int().finite().min(0),
  cache_creation_tokens: z.number().int().finite().min(0),
}).strict();
export type TokenUsageBody = z.infer<typeof TokenUsageSchema>;

/**
 * Source stage that emitted a step.
 *  - `analyzer`: query analysis (intent, anchors, normalized constraints).
 *  - `router`: deterministic-router plan selection.
 *  - `runner`: top-level execution-runner step (single/parallel/comparison
 *    search, etc.).
 *  - `mini_loop`: nested ReAct mini-loop inside a `multi-step` plan.
 *  - `synthesizer`: final answer synthesis.
 */
export const WineSearchStepSourceSchema = z.enum([
  'analyzer',
  'router',
  'runner',
  'mini_loop',
  'synthesizer',
]);
export type WineSearchStepSource = z.infer<typeof WineSearchStepSourceSchema>;

/** Single tool call (uniform shape across known and unknown tools). The
 *  `arguments` shape is intentionally `z.record(z.unknown())` — the inner
 *  schemas live in the application layer and are validated there before the
 *  call is dispatched. Surfacing them here would couple the HTTP contract to
 *  every internal tool input schema. */
export const WineSearchToolCallSchema = z.object({
  name: z.string().min(1).max(STEP_SUMMARY_MAX_CHARS),
  arguments: z.record(z.unknown()),
}).strict();
export type WineSearchToolCallBody = z.infer<typeof WineSearchToolCallSchema>;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

/** Lower bound on per-step / agent timeouts. Below 1 s the planner cannot
 *  complete even a single Vespa round-trip. Named so the bound is auditable
 *  per CLAUDE.md rule 13. */
const REQUEST_PER_STEP_TIMEOUT_MIN_MS = 1_000;
/** Upper bound on per-step timeout. Aligned with
 *  `DETERMINISTIC_ROUTER_MAX_PER_STEP_TIMEOUT_MS = 60_000` in
 *  `execution-plan-schemas.ts`. */
const REQUEST_PER_STEP_TIMEOUT_MAX_MS = 60_000;
/** Lower bound on overall agent timeout. */
const REQUEST_AGENT_TIMEOUT_MIN_MS = 1_000;
/** Upper bound on overall agent timeout. 120 s is the practical client
 *  patience ceiling for a single search call; longer requests should be
 *  decomposed by the client. */
const REQUEST_AGENT_TIMEOUT_MAX_MS = 120_000;
/** Lower bound on the per-request total token budget. Below 1k tokens the
 *  system prompt alone exhausts the budget. */
const REQUEST_TOTAL_TOKEN_MIN = 1_000;
/** Upper bound on the per-request total token budget. 200k matches the
 *  Anthropic context window for Claude-4 Sonnet. */
const REQUEST_TOTAL_TOKEN_MAX = 200_000;

export const WineSearchRequestSchema = z.object({
  query: z.string().min(1).max(MAX_AGENT_HTTP_QUERY_CHARS),
  options: z.object({
    max_steps: z.number()
      .int()
      .min(1)
      .max(MAX_AGENT_STEPS_CAP)
      .optional(),
    per_step_timeout_ms: z.number()
      .int()
      .finite()
      .min(REQUEST_PER_STEP_TIMEOUT_MIN_MS)
      .max(REQUEST_PER_STEP_TIMEOUT_MAX_MS)
      .optional(),
    agent_timeout_ms: z.number()
      .int()
      .finite()
      .min(REQUEST_AGENT_TIMEOUT_MIN_MS)
      .max(REQUEST_AGENT_TIMEOUT_MAX_MS)
      .optional(),
    max_total_tokens: z.number()
      .int()
      .finite()
      .min(REQUEST_TOTAL_TOKEN_MIN)
      .max(REQUEST_TOTAL_TOKEN_MAX)
      .optional(),
  }).strict().optional(),
}).strict();
export type WineSearchRequestBody = z.infer<typeof WineSearchRequestSchema>;

// ---------------------------------------------------------------------------
// Step schema
// ---------------------------------------------------------------------------

export const WineSearchStepSchema = z.object({
  index: z.number().int().finite().min(0),
  source: WineSearchStepSourceSchema,
  summary: z.string().max(STEP_SUMMARY_MAX_CHARS),
  tool_calls: z.array(WineSearchToolCallSchema)
    .max(STEP_TOOL_CALL_MAX)
    .optional(),
  observations: z.array(z.string().max(STEP_OBSERVATION_MAX_CHARS))
    .max(STEP_OBSERVATION_MAX)
    .optional(),
  duration_ms: z.number().int().finite().min(0),
  token_usage: TokenUsageSchema.optional(),
}).strict();
export type WineSearchStepBody = z.infer<typeof WineSearchStepSchema>;

// ---------------------------------------------------------------------------
// Meta schema
// ---------------------------------------------------------------------------

/** Top-level reason the orchestrator stopped. */
export const WineSearchTerminationReasonSchema = z.enum([
  'answer',
  'max_steps',
  'timeout',
  'budget',
  'error',
  'loop_detected',
  'fallback',
  'blocked',
  'aborted',
]);
export type WineSearchTerminationReason = z.infer<typeof WineSearchTerminationReasonSchema>;

/** Which synthesis layer produced the final answer. Matches `AnswerLayer`
 *  in `src/application/wine-search/synthesis-schemas.ts`. */
export const WineSearchAnswerLayerSchema = z.enum([
  'primary',
  'layer2',
  'layer3',
  'layer4',
]);
export type WineSearchAnswerLayer = z.infer<typeof WineSearchAnswerLayerSchema>;

/** Optional degradation tag — populated only when the runner fell back
 *  from the primary structured-LLM path. Matches `DegradedReason` in
 *  `synthesis-schemas.ts`. */
export const WineSearchDegradedReasonSchema = z.enum([
  'malformed_llm_output',
  'timeout',
  'circuit_open',
  'no_results',
  'policy_blocked',
]);
export type WineSearchDegradedReason = z.infer<typeof WineSearchDegradedReasonSchema>;

/** Query intent classifier output. Matches `QueryIntentSchema` in
 *  `wine-search-schemas.ts`, plus a `'rejected'` slot the orchestrator
 *  emits when the analyzer refuses the query. */
export const WineSearchQueryIntentSchema = z.enum([
  'search',
  'compare',
  'pair',
  'drinkability',
  'unknown',
  'rejected',
]);
export type WineSearchQueryIntent = z.infer<typeof WineSearchQueryIntentSchema>;

/** Plan kind selected by the deterministic router. Matches the
 *  discriminated union in `execution-plan-schemas.ts`. */
export const WineSearchPlanKindSchema = z.enum([
  'single-search',
  'parallel-search',
  'comparison',
  'food-pairing-then-search',
  'search-then-drinkability',
  'multi-step',
  'reject',
]);
export type WineSearchPlanKind = z.infer<typeof WineSearchPlanKindSchema>;

export const WineSearchTerminationSchema = z.object({
  reason: WineSearchTerminationReasonSchema,
  layer: WineSearchAnswerLayerSchema,
  degraded_reason: WineSearchDegradedReasonSchema.optional(),
}).strict();
export type WineSearchTerminationBody = z.infer<typeof WineSearchTerminationSchema>;

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const WineSearchResponseSchema = z.object({
  query_type: z.literal('wine_search'),
  answer: z.string().min(1).max(ANSWER_MAX_CHARS),
  execution: z.object({
    steps: z.array(WineSearchStepSchema).max(WINE_SEARCH_STEPS_MAX),
    tool_call_count: z.number().int().finite().min(0),
  }).strict(),
  meta: z.object({
    request_id: z.string(),
    total_duration_ms: z.number().int().finite().min(0),
    total_tokens: TokenUsageSchema,
    intent: WineSearchQueryIntentSchema,
    plan_kind: WineSearchPlanKindSchema,
    termination: WineSearchTerminationSchema,
    policy_blocked: z.boolean(),
  }).strict(),
}).strict();
export type WineSearchResponseBody = z.infer<typeof WineSearchResponseSchema>;
