/**
 * Hexagonal port for structured LLM completions backed by Anthropic-style
 * native `tool_use` blocks plus Zod-validated outputs.
 *
 * Three usage modes:
 *  1. {@link StructuredLlmPort.analyze}    — pre-execution analysis: one
 *     forced tool_use that returns a typed object (validated by the
 *     caller-supplied schema). Used for plan/route stages where the model
 *     output must conform to a strict shape.
 *  2. {@link StructuredLlmPort.execute}    — multi-step tool-use loop driver
 *     for a MiniLoop / Plan-then-Execute orchestrator. Returns either a
 *     plain-text turn (`end_turn` / `max_tokens` / `refusal`) or a list of
 *     `tool_use` blocks the orchestrator must dispatch to tool handlers.
 *  3. {@link StructuredLlmPort.synthesize} — post-execution grounded
 *     synthesis: same forced-tool pattern as `analyze`, but takes a
 *     pre-built message history (typically containing tool_use/tool_result
 *     turns) instead of a single user query.
 *
 * Implementations MUST:
 *   - Forward `abortSignal` to the underlying SDK and race it against an
 *     internal per-step timeout, throwing {@link StructuredLlmTimeoutError}
 *     on either trigger.
 *   - Honor `enablePromptCache` by attaching `cache_control:{type:'ephemeral'}`
 *     to BOTH the system prompt's last text block AND the tools array
 *     (Anthropic prompt-caching contract).
 *   - Validate tool_use input against the caller-supplied Zod schema with
 *     `.safeParse()`, throwing {@link StructuredLlmValidationError} (with
 *     `issues` + `rawOutput` populated) on failure. NEVER cast LLM output
 *     with `as`.
 *   - Convert Zod schemas to JSON Schema before sending to the SDK — raw
 *     Zod must never reach the network.
 *
 * This port is intentionally independent of {@link ../port/chat-llm.port.js}.
 * The two coexist: `ChatLlmPort` handles legacy plain-text completions while
 * `StructuredLlmPort` powers the new orchestrator. Do not collapse them.
 */

import { type z } from 'zod';
import { type ChatMessage } from './chat-llm.port.js';

/** Token accounting derived from Anthropic `response.usage`. All fields are
 *  finite non-negative integers — adapters MUST coerce missing/NaN fields to 0
 *  before returning. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Mirrors `cache_read_input_tokens` — billed at ~10% of normal input. */
  readonly cacheReadTokens: number;
  /** Mirrors `cache_creation_input_tokens` — billed at ~1.25x once. */
  readonly cacheCreationTokens: number;
}

/** Discriminated tool-choice mode passed to {@link StructuredLlmPort.execute}. */
export type ToolChoice =
  | 'auto'
  | 'any'
  | { readonly type: 'tool'; readonly name: string };

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Caller's Zod schema for the tool's `input` argument. Converted to JSON
   *  Schema by the adapter before serialization to the Anthropic API. The
   *  schema is NOT forced to be `.strict()` — LLMs routinely emit extra
   *  fields (reasoning, confidence) and strict mode rejects them
   *  (CLAUDE.md rule 10 exception). */
  readonly inputSchema: z.ZodTypeAny;
}

export interface AnalyzeRequest<TSchema extends z.ZodTypeAny> {
  readonly query: string;
  readonly schema: TSchema;
  readonly systemPrompt: string;
  /** When true, attaches `cache_control:{type:'ephemeral'}` to the system
   *  prompt block and the tools array. Defaults to `false`. */
  readonly enablePromptCache?: boolean;
  readonly maxOutputTokens: number;
  readonly perStepTimeoutMs: number;
  readonly abortSignal?: AbortSignal;
  /** Deterministic seed for replay if the model supports it. */
  readonly seed?: number;
  readonly model: string;
}

export interface AnalyzeResult<T> {
  readonly data: T;
  readonly usage: TokenUsage;
  readonly durationMs: number;
}

export interface ExecuteRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly systemPrompt: string;
  readonly enablePromptCache?: boolean;
  readonly maxOutputTokens: number;
  readonly perStepTimeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly model: string;
  /** Defaults to `'auto'` when omitted. */
  readonly toolChoice?: ToolChoice;
}

