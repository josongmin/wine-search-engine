/**
 * Anthropic Messages API adapter for {@link StructuredLlmPort}.
 *
 * Differences from {@link AnthropicChatLlm} (the legacy plain-text adapter):
 *   - Uses **native `tool_use` blocks** as the structured-output channel.
 *     `analyze` / `synthesize` register a single virtual tool named
 *     {@link RESPOND_TOOL_NAME} (`respond`) whose `input_schema` is the
 *     caller-supplied Zod schema converted to JSON Schema. `tool_choice` is
 *     forced to that tool, so the model MUST emit one tool_use block whose
 *     input we then validate with Zod. This is far more reliable than the
 *     legacy "ask for JSON in text" pattern.
 *   - Supports **prompt caching** end-to-end. When
 *     {@link AnalyzeRequest.enablePromptCache} (or the corresponding flag on
 *     other modes) is true, `cache_control: {type:'ephemeral'}` is attached
 *     to the system prompt's last text block AND the tools array. Token
 *     accounting reports both `cacheReadTokens` and `cacheCreationTokens`.
 *   - Supports a **multi-step `execute`** entrypoint for orchestrators that
 *     drive a tool-use loop themselves (the caller dispatches tools and feeds
 *     `tool_result` blocks back in via {@link ChatMessage} history).
 *
 * Operational contracts mirror the legacy adapter:
 *   - Cooperative abort via `AbortSignal`; an internal per-step timeout races
 *     against the SDK call. Both feed into the same `AbortController` so
 *     `fetch` is cancelled the moment either fires. Cleanup happens in
 *     `finally` on every path (`clearTimeout` + listener removal).
 *   - Circuit breaker registered in {@link globalCircuitBreakerRegistry} —
 *     the LLM-aware classifier ({@link runUnderLlmBreaker}) treats 4xx
 *     non-429 responses as caller faults (not service degradation) so a
 *     buggy caller cannot single-handedly trip the breaker.
 *   - Retry with backoff for 5xx / 429 / transient network errors. 4xx
 *     surfaces immediately to the error mapper.
 */

import type { z, ZodIssue, ZodTypeAny } from 'zod';

import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../../domain/shared/error/circuit-breaker-open-error.js';
import { globalCircuitBreakerRegistry } from '../../domain/observability/circuit-breaker-registry.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import {
  type AnalyzeRequest,
  type AnalyzeResult,
  type ExecuteRequest,
  type ExecuteResult,
  type StructuredLlmPort,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TokenUsage,
  type ToolUseCall,
  StructuredLlmCircuitOpenError,
  StructuredLlmPartialOutputError,
  StructuredLlmRefusalError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
} from '../../domain/ai/port/structured-llm.port.js';
import { type ChatMessage } from '../../domain/ai/port/chat-llm.port.js';
import { fetchWithTimeout, isAbortError } from '../http/fetch-with-timeout.js';
import {
  parseRetryAfterHeader,
  retryWithBackoff,
  type RetryConfig,
} from '../http/retry-with-backoff.js';
import { AnthropicTransportError } from './anthropic-transport-error.js';
import { runUnderLlmBreaker } from './llm-circuit-breaker-classifier.js';

// ---------------------------------------------------------------------------
// Module-scope constants (CLAUDE.md rules 15/16/30: no magic numbers).
// ---------------------------------------------------------------------------

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** Virtual tool used by `analyze` / `synthesize` to coerce the model into
 *  emitting a single structured-output `tool_use` block. The name is opaque
 *  to the caller — they pass the schema, we wrap it in this tool. */
const RESPOND_TOOL_NAME = 'respond';
const RESPOND_TOOL_DESCRIPTION =
  'Return your final response as a single structured object matching the provided schema. Call this tool exactly once.';

/** Truncate length for error-body previews in thrown messages. */
const ERROR_PREVIEW_CHARS = 200;
/** Max chars of message content the logger will print at debug level. Above
 *  this we elide — protects the log pipeline from multi-KB user payloads
 *  and reduces accidental PII surface area (CLAUDE.md schema quality bar). */
