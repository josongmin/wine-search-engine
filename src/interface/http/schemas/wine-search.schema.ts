/**
 * Zod schemas for the new POST /v1/agent endpoint.
 *
 * This is the public HTTP surface for the Plan-then-Execute wine-search
 * orchestrator. The response shape is intentionally leaner and
 * disambiguated:
 *
 *   - `steps[]` is a single uniform array (the legacy `action` vs
 *     `actions[]` duality is gone — every step carries a `tool_calls[]`
 *     and `observations[]` list, even when there is only one of each).
 *   - `meta.termination` is a single nested record (`reason`, `layer`,
 *     `degraded_reason`, optional `kind`) instead of a flat trio of
 *     optional fields.
 *   - `meta.policy_blocked` is a typed boolean (no more inferring blocked
 *     state from `termination_reason` + `fallback_trace`).
 *
 * S1 SEMANTIC SPLIT — BREAKING CHANGE (vs previous wine-search wire shape):
 *   `meta.policy_blocked: true` used to mean BOTH (a) a security-sanitizer
 *   block AND (b) a deterministic-router reject of an unsupported intent.
 *   The two cases are now distinguished by `meta.termination.kind`:
 *
 *     - `kind = 'security_block'`: adversarial query → `policy_blocked = true`,
 *       Korean security-template emitted.
 *     - `kind = 'unsupported_intent'`: planner could not derive a wine
 *       search (admit-gate empty/too-long, analyzer malformed, router
 *       reject, runner reject) → `policy_blocked = false`, Korean
 *       coverage-gap template emitted.
 *
 *   `kind` is OPTIONAL on the wire — present only when
 *   `termination.reason === 'blocked'`. See
 *   `src/application/wine-search/wine-search-result-schemas.ts` for the
 *   internal contract.
 *
 *   QUERY LENGTH (secondary breaking change): `query` is now bounded by
 *   user-perceived codepoints, not UTF-16 code units (Zod's default
 *   `.max(N)` on strings). The previous behaviour halved the documented
 *   limit for emoji queries (each emoji is two UTF-16 code units). See
 *   {@link WineSearchRequestSchema}.
 *
 * All schemas chain `.strict()` per CLAUDE.md rule 10. None of these are
 * LLM tool-call shapes — they are HTTP contract shapes that MUST fail
 * closed on unknown keys.
 *
 * Every numeric bound is a named const (rule 15) with a domain
 * justification comment. String/array bounds reuse module-scoped
 * constants from `../constants.js` for consistency
 * (`MAX_AGENT_HTTP_QUERY_CHARS`, `MAX_AGENT_STEPS_CAP`).
 */

import { z } from 'zod';
import {
  HTTP_DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_AGENT_HTTP_QUERY_CHARS,
  MAX_AGENT_STEPS_CAP,
  MAX_ERROR_ENVELOPE_REQUEST_ID_CHARS,
  MAX_TOOL_CALL_ARGUMENT_KEYS,
} from '../constants.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Per-step natural-language summary (string-rendered planner/synthesizer
 *  decision). Sized to fit an LLM-paraphrased justification of a single
 *  reasoning step without inflating response bytes. */
const STEP_SUMMARY_MAX_CHARS = 500;

/** Maximum parallel tool invocations per step. Aligned with the parallel
 *  batch cap in `agent-tool-execution-support.ts` (parallel batches fan out
 *  at most 4 search/pairing/drinkability calls per step). */
const STEP_TOOL_CALL_MAX = 4;

/** Per-observation text cap. Observations are tool-output summaries that the
 *  orchestrator passes back to the LLM and surfaces in the response. Sized
 *  to fit a grounded JSON envelope plus a short rendered preview. */
export const STEP_OBSERVATION_MAX_CHARS = 2_000;

/** Maximum observations per step. Each tool call produces at most one
 *  observation, and the parallel batch cap is `STEP_TOOL_CALL_MAX = 4`. Soft
 *  ceiling at 8 leaves headroom for future multi-observation tools (e.g. a
 *  pairing tool that emits a primary + secondary observation). */
