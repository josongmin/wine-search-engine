/**
 * OpenAI implementation of `StructuredLlmPort`.
 *
 * Built to unblock the new PtE bench (`test/benchmark/wine-search/runner.ts`)
 * when Anthropic credit is unavailable. Mirrors the public surface of
 * {@link ClaudeStructuredLlmAdapter} (`analyze` / `execute` / `synthesize`)
 * against OpenAI Chat Completions:
 *
 *   - `analyze`     →  forced single function call (`tool_choice: required`)
 *                      with the schema mapped to `function.parameters` JSON
 *                      Schema. The function name is fixed to `analyze` —
 *                      the caller's schema entirely defines the payload.
 *   - `execute`     →  multi-step tool-use loop with `tool_choice: 'auto'`.
 *                      OpenAI's `tool_calls[]` shape maps 1:1 onto
 *                      {@link ToolUseCall}; the result wraps either a
 *                      `tool_use` set or a final text turn.
 *   - `synthesize`  →  forced single function call against the synthesis
 *                      schema, mirroring `analyze` semantics.
 *
 * Error mapping matches the Anthropic adapter so call sites need no
 * special-casing (StructuredLlmValidationError / RefusalError /
 * PartialOutputError / TimeoutError).
 *
 * Re-uses:
 *   - `zodToJsonSchema` from {@link ClaudeStructuredLlmAdapter} (only
 *     module-local copy in the repo).
 *   - `fetchWithTimeout` for AbortSignal-aware HTTP.
 *   - `runUnderLlmBreaker` so transient OpenAI failures share the global
 *     breaker pool with `OpenAiChatLlm`.
 *
 * NOT covered (out of scope for the bench unblock):
 *   - Prompt caching (Anthropic-specific; no OpenAI equivalent).
 *   - The Claude adapter's elaborate retry/key-rotation pipeline — we lean
 *     on OpenAI's own retry surface plus the circuit breaker.
 */

import type { ZodTypeAny, z } from 'zod';
import {
  StructuredLlmValidationError,
  StructuredLlmRefusalError,
  StructuredLlmPartialOutputError,
  StructuredLlmTimeoutError,
  type AnalyzeRequest,
  type AnalyzeResult,
  type ExecuteRequest,
  type ExecuteResult,
  type SynthesizeRequest,
  type SynthesizeResult,
  type StructuredLlmPort,
  type ToolDefinition,
  type ToolUseCall,
  type TokenUsage,
} from '../../domain/ai/port/structured-llm.port.js';
import { fetchWithTimeout, isAbortError } from '../http/fetch-with-timeout.js';
import {
  retryWithBackoff,
  parseRetryAfterHeader,
  type RetryConfig,
} from '../http/retry-with-backoff.js';
import { runUnderLlmBreaker } from './llm-circuit-breaker-classifier.js';
import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../domain/observability/circuit-breaker-registry.js';
import { zodToJsonSchema, type JsonSchema } from './claude-structured-llm-adapter.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const OPENAI_CHAT_PATH = '/chat/completions';

const OPENAI_STRUCTURED_BREAKER_NAME = 'openai-structured';
const BREAKER_FAILURE_THRESHOLD = 5;
const BREAKER_RECOVERY_TIMEOUT_MS = 60_000;
const BREAKER_HALF_OPEN_MAX_ATTEMPTS = 3;

/** Function name used for the single forced tool in `analyze`/`synthesize`. */
const ANALYZE_FN_NAME = 'analyze';
const SYNTHESIZE_FN_NAME = 'synthesize';

/**
 * Retry policy for transient OpenAI failures. Mirrors `OPENAI_RETRY_CONFIG`
 * from openai-chat-llm.ts so the structured and chat paths share an
 * equivalent reliability envelope.
 *
 * 4 attempts × exponential backoff: a single 5xx / connection reset / 429
 * burst no longer collapses a synthesis call to Layer-4 fallback. Bench
 * impact: the #103/#104 schema-validation cluster was almost certainly a
 * transient HTTP failure surfacing as `tool arguments not valid JSON`
 * downstream (empty / malformed response wrapped in our parser).
 */
const OPENAI_STRUCTURED_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
  label: 'OpenAI structured',
};

const PREVIEW_CHARS = 240;

export interface OpenAIStructuredLlmAdapterOptions {
  readonly apiKey: string;
  /** Default model when caller doesn't pass `req.model`. */
  readonly defaultModel?: string;
  readonly httpTimeoutMs: number;
  readonly baseUrl?: string;
}