export interface ToolUseCall {
  readonly id: string;
  readonly name: string;
  /** Raw tool input object as parsed from the Anthropic response. The caller
   *  is responsible for validating this against the matching
   *  {@link ToolDefinition.inputSchema} before dispatching. */
  readonly input: Record<string, unknown>;
}

export type ExecuteResult =
  | {
      readonly kind: 'tool_use';
      readonly calls: readonly ToolUseCall[];
      readonly usage: TokenUsage;
      readonly durationMs: number;
      readonly stopReason: 'tool_use';
    }
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly usage: TokenUsage;
      readonly durationMs: number;
      readonly stopReason: 'end_turn' | 'max_tokens' | 'refusal';
    };

export interface SynthesizeRequest<TSchema extends z.ZodTypeAny> {
  readonly messages: readonly ChatMessage[];
  readonly schema: TSchema;
  readonly systemPrompt: string;
  readonly enablePromptCache?: boolean;
  readonly maxOutputTokens: number;
  readonly perStepTimeoutMs: number;
  readonly abortSignal?: AbortSignal;
  readonly seed?: number;
  readonly model: string;
}

export interface SynthesizeResult<T> {
  readonly data: T;
  readonly usage: TokenUsage;
  readonly durationMs: number;
}

export interface StructuredLlmPort {
  /** Pre-execution analysis: query → typed result (single forced tool_use). */
  analyze<TSchema extends z.ZodTypeAny>(
    req: AnalyzeRequest<TSchema>,
  ): Promise<AnalyzeResult<z.infer<TSchema>>>;

  /** Multi-step tool-use execution loop. */
  execute(req: ExecuteRequest): Promise<ExecuteResult>;

  /** Post-execution grounded synthesis: history → typed answer. */
  synthesize<TSchema extends z.ZodTypeAny>(
    req: SynthesizeRequest<TSchema>,
  ): Promise<SynthesizeResult<z.infer<TSchema>>>;
}

// ---------------------------------------------------------------------------
// Error classes — each sets `name = this.constructor.name` so the pino
// `serializers.err` sanitizer (bootstrap-logger.ts) reports a stable, useful
// `type` field instead of generic `'Error'`.
// ---------------------------------------------------------------------------

/** Raised when the tool_use input parses as JSON but fails Zod validation
 *  against the caller-supplied schema. */
export class StructuredLlmValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];
  readonly rawOutput: unknown;

  constructor(issues: readonly z.ZodIssue[], rawOutput: unknown, message?: string) {
    super(message ?? 'structured-llm: schema validation failed');
    this.name = 'StructuredLlmValidationError';
    this.issues = issues;
    this.rawOutput = rawOutput;
  }
}

/** Raised when the model produced a `stop_reason: 'refusal'` (Anthropic safety
 *  block) or returned an explicit refusal block. */
export class StructuredLlmRefusalError extends Error {
  constructor(message?: string) {
    super(message ?? 'structured-llm: model refused to respond');
    this.name = 'StructuredLlmRefusalError';
  }
}

/** Raised when the model returned `stop_reason: 'max_tokens'` AND the truncated
 *  output cannot be parsed (no usable tool_use block / unparseable JSON). */
export class StructuredLlmPartialOutputError extends Error {
  readonly rawOutput: unknown;

  constructor(rawOutput: unknown, message?: string) {
    super(message ?? 'structured-llm: truncated output could not be parsed');
    this.name = 'StructuredLlmPartialOutputError';
    this.rawOutput = rawOutput;
  }
}

/** Raised when either the per-step timeout fires or the caller's
 *  `abortSignal` aborts before completion. */
export class StructuredLlmTimeoutError extends Error {
  constructor(message?: string) {
    super(message ?? 'structured-llm: request timed out');
    this.name = 'StructuredLlmTimeoutError';
  }
}

/** Raised when the adapter's circuit breaker is OPEN and the request is
 *  fast-failed without reaching the API. */
export class StructuredLlmCircuitOpenError extends Error {
  constructor(breakerName: string, message?: string) {
    super(message ?? `structured-llm: circuit breaker "${breakerName}" is OPEN`);
    this.name = 'StructuredLlmCircuitOpenError';
  }
}