const STEP_OBSERVATION_MAX = 8;

/** Maximum length of the synthesizer's final answer string. Mirrors
 *  `SYNTHESIS_MAX_ANSWER_CHARS = 3000` in
 *  `src/application/wine-search/synthesis-schemas.ts` (3 paragraphs of
 *  Korean answer + citations). Sized to match exactly so HTTP truncation
 *  never silently clips a valid synthesized answer. */
export const ANSWER_MAX_CHARS = 3_000;

/**
 * Step-array cap: analyzer + router + runner + wine-agent-loop + synthesizer can
 * each emit one or more steps within a single execution. With a
 * `max_steps = MAX_AGENT_STEPS_CAP (=10)` budget for the tool-call loop, the
 * full step array can carry the tool-loop steps plus a fixed pre/post
 * envelope. We allow `MAX_AGENT_STEPS_CAP * 2 = 20` slots so a 10-step
 * loop with analyzer/router/synth bookends still fits.
 */
const WINE_SEARCH_STEPS_MAX = MAX_AGENT_STEPS_CAP * 2;

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
 *  - `wine_agent_loop`: wire tag for the nested WineAgentLoop inside a
 *    `multi-step` plan.
 *  - `synthesizer`: final answer synthesis.
 */
const WineSearchStepSourceSchema = z.enum([
  'analyzer',
  'router',
  'runner',
  'wine_agent_loop',
  'synthesizer',
]);

/** Single tool call (uniform shape across known and unknown tools). The
 *  `arguments` shape is intentionally `z.record(z.unknown())` — the inner
 *  schemas live in the application layer and are validated there before the
 *  call is dispatched. Surfacing them here would couple the HTTP contract to
 *  every internal tool input schema. */