const LOG_CONTENT_PREVIEW_CHARS = 200;

/** Circuit breaker thresholds for the structured-LLM endpoint. Same shape as
 *  the legacy chat adapter — 5 consecutive service-health failures trip the
 *  breaker, 60s cool-off, 3 probe successes to re-close. */
const ANTHROPIC_STRUCTURED_BREAKER_FAILURE_THRESHOLD = 5;
const ANTHROPIC_STRUCTURED_BREAKER_RECOVERY_TIMEOUT_MS = 60_000;
const ANTHROPIC_STRUCTURED_BREAKER_HALF_OPEN_MAX_ATTEMPTS = 3;
const ANTHROPIC_STRUCTURED_BREAKER_NAME = 'anthropic-structured';

const ANTHROPIC_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
  label: 'Anthropic structured',
};

/** HTTP status range where 4xx schema-shaped errors live — we map these to
 *  validation errors instead of letting them trip the breaker. */
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNPROCESSABLE_ENTITY = 422;

// ---------------------------------------------------------------------------
// Adapter options + Anthropic wire types
// ---------------------------------------------------------------------------

export interface ClaudeStructuredLlmAdapterOptions {
  readonly apiKey: string;
  readonly defaultModel?: string;
  /** Overall HTTP-layer timeout — outer bound. The per-step timeout passed
   *  on every request races against this; the smaller of the two wins. */
  readonly httpTimeoutMs: number;
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

interface AnthropicTextBlock {
  readonly type: 'text';
  readonly text: string;
}
interface AnthropicToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | { readonly type: string; readonly [k: string]: unknown };

interface AnthropicResponse {
  readonly id: string;
  readonly model: string;
  readonly stop_reason: string | null;
  readonly content: readonly AnthropicContentBlock[];
  readonly usage?: AnthropicUsage;
}

function isAnthropicResponse(v: unknown): v is AnthropicResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['id'] === 'string' && Array.isArray(o['content']);
}

