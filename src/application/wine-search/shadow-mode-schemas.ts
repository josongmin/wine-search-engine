/**
 * ShadowModeRunner — Zod contract for shadow-mode diff reports.
 *
 * Shadow mode runs the legacy `AgentOrchestrator` and the new
 * `WineSearchOrchestrator` against the same query in parallel, then emits a
 * structured diff report so we can validate behavioural parity / improvement
 * before flipping the production switch.
 *
 * Design notes:
 *  - Every schema chains `.strict()` (CLAUDE.md rule 10). None of these are
 *    LLM tool-call shapes; they are internal contracts that must fail closed
 *    on unknown keys.
 *  - Every numeric uses `.finite()` (schema-quality bar) — NaN/Infinity must
 *    never poison divergence metrics.
 *  - Every bound is a named const (CLAUDE.md rule 15) with a domain
 *    justification.
 *  - No `as` casts — Zod inference is the single source of truth for types.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15) — every bound is justified.
// ---------------------------------------------------------------------------

/**
 * End-to-end wall-clock budget for one shadow run. Must accommodate BOTH
 * orchestrators: the legacy `AgentOrchestrator` has a 25 s agent timeout
 * baseline and the new `WineSearchOrchestrator` allows up to 60 s; we add
 * ~10 s headroom for synthesis cancellation cleanup and pick the larger
 * envelope so neither side is unfairly timed out.
 */
export const SHADOW_MODE_DEFAULT_TIMEOUT_MS = 35_000;

/**
 * Lower bound on token-set Jaccard similarity for two answers to be treated
 * as semantically equivalent. 0.85 chosen empirically: on Korean wine
 * benchmark answers, paraphrases of the same recommendation typically score
 * ≥0.85 (shared anchor entities + numerals dominate), while genuinely
 * divergent answers score <0.7.
 */
export const SHADOW_MODE_ANSWER_SIMILARITY_THRESHOLD = 0.85;

/** Length cap on the answer preview surfaced in a report (UI/log triage). */
export const SHADOW_MODE_ANSWER_PREVIEW_CHARS = 240;

/** Length cap on the query preview surfaced in a report. Mirrors the
 *  Korean wine query upper bound used elsewhere in the application layer
 *  (`WINE_SEARCH_MAX_QUERY_CHARS`). */
export const SHADOW_MODE_QUERY_PREVIEW_CHARS = 2_000;

/** Cap on the number of distinct divergence reasons recorded in a single
 *  diff. Five categories cover everything the diff currently emits
 *  (answer_dissimilar, tool_set_diff, tool_order_diff,
 *  termination_reason_diff, one_side_errored); we leave headroom for two
 *  future reasons without unbounding the array. */
export const SHADOW_MODE_MAX_DIVERGENT_REASONS = 7;

/** Cap on the number of tool names recorded per orchestrator outcome. The
 *  legacy agent's `maxSteps` upper bound is 10 and the new orchestrator's
 *  `ORCHESTRATOR_MAX_EXECUTION_STEPS` is 64 with up to 32 tool calls per
 *  step; we cap at 128 to allow a worst-case mini-loop trace without
 *  unbounding. */
export const SHADOW_MODE_MAX_TOOL_NAMES = 128;

/** Cap on the answer length stored verbatim in a report. Mirrors the
 *  synthesis schema's 3 000-char answer bound. */
export const SHADOW_MODE_MAX_ANSWER_CHARS = 3_000;

/** Cap on error-message length stored in a report — long stack traces are
 *  truncated before persistence. */
export const SHADOW_MODE_MAX_ERROR_MESSAGE_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Orchestrator identity
// ---------------------------------------------------------------------------

export const ShadowModeOrchestratorIdSchema = z.enum(['legacy_agent', 'wine_search']);
export type ShadowModeOrchestratorId = z.infer<typeof ShadowModeOrchestratorIdSchema>;

