/**
 * Shared OpenAI reasoning-model helpers.
 *
 * Reasoning models (gpt-5*, o1*, o3*, o4*) consume "reasoning tokens"
 * BEFORE emitting any visible output. OpenAI's `max_completion_tokens`
 * caps the COMBINED total of (reasoning_tokens + output_tokens), so a
 * caller asking for "300 output tokens" on gpt-5-mini routinely hits
 * `finish_reason="length"` once reasoning consumes the budget. Symptom
 * in the bench: `StructuredLlmPartialOutputError: max_completion_tokens
 * before tool_use complete` on analyze / synthesize, empty refusal text
 * from the chat path, and 0-byte responses from the injection classifier.
 *
 * This module centralizes the fix so all three OpenAI adapters
 * (structured / chat / injection-classifier) compute the same headroom:
 *
 *   - `isReasoningModel(model)` — prefix-based detection
 *   - `resolveCompletionTokens(model, requested)` — adds the reasoning
 *     headroom only for reasoning models; pass-through otherwise
 *   - `resolveReasoningEffort(mode)` — picks a per-mode effort level
 *     (analyze=minimal, execute=low, synthesize=medium) for reasoning
 *     models. Returns `undefined` for non-reasoning models so the param
 *     is omitted (sending it to gpt-4o would be rejected).
 *
 * Both helpers honour env overrides without touching the constants:
 *   - WINE_SEARCH_REASONING_HEADROOM_TOKENS (default 8192)
 *   - WINE_SEARCH_REASONING_EFFORT          (default per-mode)
 */

/** Lowercased model-id prefixes that identify reasoning-capable models. */
const REASONING_MODEL_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'] as const;

/**
 * Default reasoning headroom in tokens. Empirically gpt-5-mini consumes
 * 2K-6K reasoning tokens per structured-output call at `medium` effort;
 * 8K covers the high tail without bloating non-tail spend (the breaker
 * still caps total cost). Override via env when running tight-budget
 * smoke benches.
 */
const DEFAULT_REASONING_HEADROOM_TOKENS = 8_192;

/**
 * Call mode determines the default reasoning effort.
 *
 * Supported values across the gpt-5 / o-series surface vary per deployment:
 *
 *   - `gpt-5-mini` (cloud default): `minimal | low | medium | high`
 *   - `gpt-5.4-mini` (some accounts): `none | low | medium | high | xhigh`
 *
 * `minimal` is rejected by the gpt-5.4-mini surface with HTTP 400. We stay
 * on the lowest universally-supported value (`low`) by default so the
 * classifier path doesn't fail-closed on every request. Callers wanting
 * truly-no-reasoning on supported deployments can set
 * `WINE_SEARCH_REASONING_EFFORT=none` (gpt-5.4-mini only) or `=minimal`
 * (gpt-5-mini only).
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAICallMode = 'analyze' | 'execute' | 'synthesize' | 'classify' | 'chat';

/**
 * Per-mode default reasoning effort. `low` is the lowest value that is
 * accepted across BOTH supported model surfaces (gpt-5-mini AND
 * gpt-5.4-mini) — see the type doc above. Synthesize takes `medium` for
 * coherent multi-fact composition.
 *
 *   - `analyze`     — structured JSON extraction (multi-query, HyDE, NL mapper).
 *   - `execute`     — mini-loop tool dispatch decisions.
 *   - `synthesize`  — final answer synthesis over the candidate pool.
 *   - `classify`    — single-token security verdict (injection classifier).
 *   - `chat`        — generic chat completion.
 */
const DEFAULT_REASONING_EFFORT_BY_MODE: Readonly<Record<OpenAICallMode, ReasoningEffort>> = {
  analyze: 'low',
  execute: 'low',
  synthesize: 'medium',
  classify: 'low',
  chat: 'low',
};

const REASONING_EFFORT_VALUES = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORT_VALUES.has(value as ReasoningEffort);
}

function readReasoningHeadroomFromEnv(): number {
  const raw = process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'];
  if (raw === undefined) return DEFAULT_REASONING_HEADROOM_TOKENS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_REASONING_HEADROOM_TOKENS;
}

function readReasoningEffortOverrideFromEnv(): ReasoningEffort | undefined {
  const raw = process.env['WINE_SEARCH_REASONING_EFFORT'];
  return isReasoningEffort(raw) ? raw : undefined;
}

/** True if `model` is a reasoning-capable OpenAI model. */
export function isReasoningModel(model: string): boolean {
  const lower = model.toLowerCase();
  return REASONING_MODEL_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * Resolve `max_completion_tokens` for an OpenAI request.
 *
 * Reasoning models: returns `requestedMaxOutputTokens + headroom` so the
 * model has room for internal reasoning AND the requested output. The
 * headroom default (8K) is env-overridable.
 *
 * Non-reasoning models: pass-through unchanged.
 */
export function resolveCompletionTokens(
  model: string,
  requestedMaxOutputTokens: number,
): number {
  if (!isReasoningModel(model)) return requestedMaxOutputTokens;
  return requestedMaxOutputTokens + readReasoningHeadroomFromEnv();
}

/**
 * Resolve the `reasoning_effort` parameter for a reasoning-model call.
 *
 * Returns `undefined` for non-reasoning models (the param is rejected by
 * gpt-4o and earlier — must be omitted, not set to a falsy value).
 *
 * Env override `WINE_SEARCH_REASONING_EFFORT` takes precedence over the
 * per-mode default when set to one of `minimal|low|medium|high`.
 */
export function resolveReasoningEffort(
  model: string,
  mode: OpenAICallMode,
): ReasoningEffort | undefined {
  if (!isReasoningModel(model)) return undefined;
  return readReasoningEffortOverrideFromEnv() ?? DEFAULT_REASONING_EFFORT_BY_MODE[mode];
}