export const WineSearchToolCallSchema = z.object({
  name: z.string().min(1).max(STEP_SUMMARY_MAX_CHARS),
  arguments: z
    .record(z.unknown())
    .refine((a) => Object.keys(a).length <= MAX_TOOL_CALL_ARGUMENT_KEYS, {
      message: `tool call arguments exceed ${String(MAX_TOOL_CALL_ARGUMENT_KEYS)} keys`,
    }),
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
/**
 * Upper bound on overall agent timeout. MUST NOT exceed the Fastify server
 * `requestTimeout` (`HTTP_DEFAULT_REQUEST_TIMEOUT_MS`): the server hard-kills
 * any request past that budget, so a larger agent timeout is unachievable and
 * makes the contract lie (rule 22 — mutually consistent limits). Derived from
 * the server timeout so the two can never drift; see
 * `test/integration/http/routes/wine-search-timeout-consistency.test.ts`.
 */
const REQUEST_AGENT_TIMEOUT_MAX_MS = HTTP_DEFAULT_REQUEST_TIMEOUT_MS;
/** Lower bound on the per-request total token budget. Below 1k tokens the
 *  system prompt alone exhausts the budget. */
const REQUEST_TOTAL_TOKEN_MIN = 1_000;
/** Upper bound on the per-request total token budget. 200k matches the
 *  Anthropic context window for Claude-4 Sonnet. */
const REQUEST_TOTAL_TOKEN_MAX = 200_000;

/** Pure-JS codepoint length helper — Zod's `.max(N)` for `z.string()`
 *  counts UTF-16 code units, which double-counts surrogate-paired emoji and
 *  some CJK extensions. We use `[...str].length` to count codepoints
 *  (iterator semantics). The result aligns the wire bound with the
 *  documented "max ~2000 user-perceived chars" guarantee. */
function countCodepoints(value: string): number {
  let n = 0;
  for (const ch of value) {
    void ch;
    n += 1;
  }
  return n;
}

export const WineSearchRequestSchema = z.object({
  /**
   * User query (UTF-8 string). Bounded by CODEPOINTS — not UTF-16 code
   * units. Zod's default `.max(N)` on `z.string()` measures code units,
   * which halves the effective limit for surrogate-paired characters
   * (most emoji, some CJK extensions). The `.refine` below pins the
   * bound to the user-perceived character count so the documented limit
   * holds for ASCII, Korean, and emoji alike.
   *
   * BREAKING CHANGE (S1 work): emoji queries longer than
   * `MAX_AGENT_HTTP_QUERY_CHARS` UTF-16 code units but ≤ that many
   * codepoints are now ACCEPTED (previously rejected). Conversely,
   * queries with > `MAX_AGENT_HTTP_QUERY_CHARS` codepoints are now
   * rejected with the explicit message below.
   */
  query: z
    .string()
    .min(1)
    .refine(
      (s) => countCodepoints(s) <= MAX_AGENT_HTTP_QUERY_CHARS,
      { message: `query exceeds max length of ${String(MAX_AGENT_HTTP_QUERY_CHARS)} codepoints` },
    ),
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
  // Unmodeled runtime failure inside the primary structured-LLM path —
  // distinguished from `malformed_llm_output` so client telemetry and
  // server-side dashboards can separate "LLM produced a bad shape" from
  // "something else blew up" (P-M1 finding).
  'unexpected_error',
  // S3 grounding-verify: primary answer asserted a factual claim absent from
  // the grounding union; re-synth still ungrounded → degraded to the
  // deterministic layer ladder.
  'ungrounded_claim',
  // Wave 1 (Cluster F): DecisionEngine emitted `NO_CORPUS_MATCH` because the
  // planner had a high-confidence anchor but the resolver returned 0
  // candidates. Synthesizer emitted the deterministic `corpusGapAdmission`
  // template ("not in our catalogue"). Distinct from `no_results`
  // (no-grounding path) and from `policy_blocked` (security / unsupported
  // intent) so dashboards can monitor catalogue coverage gaps.
  'no_corpus_match',
]);

/** Query intent classifier output. Matches `QueryIntentSchema` in
 *  `wine-search-schemas.ts`, plus a `'rejected'` slot the orchestrator
 *  emits when the analyzer refuses the query. */
const WineSearchQueryIntentSchema = z.enum([
  'search',
  'compare',
  'pair',
  'drinkability',
  'unknown',
  'rejected',
]);

/** Plan kind selected by the deterministic router. Matches the
 *  discriminated union in `execution-plan-schemas.ts`. */
const WineSearchPlanKindSchema = z.enum([
  'single-search',
  'parallel-search',
  'comparison',
  'food-pairing-then-search',
  'search-then-drinkability',
  'multi-step',
  'reject',
]);

/**
 * S1 semantic-split discriminant (wire form). Present only when
 * `termination.reason === 'blocked'`. Mirrors {@link TerminationKind} in
 * `src/application/wine-search/wine-search-result-schemas.ts` (SSoT — the
 * application module owns the literal values; this enum re-states them for
 * the wire shape).
 *
 *  - `'security_block'`: adversarial sanitizer fired → `policy_blocked = true`,
 *    Korean security-template emitted.
 *  - `'unsupported_intent'`: planner could not derive a wine search →
 *    `policy_blocked = false`, coverage-gap template emitted.
 */
const WineSearchTerminationKindSchema = z.enum([
  'security_block',
  'unsupported_intent',
]);

export const WineSearchTerminationSchema = z.object({
  reason: WineSearchTerminationReasonSchema,
  layer: WineSearchAnswerLayerSchema,
  /** S1 discriminant — see {@link WineSearchTerminationKindSchema}.
   *  Present only when `reason === 'blocked'`; omitted otherwise. */
  kind: WineSearchTerminationKindSchema.optional(),
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
    request_id: z.string().min(1).max(MAX_ERROR_ENVELOPE_REQUEST_ID_CHARS),
    total_duration_ms: z.number().int().finite().min(0),
    total_tokens: TokenUsageSchema,
    intent: WineSearchQueryIntentSchema,
    plan_kind: WineSearchPlanKindSchema,
    termination: WineSearchTerminationSchema,
    policy_blocked: z.boolean(),
  }).strict(),
}).strict();
export type WineSearchResponseBody = z.infer<typeof WineSearchResponseSchema>;