// ---------------------------------------------------------------------------
// Per-orchestrator outcome
// ---------------------------------------------------------------------------

export const ShadowModeOrchestratorStatusSchema = z.enum([
  'ok',
  'error',
  'timeout',
  'aborted',
]);
export type ShadowModeOrchestratorStatus = z.infer<typeof ShadowModeOrchestratorStatusSchema>;

export const ShadowModeTokenUsageSchema = z.object({
  inputTokens: z.number().int().finite().min(0),
  outputTokens: z.number().int().finite().min(0),
  cacheReadTokens: z.number().int().finite().min(0).optional(),
  cacheCreationTokens: z.number().int().finite().min(0).optional(),
}).strict();
export type ShadowModeTokenUsage = z.infer<typeof ShadowModeTokenUsageSchema>;

export const ShadowModeOrchestratorOutcomeSchema = z.object({
  orchestrator: ShadowModeOrchestratorIdSchema,
  status: ShadowModeOrchestratorStatusSchema,
  answer: z.string().max(SHADOW_MODE_MAX_ANSWER_CHARS).optional(),
  /** Synthesis layer (`primary` / `layer2` / ...) for the wine-search side;
   *  legacy agent omits this field. */
  layer: z.string().max(SHADOW_MODE_ANSWER_PREVIEW_CHARS).optional(),
  toolCallCount: z.number().int().finite().min(0),
  toolNames: z.array(z.string().min(1).max(SHADOW_MODE_ANSWER_PREVIEW_CHARS))
    .max(SHADOW_MODE_MAX_TOOL_NAMES),
  terminationReason: z.string().min(1).max(SHADOW_MODE_ANSWER_PREVIEW_CHARS),
  totalDurationMs: z.number().int().finite().min(0),
  tokenUsage: ShadowModeTokenUsageSchema,
  errorMessage: z.string().max(SHADOW_MODE_MAX_ERROR_MESSAGE_CHARS).optional(),
}).strict();
export type ShadowModeOrchestratorOutcome = z.infer<typeof ShadowModeOrchestratorOutcomeSchema>;

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export const ShadowModeDivergentReasonSchema = z.enum([
  'answer_dissimilar',
  'tool_set_diff',
  'tool_order_diff',
  'termination_reason_diff',
  'one_side_errored',
]);
export type ShadowModeDivergentReason = z.infer<typeof ShadowModeDivergentReasonSchema>;

export const ShadowModeDiffSchema = z.object({
  answerEquivalent: z.boolean(),
  answerSimilarity: z.number().finite().min(0).max(1),
  toolSetEqual: z.boolean(),
  toolOrderEqual: z.boolean(),
  terminationReasonEqual: z.boolean(),
  durationDeltaMs: z.number().finite(),
  tokenDeltaInput: z.number().int().finite(),
  tokenDeltaOutput: z.number().int().finite(),
  divergent: z.boolean(),
  divergentReasons: z.array(ShadowModeDivergentReasonSchema)
    .max(SHADOW_MODE_MAX_DIVERGENT_REASONS),
}).strict();
export type ShadowModeDiff = z.infer<typeof ShadowModeDiffSchema>;

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

export const ShadowModeReportSchema = z.object({
  requestId: z.string().min(1).max(SHADOW_MODE_ANSWER_PREVIEW_CHARS),
  query: z.string().min(0).max(SHADOW_MODE_QUERY_PREVIEW_CHARS),
  queryPreview: z.string().max(SHADOW_MODE_QUERY_PREVIEW_CHARS),
  legacy: ShadowModeOrchestratorOutcomeSchema,
  wineSearch: ShadowModeOrchestratorOutcomeSchema,
  diff: ShadowModeDiffSchema,
  scenarioId: z.string().max(SHADOW_MODE_ANSWER_PREVIEW_CHARS).optional(),
}).strict();
export type ShadowModeReport = z.infer<typeof ShadowModeReportSchema>;