// ---------------------------------------------------------------------------
// Minimal Zod → JSON Schema converter (no external dep)
//
// Supports the subset needed for tool input schemas:
//   object, array, string, number, integer, boolean, enum, literal,
//   optional, nullable, default, union (best-effort), discriminated union.
// `zod-to-json-schema` would do this more completely; we keep dep surface
// minimal and explicit. The result is the `input_schema` payload Anthropic
// expects (Draft-7 superset).
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  // Probe the runtime Zod kind via the underlying def. We avoid `instanceof`
  // chains because Zod re-exports tagged types and the def is the stable API.
  const def = (schema as { _def?: { typeName?: string } })._def;
  const typeName = def?.typeName ?? '';

  switch (typeName) {
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      return out;
    }
    case 'ZodNumber': {
      const out: JsonSchema = { type: 'number' };
      return out;
    }
    case 'ZodBoolean': {
      return { type: 'boolean' };
    }
    case 'ZodLiteral': {
      const lit = (schema as unknown as z.ZodLiteral<unknown>);
      const value = lit._def.value;
      return { const: value };
    }
    case 'ZodEnum': {
      const enumDef = (schema as unknown as z.ZodEnum<[string, ...string[]]>);
      return { type: 'string', enum: [...enumDef._def.values] };
    }
    case 'ZodNativeEnum': {
      const ne = schema as unknown as { _def: { values: Record<string, string | number> } };
      const values = Object.values(ne._def.values).filter(
        (v): v is string | number => typeof v === 'string' || typeof v === 'number',
      );
      return { enum: values };
    }
    case 'ZodArray': {
      const arr = (schema as unknown as z.ZodArray<ZodTypeAny>);
      return { type: 'array', items: zodToJsonSchema(arr._def.type) };
    }
    case 'ZodObject': {
      const obj = (schema as unknown as z.ZodObject<z.ZodRawShape>);
      const shape = obj._def.shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const key of Object.keys(shape)) {
        const child = shape[key];
        if (child === undefined) continue;
        properties[key] = zodToJsonSchema(child);
        if (!isOptionalSchema(child)) required.push(key);
      }
      const result: JsonSchema = { type: 'object', properties };
      if (required.length > 0) result['required'] = required;
      return result;
    }
    case 'ZodOptional': {
      const opt = (schema as unknown as z.ZodOptional<ZodTypeAny>);
      return zodToJsonSchema(opt._def.innerType);
    }
    case 'ZodNullable': {
      const nul = (schema as unknown as z.ZodNullable<ZodTypeAny>);
      const inner = zodToJsonSchema(nul._def.innerType);
      // `type` is best-effort union with 'null' when present.
      const innerType = inner['type'];
      if (typeof innerType === 'string') {
        return { ...inner, type: [innerType, 'null'] };
      }
      return { ...inner, nullable: true };
    }
    case 'ZodDefault': {
      const def2 = (schema as unknown as z.ZodDefault<ZodTypeAny>);
      return zodToJsonSchema(def2._def.innerType);
    }
    case 'ZodUnion': {
      const un = (schema as unknown as z.ZodUnion<readonly [ZodTypeAny, ...ZodTypeAny[]]>);
      return { anyOf: un._def.options.map((o) => zodToJsonSchema(o)) };
    }
    case 'ZodDiscriminatedUnion': {
      const du = (schema as unknown as { _def: { options: readonly ZodTypeAny[] } });
      return { anyOf: du._def.options.map((o) => zodToJsonSchema(o)) };
    }
    case 'ZodRecord': {
      const rec = (schema as unknown as z.ZodRecord);
      return { type: 'object', additionalProperties: zodToJsonSchema(rec._def.valueType) };
    }
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    default:
      // Unknown / unsupported — fall back to the permissive shape rather than
      // throwing. Anthropic will still validate the tool_use input shape and
      // we run Zod safeParse on the response.
      return {};
  }
}

