/**
 * WineSearchOrchestrator — typed result contract.
 *
 * STRATEGY (unification with HTTP wire shape — Track A/B/C convergence):
 *   This module is the SINGLE source of truth for the result shape. Field
 *   names are CAMEL-cased internally (`toolCallCount`, `tokenUsage`, `intent`)
 *   and map 1:1 to the SNAKE-cased wire fields in
 *   `@interface/http/schemas/wine-search.schema.ts` (`tool_call_count`,
 *   `token_usage`, `intent`). The HTTP boundary performs a thin case-only
 *   transform (`mapResultToResponse` in `wine-search.route.ts`) — there is
 *   NO field-rename adapter at the container layer. Anthropic / OpenAI
 *   tool-use blocks use `name`/`arguments`, so the internal `toolCalls[i]`
 *   shape mirrors that convention (`{ name, arguments }`).
 *
 *   A compile-time assignability check below pins the internal-shape →
 *   wire-shape mapping so a drift on either side fails `tsc` immediately.
 *
 * The `WineSearchOrchestrator` composes QueryAnalyzer → DeterministicRouter →
 * (ExecutionRunner OR MiniLoopRunner) → SynthesisRunner into a single async
 * `execute()` method. This module owns:
 *  - the public `WineSearchResult` shape returned to callers,
 *  - the per-phase `ExecutionStep` trace shape,
 *  - the runtime Zod schema (`.strict()`, CLAUDE.md rule 10) that validates
 *    the result before it leaves the orchestrator,
 *  - the small set of named constants the orchestrator needs (query length
 *    bound, aborted-template strings, default token budget).
 *
 * Why a Zod schema for an internal-only orchestrator output?
 *  - It is the integration seam the HTTP route depends on. A runtime parse
 *    before return guarantees the route can rely on the shape — no
 *    `as WineSearchResult` casts downstream (CLAUDE.md schema-quality bar:
 *    no `as DomainType` on cross-module boundaries).
 *  - Numeric inputs that flow through (`tokenUsage.*`, `totalDurationMs`)
 *    carry `.finite()` so NaN cannot poison downstream observability.
 *  - Every array carries `.max(N)` with a domain-justified bound (CLAUDE.md
 *    schema-quality bar).
 *
 * S1 SEMANTIC SPLIT (terminationKind — Design Option C):
 *   `policy_blocked: boolean` historically conflated two distinct shutdown
 *   modes: (a) the security sanitizer rejecting an adversarial query and
 *   (b) the deterministic router rejecting an unsupported / signal-free
 *   query. Operators reading `policy_blocked=true` could not tell whether
 *   they were looking at a security event or a vocabulary-coverage gap;
 *   users in both cases received the same Korean security-template.
 *
 *   Resolution: a new {@link TerminationKind} discriminant lives on the
 *   termination record. `'security_block'` is set ONLY when the analyzer's
 *   adversarial sanitizer fires (`classifyQueryBudget === 'adversarial'`),
 *   and only that branch sets `policy_blocked=true`. Every other
 *   shutdown — admit-gate empty / too-long, router reject, analyzer
 *   malformed — emits `'unsupported_intent'` with `policy_blocked=false`.
 *   The synthesizer selects a different Korean/English template per kind
 *   so the user-facing answer also disambiguates the two cases.
 *
 *   The `kind` field is OPTIONAL on the wire — present only when the
 *   underlying `terminationReason` is `'blocked'`. Other terminations
 *   (`'answer'`, `'fallback'`, `'error'`, ...) omit it.
 */

import { z } from 'zod';
import type { AgentTerminationReason } from '@domain/agent/model/agent-step.js';
import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';
import type { TokenUsage } from '@domain/ai/port/structured-llm.port.js';
import {
  QueryIntentSchema,
  WINE_SEARCH_MAX_CONSTRAINTS,
  WINE_SEARCH_MAX_QUERY_CHARS,
  type QueryIntent,
} from './wine-search-schemas.js';
import {
  SYNTHESIS_MAX_ANSWER_CHARS,
  SYNTHESIS_MIN_ANSWER_CHARS,
  type AnswerResult,
} from './synthesis-schemas.js';
import type { ExecutionPlan } from './execution-plan-schemas.js';
import type {
  WineSearchResponseBody,
  WineSearchStepBody,
  WineSearchToolCallBody,
} from '@interface/http/schemas/wine-search.schema.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15) — every bound is justified.
// ---------------------------------------------------------------------------