interface OpenAIChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string;
  readonly tool_calls?: ReadonlyArray<{
    readonly id: string;
    readonly type: 'function';
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly tool_call_id?: string;
}

interface OpenAIToolDef {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters: JsonSchema;
  };
}

interface OpenAIResponseChoice {
  readonly finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
  readonly message: {
    readonly role: 'assistant';
    readonly content?: string | null;
    readonly tool_calls?: ReadonlyArray<{
      readonly id: string;
      readonly type: 'function';
      readonly function: { readonly name: string; readonly arguments: string };
    }>;
    readonly refusal?: string | null;
  };
}

interface OpenAIResponse {
  readonly choices: readonly OpenAIResponseChoice[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

function extractUsage(resp: OpenAIResponse): TokenUsage {
  // OpenAI Chat Completions has no equivalent of Anthropic's prompt-cache
  // metrics, so the cache-* fields are pinned to 0. The bench scorer's token
  // aggregation is sum-based, so 0 here is identity-safe.
  return {
    inputTokens: resp.usage?.prompt_tokens ?? 0,
    outputTokens: resp.usage?.completion_tokens ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

/** Wrap a ToolDefinition for OpenAI's function-calling format. */
function mapToolDef(td: ToolDefinition): OpenAIToolDef {
  // ToolDefinition.description is required on the port surface; pass it
  // through unconditionally.
  return {
    type: 'function',
    function: {
      name: td.name,
      description: td.description,
      parameters: zodToJsonSchema(td.inputSchema),
    },
  };
}

/**
 * OpenAI's `tools` payload for a forced single-function call. The function
 * name is fixed (we own it) so the schema validation contract is unambiguous.
 */
function makeForcedFunctionTool(name: string, schema: ZodTypeAny): OpenAIToolDef {
  return {
    type: 'function',
    function: {
      name,
      parameters: zodToJsonSchema(schema),
    },
  };
}

export class OpenAIStructuredLlmAdapter implements StructuredLlmPort {
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly httpTimeoutMs: number;
  private readonly baseUrl: string;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: OpenAIStructuredLlmAdapterOptions) {
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel ?? 'gpt-4o-mini';
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.baseUrl = options.baseUrl ?? OPENAI_API_BASE;
    this.circuitBreaker = createCircuitBreaker({
      name: OPENAI_STRUCTURED_BREAKER_NAME,
      failureThreshold: BREAKER_FAILURE_THRESHOLD,
      recoveryTimeoutMs: BREAKER_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: BREAKER_HALF_OPEN_MAX_ATTEMPTS,
    });
    globalCircuitBreakerRegistry.register(OPENAI_STRUCTURED_BREAKER_NAME, this.circuitBreaker);
  }

  // -------------- public port methods --------------

  async analyze<TSchema extends ZodTypeAny>(
    req: AnalyzeRequest<TSchema>,
  ): Promise<AnalyzeResult<z.infer<TSchema>>> {
    const start = Date.now();
    const tool = makeForcedFunctionTool(ANALYZE_FN_NAME, req.schema);
    const messages: OpenAIChatMessage[] = [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.query },
    ];
    // `callOnce` translates non-OpenAI model identifiers (e.g. the
    // orchestrator's hardcoded `claude-*`) to `defaultModel`, so we pass the
    // caller's `req.model` through unchanged.
    const resp = await this.callOnce({
      model: req.model,
      messages,
      tools: [tool],
      tool_choice: { type: 'function', function: { name: ANALYZE_FN_NAME } },
      max_completion_tokens: req.maxOutputTokens,
      perStepTimeoutMs: req.perStepTimeoutMs,
      ...(req.abortSignal !== undefined ? { abortSignal: req.abortSignal } : {}),
    });
    const choice = resp.choices[0];
    if (choice === undefined) {
      throw new StructuredLlmValidationError([], resp, 'openai analyze: no choice in response');
    }
    if (choice.message.refusal !== null && choice.message.refusal !== undefined && choice.message.refusal.length > 0) {
      throw new StructuredLlmRefusalError(`openai analyze refused: ${choice.message.refusal.slice(0, PREVIEW_CHARS)}`);
    }
    if (choice.finish_reason === 'length') {
      throw new StructuredLlmPartialOutputError(resp, 'openai analyze: max_completion_tokens before tool_use complete');
    }
    const toolCall = choice.message.tool_calls?.[0];
    if (toolCall === undefined) {
      throw new StructuredLlmValidationError([], resp, `openai analyze: no tool_call returned (finish=${choice.finish_reason})`);
    }
    const parsed = this.parseAndValidate(req.schema, toolCall.function.arguments, resp);
    return {
      data: parsed,
      usage: extractUsage(resp),
      durationMs: Date.now() - start,
    };
  }

  async execute(req: ExecuteRequest): Promise<ExecuteResult> {
    const start = Date.now();
    const messages = this.toOpenAIMessages(req.messages, req.systemPrompt);
    const resp = await this.callOnce({
      model: req.model,
      messages,
      tools: req.tools.map(mapToolDef),
      tool_choice: req.toolChoice === undefined
        ? 'auto'
        : this.mapToolChoice(req.toolChoice),
      max_completion_tokens: req.maxOutputTokens,
      perStepTimeoutMs: req.perStepTimeoutMs,
      ...(req.abortSignal !== undefined ? { abortSignal: req.abortSignal } : {}),
    });
    const choice = resp.choices[0];
    if (choice === undefined) {
      throw new StructuredLlmValidationError([], resp, 'openai execute: empty choice');
    }
    if (choice.message.refusal !== null && choice.message.refusal !== undefined && choice.message.refusal.length > 0) {
      return {
        kind: 'text',
        text: choice.message.refusal,
        usage: extractUsage(resp),
        durationMs: Date.now() - start,
        stopReason: 'refusal',
      };
    }
    if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls !== undefined && choice.message.tool_calls.length > 0) {
      const calls: ToolUseCall[] = choice.message.tool_calls.map((tc) => {
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(tc.function.arguments) as unknown;
          if (typeof parsed === 'object' && parsed !== null) input = parsed as Record<string, unknown>;
        } catch (err) {
          // Best-effort. Caller validates with the tool's inputSchema.
          void err; /* intentional: malformed JSON falls through to schema validation downstream */
        }
        return { id: tc.id, name: tc.function.name, input };
      });
      return {
        kind: 'tool_use',
        calls,
        usage: extractUsage(resp),
        durationMs: Date.now() - start,
        stopReason: 'tool_use',
      };
    }
    const text = choice.message.content ?? '';
    const stopReason: 'end_turn' | 'max_tokens' | 'refusal' =
      choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
    return {
      kind: 'text',
      text,
      usage: extractUsage(resp),
      durationMs: Date.now() - start,
      stopReason,
    };
  }