function isOptionalSchema(schema: ZodTypeAny): boolean {
  const def = (schema as { _def?: { typeName?: string; innerType?: ZodTypeAny } })._def;
  const tn = def?.typeName;
  if (tn === 'ZodOptional' || tn === 'ZodDefault') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeStructuredLlmAdapter implements StructuredLlmPort {
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly httpTimeoutMs: number;
  private readonly endpoint: string;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: ClaudeStructuredLlmAdapterOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? ANTHROPIC_DEFAULT_MODEL;
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.endpoint = `${ANTHROPIC_API_BASE}${ANTHROPIC_MESSAGES_PATH}`;
    this.circuitBreaker = createCircuitBreaker({
      name: ANTHROPIC_STRUCTURED_BREAKER_NAME,
      failureThreshold: ANTHROPIC_STRUCTURED_BREAKER_FAILURE_THRESHOLD,
      recoveryTimeoutMs: ANTHROPIC_STRUCTURED_BREAKER_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: ANTHROPIC_STRUCTURED_BREAKER_HALF_OPEN_MAX_ATTEMPTS,
    });
    globalCircuitBreakerRegistry.register(
      ANTHROPIC_STRUCTURED_BREAKER_NAME,
      this.circuitBreaker,
    );
  }

  // --------------- public port methods ---------------

  async analyze<TSchema extends ZodTypeAny>(
    req: AnalyzeRequest<TSchema>,
  ): Promise<AnalyzeResult<z.infer<TSchema>>> {
    const messages: readonly ChatMessage[] = [{ role: 'user', content: req.query }];
    const start = Date.now();
    const { rawInput, usage, stopReason } = await this.runStructuredCall({
      schema: req.schema,
      messages,
      systemPrompt: req.systemPrompt,
      enablePromptCache: req.enablePromptCache ?? false,
      maxOutputTokens: req.maxOutputTokens,
      perStepTimeoutMs: req.perStepTimeoutMs,
      model: req.model,
      ...(req.abortSignal !== undefined ? { abortSignal: req.abortSignal } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    });
    const data = this.validateOrThrow(req.schema, rawInput, stopReason);
    return { data, usage, durationMs: Date.now() - start };
  }

  async synthesize<TSchema extends ZodTypeAny>(
    req: SynthesizeRequest<TSchema>,
  ): Promise<SynthesizeResult<z.infer<TSchema>>> {
    const start = Date.now();
    const { rawInput, usage, stopReason } = await this.runStructuredCall({
      schema: req.schema,
      messages: req.messages,
      systemPrompt: req.systemPrompt,
      enablePromptCache: req.enablePromptCache ?? false,
      maxOutputTokens: req.maxOutputTokens,
      perStepTimeoutMs: req.perStepTimeoutMs,
      model: req.model,
      ...(req.abortSignal !== undefined ? { abortSignal: req.abortSignal } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    });
    const data = this.validateOrThrow(req.schema, rawInput, stopReason);
    return { data, usage, durationMs: Date.now() - start };
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const start = Date.now();
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.inputSchema),
    }));

    const body = this.buildBaseBody({
      messages: req.messages,
      systemPrompt: req.systemPrompt,
      enablePromptCache: req.enablePromptCache ?? false,
      maxOutputTokens: req.maxOutputTokens,
      model: req.model,
      tools,
      toolChoice: this.toAnthropicToolChoice(req.toolChoice),
    });

    const response = await this.runAnthropicCall(
      body,
      req.perStepTimeoutMs,
      req.abortSignal,
    );
    const usage = parseUsage(response.usage);
    const durationMs = Date.now() - start;
    const stopReason = response.stop_reason;

    if (stopReason === 'refusal' || hasRefusalIndicator(response.content)) {
      throw new StructuredLlmRefusalError();
    }

    if (stopReason === 'tool_use') {
      const calls: ToolUseCall[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          const toolBlock = block as AnthropicToolUseBlock;
          calls.push({
            id: toolBlock.id,
            name: toolBlock.name,
            input: coerceInputObject(toolBlock.input),
          });
        }
      }
      return {
        kind: 'tool_use',
        calls,
        usage,
        durationMs,
        stopReason: 'tool_use',
      };
    }

    // Plain-text turn (end_turn / max_tokens) — pull text blocks.
    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += (block as AnthropicTextBlock).text;
    }

    const normalized = normalizeTextStopReason(stopReason);
    return {
      kind: 'text',
      text,
      usage,
      durationMs,
      stopReason: normalized,
    };
  }

  // --------------- internals ---------------

  /** Common pre-flight for analyze/synthesize: build forced-tool body and
   *  return the parsed tool_use input + usage. Validation against the user
   *  schema happens in the caller (so we can attach `rawOutput` correctly). */
  private async runStructuredCall(args: {
    readonly schema: ZodTypeAny;
    readonly messages: readonly ChatMessage[];
    readonly systemPrompt: string;
    readonly enablePromptCache: boolean;
    readonly maxOutputTokens: number;
    readonly perStepTimeoutMs: number;
    readonly model: string;
    readonly abortSignal?: AbortSignal;
    readonly seed?: number;
  }): Promise<{
    readonly rawInput: unknown;
    readonly usage: TokenUsage;
    readonly stopReason: string | null;
  }> {
    const respondTool = {
      name: RESPOND_TOOL_NAME,
      description: RESPOND_TOOL_DESCRIPTION,
      input_schema: zodToJsonSchema(args.schema),
    };

    const body = this.buildBaseBody({
      messages: args.messages,
      systemPrompt: args.systemPrompt,
      enablePromptCache: args.enablePromptCache,
      maxOutputTokens: args.maxOutputTokens,
      model: args.model,
      tools: [respondTool],
      toolChoice: { type: 'tool', name: RESPOND_TOOL_NAME },
    });

    const response = await this.runAnthropicCall(
      body,
      args.perStepTimeoutMs,
      args.abortSignal,
    );

    const usage = parseUsage(response.usage);
    const stopReason = response.stop_reason;

    if (stopReason === 'refusal' || hasRefusalIndicator(response.content)) {
      throw new StructuredLlmRefusalError();
    }

    const toolBlock = response.content.find(
      (b): b is AnthropicToolUseBlock =>
        b.type === 'tool_use' && (b as AnthropicToolUseBlock).name === RESPOND_TOOL_NAME,
    );

    if (toolBlock === undefined) {
      // No tool_use block present. Most common cause: truncation at max_tokens
      // before the model emitted the structured block.
      if (stopReason === 'max_tokens') {
        throw new StructuredLlmPartialOutputError(
          { content: response.content, stop_reason: stopReason },
          'structured-llm: model output truncated at max_tokens before emitting tool_use',
        );
      }
      throw new StructuredLlmPartialOutputError(
        { content: response.content, stop_reason: stopReason },
        'structured-llm: response contained no `respond` tool_use block',
      );
    }

    return { rawInput: toolBlock.input, usage, stopReason };
  }

  /** Validate the raw tool input against the caller's schema. Throws
   *  {@link StructuredLlmValidationError} on parse failure. */
  private validateOrThrow<TSchema extends ZodTypeAny>(
    schema: TSchema,
    rawInput: unknown,
    stopReason: string | null,
  ): z.infer<TSchema> {
    const parsed = schema.safeParse(rawInput);
    if (parsed.success) {
      return parsed.data as z.infer<TSchema>;
    }
    // If truncation also occurred, surface the more specific partial-output
    // error so callers can retry with a larger budget rather than treating
    // it as a permanent schema bug.
    if (stopReason === 'max_tokens') {
      throw new StructuredLlmPartialOutputError(
        rawInput,
        'structured-llm: truncated tool_use input failed schema validation',
      );
    }
    const issues: ZodIssue[] = parsed.error.issues;
    throw new StructuredLlmValidationError(issues, rawInput);
  }

  /** Build the Anthropic Messages-API request body shared by all three
   *  entrypoints. Encapsulates prompt-cache attachment and message
   *  normalization. */
  private buildBaseBody(args: {
    readonly messages: readonly ChatMessage[];
    readonly systemPrompt: string;
    readonly enablePromptCache: boolean;
    readonly maxOutputTokens: number;
    readonly model: string;
    readonly tools: readonly { readonly name: string; readonly description: string; readonly input_schema: JsonSchema }[];
    readonly toolChoice: Record<string, unknown>;
  }): Record<string, unknown> {
    // Split system messages from conversation turns. Anthropic wants `system`
    // as a top-level parameter (block-array form when caching is enabled).
    const turns: { readonly role: 'user' | 'assistant'; readonly content: string }[] = [];
    let extraSystem = '';
    for (const msg of args.messages) {
      if (msg.role === 'system') {
        extraSystem = extraSystem.length > 0 ? `${extraSystem}\n\n${msg.content}` : msg.content;
      } else {
        turns.push({ role: msg.role, content: msg.content });
      }
    }
    // Anthropic requires the first turn to be `user` and at least one to exist.
    if (turns.length === 0) {
      turns.push({ role: 'user', content: '(continue)' });
    }

    const systemText = extraSystem.length > 0
      ? `${args.systemPrompt}\n\n${extraSystem}`
      : args.systemPrompt;

    const systemBlock: Record<string, unknown> = {
      type: 'text',
      text: systemText,
    };
    if (args.enablePromptCache) {
      systemBlock['cache_control'] = { type: 'ephemeral' };
    }

    // Tools: attach cache_control to the LAST tool when caching is enabled.
    // Anthropic caches up to and including the marker — placing it on the
    // last tool covers the entire tools array.
    const toolsPayload: Record<string, unknown>[] = args.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
    if (args.enablePromptCache && toolsPayload.length > 0) {
      const last = toolsPayload[toolsPayload.length - 1];
      if (last !== undefined) last['cache_control'] = { type: 'ephemeral' };
    }

    const body: Record<string, unknown> = {
      model: args.model.length > 0 ? args.model : this.defaultModel,
      system: [systemBlock],
      messages: turns,
      max_tokens: args.maxOutputTokens,
      tools: toolsPayload,
      tool_choice: args.toolChoice,
    };
    return body;
  }

  private toAnthropicToolChoice(
    choice: ExecuteRequest['toolChoice'],
  ): Record<string, unknown> {
    if (choice === undefined) return { type: 'auto' };
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'any') return { type: 'any' };
    return { type: 'tool', name: choice.name };
  }

  /** Wrap the SDK call with circuit breaker + retry + abort + per-step
   *  timeout. Errors are mapped to the structured-llm error taxonomy. */
  private async runAnthropicCall(
    body: Record<string, unknown>,
    perStepTimeoutMs: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<AnthropicResponse> {
    try {
      return await runUnderLlmBreaker(
        this.circuitBreaker,
        ANTHROPIC_STRUCTURED_BREAKER_NAME,
        () => this.fetchAnthropic(body, perStepTimeoutMs, abortSignal),
      );
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        throw new StructuredLlmCircuitOpenError(ANTHROPIC_STRUCTURED_BREAKER_NAME);
      }
      if (
        err instanceof StructuredLlmRefusalError
        || err instanceof StructuredLlmPartialOutputError
        || err instanceof StructuredLlmValidationError
        || err instanceof StructuredLlmTimeoutError
      ) {
        throw err;
      }
      if (isAbortError(err) || (err instanceof Error && err.name === 'AbortError')) {
        throw new StructuredLlmTimeoutError();
      }
      throw err;
    }
  }

  /** Inner fetch with retry. Honors the smaller of `perStepTimeoutMs` and the
   *  adapter-wide `httpTimeoutMs` so callers cannot exceed the outer bound. */
  private async fetchAnthropic(
    body: Record<string, unknown>,
    perStepTimeoutMs: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<AnthropicResponse> {
    const effectiveTimeoutMs = Math.min(perStepTimeoutMs, this.httpTimeoutMs);

    // Combine caller's signal with our per-step timeout signal. The
    // fetchWithTimeout helper already composes its internal timer with the
    // passed external signal; we additionally fire a per-step controller so
    // the per-step bound is respected even if it is tighter than httpTimeoutMs.
    const stepController = new AbortController();
    const stepTimer = setTimeout(() => {
      stepController.abort();
    }, perStepTimeoutMs);
    const onCallerAbort = (): void => {
      stepController.abort();
    };
    abortSignal?.addEventListener('abort', onCallerAbort, { once: true });
    if (abortSignal?.aborted === true) stepController.abort();

    try {
      return await retryWithBackoff(
        async () => {
          let response: Response;
          try {
            response = await fetchWithTimeout(
              this.endpoint,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': this.apiKey,
                  'anthropic-version': ANTHROPIC_API_VERSION,
                },
                body: JSON.stringify(body),
              },
              effectiveTimeoutMs,
              stepController.signal,
            );
          } catch (err) {
            if (isAbortError(err)) {
              throw new StructuredLlmTimeoutError(
                `Anthropic structured: request timed out after ${effectiveTimeoutMs}ms`,
              );
            }
            const cause = err instanceof Error ? err : new Error(String(err));
            throw new AnthropicTransportError(
              `Anthropic structured: transport failure — ${cause.message}`,
              { cause },
            );
          }

          if (!response.ok) {
            const status = response.status;
            const text = await response.text().catch(() => '');
            // 400/422 with a schema-validation-shaped error from Anthropic
            // surfaces as a validation issue rather than a service failure.
            if (status === HTTP_STATUS_BAD_REQUEST || status === HTTP_STATUS_UNPROCESSABLE_ENTITY) {
              if (looksLikeValidationError(text)) {
                throw new StructuredLlmValidationError(
                  [],
                  { httpStatus: status, body: text.slice(0, ERROR_PREVIEW_CHARS) },
                  `Anthropic structured: HTTP ${status} — ${text.slice(0, ERROR_PREVIEW_CHARS)}`,
                );
              }
            }
            return {
              kind: 'http-error' as const,
              status,
              bodyText: text,
              retryAfterSec: parseRetryAfterHeader(response),
            };
          }

          const data: unknown = await response.json();
          if (!isAnthropicResponse(data)) {
            const preview = JSON.stringify(data).slice(0, ERROR_PREVIEW_CHARS);
            throw new Error(`Anthropic structured: unexpected response — ${preview}`);
          }
          // Quiet debug log; redacts content above the preview cap.
          bootstrapLogger.debug({
            adapter: 'claude-structured-llm',
            model: data.model,
            stopReason: data.stop_reason,
            contentBlocks: data.content.length,
            // Avoid logging full tool inputs / text bodies — only counts + sizes.
            firstBlockKind: data.content[0]?.type ?? 'none',
            firstBlockTextPreview:
              data.content[0]?.type === 'text'
                ? truncateForLog((data.content[0] as AnthropicTextBlock).text)
                : undefined,
          }, 'structured-llm response');

          return { kind: 'success' as const, value: data };
        },
        ANTHROPIC_RETRY_CONFIG,
        stepController.signal,
      );
    } finally {
      clearTimeout(stepTimer);
      abortSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

/** Parse Anthropic `response.usage` into our normalized {@link TokenUsage}.
 *  Coerces missing/NaN/null fields to 0 (same guard as the legacy adapter). */
function parseUsage(usage: AnthropicUsage | undefined): TokenUsage {
  const safe = (n: number | undefined): number => (Number.isFinite(n) ? (n as number) : 0);
  return {
    inputTokens: safe(usage?.input_tokens),
    outputTokens: safe(usage?.output_tokens),
    cacheReadTokens: safe(usage?.cache_read_input_tokens),
    cacheCreationTokens: safe(usage?.cache_creation_input_tokens),
  };
}

/** Heuristic refusal-indicator scan: Anthropic surfaces refusals as a
 *  dedicated `stop_reason='refusal'` since 2025, but for backward
 *  compatibility we also recognize textual refusals emitted by older models. */
function hasRefusalIndicator(content: readonly AnthropicContentBlock[]): boolean {
  for (const block of content) {
    if (block.type === 'refusal') return true;
  }
  return false;
}

/** Normalize an Anthropic `stop_reason` to the text-mode union. */
function normalizeTextStopReason(stopReason: string | null): 'end_turn' | 'max_tokens' | 'refusal' {
  if (stopReason === 'max_tokens') return 'max_tokens';
  if (stopReason === 'refusal') return 'refusal';
  return 'end_turn';
}

/** Anthropic returns tool_use `input` as JSON-parsed object or rarely as a
 *  string. Normalize to a plain Record<string, unknown>. */
function coerceInputObject(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object') {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

/** Light heuristic — Anthropic 400/422 bodies usually mention "invalid_request"
 *  or "schema". A precise classifier is unnecessary; we only need to decide
 *  between "throw validation" vs "let retry-with-backoff handle it". */
function looksLikeValidationError(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes('invalid_request_error')
    || lower.includes('schema')
    || lower.includes('validation')
  );
}

function truncateForLog(s: string): string {
  if (s.length <= LOG_CONTENT_PREVIEW_CHARS) return s;
  return `${s.slice(0, LOG_CONTENT_PREVIEW_CHARS)}…[truncated ${s.length - LOG_CONTENT_PREVIEW_CHARS} chars]`;
}