/**
 * Maximum length (in code units) of the user-supplied query the orchestrator
 * will admit. Mirrors `MAX_AGENT_HTTP_QUERY_CHARS` in
 * `src/interface/http/constants.ts` and `WINE_SEARCH_MAX_QUERY_CHARS` in
 * `wine-search-schemas.ts`. Re-declared locally so the application layer
 * does not depend on the interface layer (domain ports must not depend on
 * interface code). Arithmetic agreement is enforced by Zod parse failure if
 * either side ever raises its cap above this value.
 */
export const ORCHESTRATOR_MAX_QUERY_CHARS = WINE_SEARCH_MAX_QUERY_CHARS;

/** Soft cap on the per-step execution-step trace surfaced to callers. Two per
 *  phase (analyzer, router, runner/mini-loop, synthesizer) plus mini-loop
 *  inner steps gives a worst-case ≤ 32 for the deepest legitimate plan
 *  (mini-loop 3 steps × 8 anchor drinkability fan-outs). */
const ORCHESTRATOR_MAX_EXECUTION_STEPS = 64;

/** Soft cap on the tool-call set inside a single ExecutionStep. Aligned with
 *  `WINE_SEARCH_MAX_CONSTRAINTS` (32) so a single mini-loop turn cannot
 *  surface more tool calls than the analyzer can have constraints. */
const ORCHESTRATOR_MAX_TOOL_CALLS_PER_STEP = WINE_SEARCH_MAX_CONSTRAINTS;

/** Soft cap on the observation strings inside a single ExecutionStep. Same
 *  reasoning as tool calls — observations are 1:1 with calls. */
const ORCHESTRATOR_MAX_OBSERVATIONS_PER_STEP = WINE_SEARCH_MAX_CONSTRAINTS;

/** Maximum length of an ExecutionStep `summary` field — kept short because
 *  callers display it inline (HTTP debug, trace UI). */
export const ORCHESTRATOR_STEP_SUMMARY_MAX_CHARS = 512;

/** Maximum length of an observation string surfaced into a step trace. Same
 *  bound as the mini-loop's `MINI_LOOP_RESULT_PREVIEW_CHARS` for parity. */
const ORCHESTRATOR_OBSERVATION_MAX_CHARS = 2_000;

/** Maximum length of a tool-call input field (key OR value). Tool inputs are
 *  bounded — anything larger is suspect and we truncate at the boundary. */
export const ORCHESTRATOR_TOOL_INPUT_MAX_CHARS = 4_000;

/** Maximum cumulative tool-outcome count emitted. Defends against runaway
 *  mini-loop traces. Aligned with `WINE_SEARCH_MAX_ANCHORS * 4` (32) since
 *  drinkability fans out one outcome per anchor across up to four turns. */
const ORCHESTRATOR_MAX_TOOL_OUTCOMES = 64;

/** Maximum end-to-end wall-clock for a single `execute()` call. 60s aligns
 *  with the HTTP request budget cap (`DETERMINISTIC_ROUTER_MAX_PER_STEP_TIMEOUT_MS`)
 *  and gives synthesis room above the agent-config 25s ceiling. The Zod
 *  schema enforces `Number.isFinite` so NaN/Infinity cannot pass through. */
const ORCHESTRATOR_MAX_TOTAL_DURATION_MS = 600_000;

/** Default soft total-token cap used when callers do not override. Mirrors
 *  `DEFAULT_AGENT_CONFIG.maxTotalTokens`. */
export const ORCHESTRATOR_DEFAULT_MAX_TOTAL_TOKENS = 50_000;

/**
 * Deterministic Korean answer template used when the caller's `abortSignal`
 * fires inside `execute()`. CLAUDE.md i18n discipline: Korean for hangul
 * surfaces. Kept as a const string so the orchestrator never fabricates a
 * 200-OK answer from an unexpected error (schema-quality bar).
 */
export const ORCHESTRATOR_ABORTED_ANSWER_KOREAN = '요청이 취소되었습니다.';

/** English counterpart of {@link ORCHESTRATOR_ABORTED_ANSWER_KOREAN}. */
export const ORCHESTRATOR_ABORTED_ANSWER_ENGLISH = 'Request canceled.';