  async synthesize<TSchema extends ZodTypeAny>(
    req: SynthesizeRequest<TSchema>,
  ): Promise<SynthesizeResult<z.infer<TSchema>>> {
    const start = Date.now();
    const tool = makeForcedFunctionTool(SYNTHESIZE_FN_NAME, req.schema);
    const messages = this.toOpenAIMessages(req.messages, req.systemPrompt);
    const resp = await this.callOnce({
      model: req.model,
      messages,
      tools: [tool],
      tool_choice: { type: 'function', function: { name: SYNTHESIZE_FN_NAME } },
      max_completion_tokens: req.maxOutputTokens,
      perStepTimeoutMs: req.perStepTimeoutMs,
      ...(req.abortSignal !== undefined ? { abortSignal: req.abortSignal } : {}),
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
    });
    const choice = resp.choices[0];
    if (choice === undefined) {
      throw new StructuredLlmValidationError([], resp, 'openai synthesize: no choice');
    }
    if (choice.message.refusal !== null && choice.message.refusal !== undefined && choice.message.refusal.length > 0) {
      throw new StructuredLlmRefusalError(`openai synthesize refused: ${choice.message.refusal.slice(0, PREVIEW_CHARS)}`);
    }
    if (choice.finish_reason === 'length') {
      throw new StructuredLlmPartialOutputError(resp, 'openai synthesize: max_completion_tokens before tool_use complete');
    }
    const toolCall = choice.message.tool_calls?.[0];
    if (toolCall === undefined) {
      throw new StructuredLlmValidationError([], resp, `openai synthesize: no tool_call (finish=${choice.finish_reason})`);
    }
    const parsed = this.parseAndValidate(req.schema, toolCall.function.arguments, resp);
    return {
      data: parsed,
      usage: extractUsage(resp),
      durationMs: Date.now() - start,
    };
  }

  // -------------- helpers --------------