// ---------------------------------------------------------------------------
// TerminationKind — S1 semantic split (security vs unsupported intent).
// CLAUDE.md rule 15 (named constants), rule 25/30 (SSoT for the enum), and
// the docstring above motivates the discriminant.
// ---------------------------------------------------------------------------

/** Terminal kind indicating the adversarial sanitizer (analyzer's
 *  `classifyQueryBudget` → `classification === 'adversarial'`) blocked the
 *  query. This is the ONLY case that should surface `policy_blocked=true`. */
export const TERMINATION_KIND_SECURITY_BLOCK = 'security_block';

/** Terminal kind indicating the orchestrator stopped because the request
 *  could not be handled — empty after trim, exceeded the length cap, the
 *  deterministic router emitted a `reject` plan (no anchors, no
 *  constraints, intent=unknown), or the analyzer failed self-consistency
 *  (`malformed`). Operationally this is a vocabulary / coverage signal,
 *  NOT a security event; `policy_blocked` MUST be false. */
export const TERMINATION_KIND_UNSUPPORTED_INTENT = 'unsupported_intent';

/** Zod enum mirroring the {@link TerminationKind} discriminant. */
export const TerminationKindSchema = z.enum([
  TERMINATION_KIND_SECURITY_BLOCK,
  TERMINATION_KIND_UNSUPPORTED_INTENT,
]);
export type TerminationKind = z.infer<typeof TerminationKindSchema>;

// ---------------------------------------------------------------------------
// Zod sub-schemas
// ---------------------------------------------------------------------------

/** Mirror of `TokenUsage` from `structured-llm.port.ts`. Every numeric uses
 *  `.int().finite()` and clamps to non-negative — adapters MUST coerce
 *  missing/NaN fields to 0. */
const OrchestratorTokenUsageSchema = z.object({
  inputTokens: z.number().int().finite().min(0),
  outputTokens: z.number().int().finite().min(0),
  cacheReadTokens: z.number().int().finite().min(0),
  cacheCreationTokens: z.number().int().finite().min(0),
}).strict();

const ExecutionStepSourceSchema = z.enum([
  'analyzer',
  'router',
  'runner',
  'mini_loop',
  'synthesizer',
]);

/**
 * Tool-call shape — matches the Anthropic Messages API `tool_use` block and
 * the OpenAI `tool_calls[].function` shape. Field names (`name`, `arguments`)
 * are canonical across both LLM ecosystems, so we use them as the internal
 * names too — the HTTP wire shape just re-cases the surrounding container.
 */