  private parseAndValidate<TSchema extends ZodTypeAny>(
    schema: TSchema,
    rawArguments: string,
    rawResp: unknown,
  ): z.infer<TSchema> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawArguments);
    } catch (e) {
      throw new StructuredLlmValidationError(
        [],
        rawResp,
        `openai: tool arguments not valid JSON: ${(e as Error).message}`,
      );
    }
    const result = schema.safeParse(parsedJson);
    if (!result.success) {
      throw new StructuredLlmValidationError(result.error.issues, parsedJson);
    }
    // Cast through `unknown` so the generic inference for z.infer<TSchema>
    // doesn't widen to `any` (CLAUDE.md schema-quality bar: no direct
    // `as DomainType` on external data — but this came from `safeParse`
    // which already validated against TSchema).
    return result.data as z.infer<TSchema>;
  }

  private mapToolChoice(tc: ExecuteRequest['toolChoice']): 'auto' | 'none' | 'required' | { readonly type: 'function'; readonly function: { readonly name: string } } {
    if (tc === undefined || tc === 'auto') return 'auto';
    if (tc === 'any') return 'required';
    // The remaining branch in `ToolChoice` is `{ type: 'tool'; name: string }`.
    // After narrowing out the string variants above, the object form's
    // discriminant is fixed — pull `name` directly.
    return { type: 'function', function: { name: tc.name } };
  }

  private toOpenAIMessages(
    messages: readonly { readonly role: string; readonly content: unknown }[],
    systemPrompt: string,
  ): OpenAIChatMessage[] {
    const out: OpenAIChatMessage[] = [{ role: 'system', content: systemPrompt }];
    for (const m of messages) {
      const role = m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'system'
        ? m.role
        : 'user';
      const content = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
      out.push({ role, content });
    }
    return out;
  }

  private async callOnce(payload: {
    readonly model: string;
    readonly messages: readonly OpenAIChatMessage[];
    readonly tools: readonly OpenAIToolDef[];
    readonly tool_choice: 'auto' | 'none' | 'required' | { readonly type: 'function'; readonly function: { readonly name: string } };
    readonly max_completion_tokens: number;
    readonly perStepTimeoutMs: number;
    readonly seed?: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<OpenAIResponse> {
    const body = {
      // Caller passes models the orchestrator hardcoded for the Anthropic
      // adapter (e.g. `claude-sonnet-4-6`). We translate any non-OpenAI model
      // identifier to `defaultModel` so the OpenAI route accepts the call.
      // This is the bench-unblock seam — production keeps using Anthropic.
      model: payload.model.startsWith('claude-') || payload.model.startsWith('o1') || payload.model.length === 0
        ? this.defaultModel
        : payload.model,
      messages: payload.messages,
      tools: payload.tools,
      tool_choice: payload.tool_choice,
      max_completion_tokens: payload.max_completion_tokens,
      ...(payload.seed !== undefined ? { seed: payload.seed } : {}),
    };
    const url = `${this.baseUrl}${OPENAI_CHAT_PATH}`;
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    };
    const timeoutMs = Math.min(this.httpTimeoutMs, payload.perStepTimeoutMs);
    try {
      // Retry-with-backoff sits OUTSIDE the breaker so the breaker counts
      // *bursts* of transient failures (after exhausting retries), not each
      // individual retry attempt. Mirrors openai-chat-llm.ts placement.
      const json = await runUnderLlmBreaker(
        this.circuitBreaker,
        OPENAI_STRUCTURED_BREAKER_NAME,
        async () => {
          return await retryWithBackoff<OpenAIResponse>(
            async (_attempt) => {
              const httpRes = payload.abortSignal !== undefined
                ? await fetchWithTimeout(url, init, timeoutMs, payload.abortSignal)
                : await fetchWithTimeout(url, init, timeoutMs);
              if (!httpRes.ok) {
                const text = await httpRes.text().catch(() => '<no body>');
                const retryAfterSec = parseRetryAfterHeader(httpRes);
                return {
                  kind: 'http-error',
                  status: httpRes.status,
                  bodyText: text.slice(0, PREVIEW_CHARS),
                  retryAfterSec,
                };
              }
              const parsed = await httpRes.json() as OpenAIResponse;
              return { kind: 'success', value: parsed };
            },
            OPENAI_STRUCTURED_RETRY_CONFIG,
            payload.abortSignal,
          );
        },
      );
      return json;
    } catch (err) {
      if (isAbortError(err)) {
        throw new StructuredLlmTimeoutError('openai-structured: timed out');
      }
      throw err;
    }
  }
}