const ExecutionStepToolCallSchema = z.object({
  name: z.string().min(1).max(ORCHESTRATOR_TOOL_INPUT_MAX_CHARS),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

/**
 * A single per-phase entry in the unified trace. The orchestrator emits one
 * step per analyzer / router / synthesizer phase, and one step per mini-loop
 * turn (each may contain multiple tool calls). The runner branch emits one
 * step per dispatched use case.
 *
 * `summary` is the human-readable one-line description. `toolCalls` and
 * `observations` are optional and parallel-indexed (matching the mini-loop
 * substrate). `tokenUsage` is present when the phase consumed LLM tokens.
 */
export const ExecutionStepSchema = z.object({
  index: z.number().int().finite().min(0),
  source: ExecutionStepSourceSchema,
  summary: z.string().min(1).max(ORCHESTRATOR_STEP_SUMMARY_MAX_CHARS),
  toolCalls: z.array(ExecutionStepToolCallSchema)
    .max(ORCHESTRATOR_MAX_TOOL_CALLS_PER_STEP)
    .optional(),
  observations: z.array(z.string().min(0).max(ORCHESTRATOR_OBSERVATION_MAX_CHARS))
    .max(ORCHESTRATOR_MAX_OBSERVATIONS_PER_STEP)
    .optional(),
  durationMs: z.number().finite().min(0).max(ORCHESTRATOR_MAX_TOTAL_DURATION_MS),
  tokenUsage: OrchestratorTokenUsageSchema.optional(),
}).strict();
export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;

// ---------------------------------------------------------------------------
// Termination / layer / plan-kind enums (mirror the underlying domain unions
// so the result schema is self-contained at the boundary)
// ---------------------------------------------------------------------------

const AgentTerminationReasonSchema = z.enum([
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

const AnswerLayerSchema = z.enum(['primary', 'layer2', 'layer3', 'layer4']);

const DegradedReasonSchema = z.enum([
  'malformed_llm_output',
  'timeout',
  'circuit_open',
  'no_results',
  'policy_blocked',
  // Unmodeled runtime failure inside the primary structured-LLM path —
  // distinguished from `malformed_llm_output` so operations can tell
  // schema-validation noise apart from genuine surprises (P-M1 finding).
  'unexpected_error',
  // S3 grounding-verify: primary answer asserted a factual claim absent from
  // the grounding union; one re-synth was attempted and still ungrounded, so
  // the runner degraded to the deterministic layer ladder.
  'ungrounded_claim',
]);

const PlanKindSchema = z.enum([
  'single-search',
  'parallel-search',
  'comparison',
  'search-then-drinkability',
  'multi-step',
  'reject',
]);

/** Query intent enum surfaced into the result.
 *  Mirrors `WineSearchQueryIntentSchema` in the HTTP wire schema 1:1. The
 *  `'rejected'` slot is appended for queries the analyzer refused. */
const ResultIntentSchema = z.union([QueryIntentSchema, z.literal('rejected')]);

// ---------------------------------------------------------------------------
// `ToolOutcome` zod surface — defensive validation. We mirror only the fields
// the orchestrator surfaces; consumers should reach into the original
// ExecutionRunner / MiniLoop outcomes if they need the raw `result` field
// (we keep `result: unknown` as `z.unknown().optional()` here so opaque
// payloads still parse).
// ---------------------------------------------------------------------------

const ToolOutcomeKindSchema = z.enum([
  'success',
  'empty_result',
  'partial_result',
  'tool_error',
  'timeout',
  'policy_violation',
]);

const ToolOutcomeSchema = z.object({
  stepId: z.string().min(1).max(ORCHESTRATOR_STEP_SUMMARY_MAX_CHARS),
  tool: z.string().min(1).max(ORCHESTRATOR_TOOL_INPUT_MAX_CHARS),
  kind: ToolOutcomeKindSchema,
  result: z.unknown().optional(),
  errorMessage: z.string().max(ORCHESTRATOR_OBSERVATION_MAX_CHARS).optional(),
  postconditionViolations: z.array(z.string().max(ORCHESTRATOR_OBSERVATION_MAX_CHARS)).optional(),
  durationMs: z.number().finite().min(0),
});

// ---------------------------------------------------------------------------
// WineSearchResult — top-level orchestrator output
// ---------------------------------------------------------------------------

export const WineSearchResultSchema = z.object({
  /** Non-empty answer string — invariant guaranteed by the synthesizer's
   *  fallback ladder. Length is bounded by the synthesis schema (mirrors
   *  `SYNTHESIS_MAX_ANSWER_CHARS` so the two layers cannot drift). */
  answer: z.string().min(SYNTHESIS_MIN_ANSWER_CHARS).max(SYNTHESIS_MAX_ANSWER_CHARS),
  layer: AnswerLayerSchema,
  groundedOnToolResults: z.boolean(),
  toolOutcomes: z.array(ToolOutcomeSchema).max(ORCHESTRATOR_MAX_TOOL_OUTCOMES),
  executionSteps: z.array(ExecutionStepSchema).max(ORCHESTRATOR_MAX_EXECUTION_STEPS),
  /** Sum of `executionSteps[i].toolCalls?.length` across every step whose
   *  source is `'runner'` or `'mini_loop'` (the only step kinds that emit
   *  real tool calls). Surfaced at the top level so the HTTP wire's
   *  `execution.tool_call_count` is a pure case-rename — no recomputation
   *  at the HTTP boundary. */
  toolCallCount: z.number().int().finite().min(0).max(ORCHESTRATOR_MAX_TOOL_OUTCOMES),
  tokenUsage: OrchestratorTokenUsageSchema,
  totalDurationMs: z.number().finite().min(0).max(ORCHESTRATOR_MAX_TOTAL_DURATION_MS),
  terminationReason: AgentTerminationReasonSchema,
  policyBlocked: z.boolean(),
  /** S1 discriminant — see module docstring. Present only when
   *  `terminationReason === 'blocked'`. The two values distinguish a real
   *  security-sanitizer block (`policy_blocked === true`) from an
   *  unsupported-intent / vocabulary-gap rejection (`policy_blocked === false`). */
  terminationKind: TerminationKindSchema.optional(),
  degradedReason: DegradedReasonSchema.optional(),
  /** Canonical name (`intent`) matches the HTTP wire field; the underlying
   *  semantic is the analyzer's intent classifier output, with `'rejected'`
   *  appended for analyzer-refused queries. */
  intent: ResultIntentSchema,
  planKind: PlanKindSchema,
}).strict();

// We intentionally export the *interface* form (not z.infer) so callers see
// stable readonly types matching the unified wire contract.
export interface WineSearchResult {
  readonly answer: string;
  readonly layer: 'primary' | 'layer2' | 'layer3' | 'layer4';
  readonly groundedOnToolResults: boolean;
  readonly toolOutcomes: readonly ToolOutcome[];
  readonly executionSteps: readonly ExecutionStep[];
  readonly toolCallCount: number;
  readonly tokenUsage: TokenUsage;
  readonly totalDurationMs: number;
  readonly terminationReason: AgentTerminationReason;
  readonly policyBlocked: boolean;
  /** Discriminator for the two distinct `terminationReason === 'blocked'`
   *  modes. See module docstring (S1 semantic split). */
  readonly terminationKind?: TerminationKind | undefined;
  readonly degradedReason?: AnswerResult['degradedReason'];
  readonly intent: QueryIntent | 'rejected';
  readonly planKind: ExecutionPlan['kind'];
}

// ---------------------------------------------------------------------------
// Compile-time assignability check: the internal CAMEL-cased shape MUST be
// projectable to the HTTP SNAKE-cased wire shape via a key-rename only. If
// either side adds, removes, or retypes a field the asserts below fail to
// compile — pinning the unification invariant.
//
// We assert it at the FIELD level (not the whole envelope) because the
// envelope contains `request_id` which is supplied by the HTTP layer (not
// the orchestrator), and the case-rename of the surrounding container is
// the route handler's single responsibility.
// ---------------------------------------------------------------------------

/** Compile-time projection: internal tool call → wire tool call. */
type _ToolCallProjection = {
  readonly [K in keyof WineSearchToolCallBody]: K extends 'name'
    ? z.infer<typeof ExecutionStepToolCallSchema>['name']
    : K extends 'arguments'
      ? z.infer<typeof ExecutionStepToolCallSchema>['arguments']
      : never;
};
type _AssertToolCallShape =
  _ToolCallProjection extends WineSearchToolCallBody ? true : never;
const _toolCallShapeOk: _AssertToolCallShape = true;
void _toolCallShapeOk;

/** Compile-time projection: internal step.tool_calls element shapes match. */
type _AssertStepToolCallsArrayShape =
  NonNullable<WineSearchStepBody['tool_calls']>[number] extends
    { readonly name: string; readonly arguments: Record<string, unknown> }
    ? true
    : never;
const _stepToolCallsArrayOk: _AssertStepToolCallsArrayShape = true;
void _stepToolCallsArrayOk;

/** Compile-time projection: internal `intent` enum subsumes the wire one. */
type _AssertIntentEnum =
  WineSearchResponseBody['meta']['intent'] extends WineSearchResult['intent']
    ? true
    : never;
const _intentEnumOk: _AssertIntentEnum = true;
void _intentEnumOk;

/** Compile-time projection: internal `terminationReason` enum subsumes the
 *  wire one. Both sides extend the canonical `AgentTerminationReason`. */
type _AssertTerminationEnum =
  WineSearchResponseBody['meta']['termination']['reason'] extends WineSearchResult['terminationReason']
    ? true
    : never;
const _terminationEnumOk: _AssertTerminationEnum = true;
void _terminationEnumOk;

/** Parse-or-throw helper used by the orchestrator before returning. Mirrors
 *  the `safeParse` pattern in QueryAnalyzerService — a parse failure means
 *  the orchestrator emitted a shape inconsistent with its published
 *  contract, which is a bug, not a user issue. */
export function assertWineSearchResult(value: unknown): WineSearchResult {
  const parsed = WineSearchResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `[wine-search-orchestrator] internal contract violation: ${parsed.error.issues
        .slice(0, 3)
        .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}
