/**
 * Tests for {@link ClaudeStructuredLlmAdapter}.
 *
 * Mocking strategy mirrors `anthropic-chat-llm.test.ts`: stub the global
 * `fetch` so we can return canned Anthropic Messages API responses. The
 * adapter delegates through `fetchWithTimeout` → global fetch.
 *
 * No Anthropic SDK is imported — the adapter speaks the wire protocol
 * directly, so mocking the network is sufficient end-to-end coverage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  StructuredLlmCircuitOpenError,
  StructuredLlmPartialOutputError,
  StructuredLlmRefusalError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
} from '../../../domain/ai/port/structured-llm.port.js';
import { ClaudeStructuredLlmAdapter } from '../claude-structured-llm-adapter.js';
import { globalCircuitBreakerRegistry } from '../../../domain/observability/circuit-breaker-registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_MAX_OUTPUT_TOKENS = 256;
const DEFAULT_PER_STEP_TIMEOUT_MS = 60_000;
const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const TEST_MODEL = 'claude-test-4';

function adapter(): ClaudeStructuredLlmAdapter {
  return new ClaudeStructuredLlmAdapter({
    apiKey: 'sk-ant-test',
    defaultModel: TEST_MODEL,
    httpTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
  });
}

interface ToolUseResponseBody {
  readonly id?: string;
  readonly model?: string;
  readonly stop_reason?: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
  readonly usage?: Record<string, unknown>;
  readonly extraContent?: readonly unknown[];
}

function toolUseBody(opts: ToolUseResponseBody): string {
  const toolName = opts.toolName ?? 'respond';
  const content: unknown[] = [
    {
      type: 'tool_use',
      id: 'toolu_test',
      name: toolName,
      input: opts.toolInput ?? {},
    },
  ];
  if (opts.extraContent !== undefined) content.push(...opts.extraContent);
  return JSON.stringify({
    id: opts.id ?? 'msg_test',
    model: opts.model ?? TEST_MODEL,
    stop_reason: opts.stop_reason ?? 'tool_use',
    content,
    usage: opts.usage,
  });
}

function textBody(opts: {
  readonly text?: string;
  readonly stop_reason?: string;
  readonly usage?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: 'msg_test',
    model: TEST_MODEL,
    stop_reason: opts.stop_reason ?? 'end_turn',
    content: [{ type: 'text', text: opts.text ?? 'ok' }],
    usage: opts.usage,
  });
}

interface CapturedFetchCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly parsedBody: Record<string, unknown>;
}

function captureFetch(
  responder: (call: CapturedFetchCall) => Response | Promise<Response>,
): { readonly calls: CapturedFetchCall[]; readonly fn: ReturnType<typeof vi.fn> } {
  const calls: CapturedFetchCall[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const bodyText = typeof init.body === 'string' ? init.body : '';
    const parsedBody = bodyText.length > 0
      ? (JSON.parse(bodyText) as Record<string, unknown>)
      : {};
    const call: CapturedFetchCall = { url, init, parsedBody };
    calls.push(call);
    return await responder(call);
  });
  return { calls, fn };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClaudeStructuredLlmAdapter', () => {
  beforeEach(() => {
    globalCircuitBreakerRegistry.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalCircuitBreakerRegistry.clear();
  });

  // ---------------------- analyze() ----------------------

  describe('analyze', () => {
    it('parses and validates the forced tool_use input', async () => {
      const schema = z.object({
        intent: z.enum(['recommend', 'lookup']),
        count: z.number().int().min(1).max(10),
      });
      const { fn } = captureFetch(() =>
        new Response(
          toolUseBody({
            toolInput: { intent: 'recommend', count: 5 },
            usage: { input_tokens: 12, output_tokens: 34 },
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fn);

      const result = await adapter().analyze({
        query: 'Recommend something fruity',
        schema,
        systemPrompt: 'You are a wine assistant.',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });

      expect(result.data).toEqual({ intent: 'recommend', count: 5 });
      expect(result.usage.inputTokens).toBe(12);
      expect(result.usage.outputTokens).toBe(34);
      expect(result.usage.cacheReadTokens).toBe(0);
      expect(result.usage.cacheCreationTokens).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws StructuredLlmValidationError when tool input fails Zod', async () => {
      const schema = z.object({ count: z.number().int() });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            toolUseBody({ toolInput: { count: 'five' } }),
            { status: 200 },
          ),
        ),
      );

      let caught: unknown = null;
      try {
        await adapter().analyze({
          query: 'q',
          schema,
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
          model: TEST_MODEL,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StructuredLlmValidationError);
      const valErr = caught as StructuredLlmValidationError;
      expect(valErr.issues.length).toBeGreaterThan(0);
      expect(valErr.rawOutput).toEqual({ count: 'five' });
      expect(valErr.name).toBe('StructuredLlmValidationError');
    });

    it('throws StructuredLlmRefusalError on stop_reason=refusal', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            toolUseBody({ stop_reason: 'refusal' }),
            { status: 200 },
          ),
        ),
      );
      await expect(
        adapter().analyze({
          query: 'q',
          schema: z.object({ x: z.number() }),
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
          model: TEST_MODEL,
        }),
      ).rejects.toBeInstanceOf(StructuredLlmRefusalError);
    });

    it('throws StructuredLlmPartialOutputError when max_tokens + no tool_use', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              id: 'msg_test',
              model: TEST_MODEL,
              stop_reason: 'max_tokens',
              content: [{ type: 'text', text: 'partial...' }],
            }),
            { status: 200 },
          ),
        ),
      );
      await expect(
        adapter().analyze({
          query: 'q',
          schema: z.object({ x: z.number() }),
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
          model: TEST_MODEL,
        }),
      ).rejects.toBeInstanceOf(StructuredLlmPartialOutputError);
    });

    it('throws StructuredLlmPartialOutputError when max_tokens + unparseable tool input', async () => {
      // Tool was emitted but truncated → input doesn't match schema. The
      // adapter prefers PartialOutput over Validation when stop_reason is
      // max_tokens so callers can retry with a bigger budget.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            toolUseBody({
              stop_reason: 'max_tokens',
              toolInput: { /* missing required `x` */ },
            }),
            { status: 200 },
          ),
        ),
      );
      await expect(
        adapter().analyze({
          query: 'q',
          schema: z.object({ x: z.number() }),
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
          model: TEST_MODEL,
        }),
      ).rejects.toBeInstanceOf(StructuredLlmPartialOutputError);
    });

    it('throws StructuredLlmTimeoutError when caller aborts mid-flight', async () => {
      const controller = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
          }),
        ),
      );

      const promise = adapter().analyze({
        query: 'q',
        schema: z.object({ x: z.number() }),
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
        abortSignal: controller.signal,
      });
      // Give the request loop a tick to register the abort listener.
      await Promise.resolve();
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(StructuredLlmTimeoutError);
    });

    it('throws StructuredLlmTimeoutError when perStepTimeoutMs fires', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true },
            );
          }),
        ),
      );

      const PER_STEP_TIMEOUT_TINY_MS = 25;
      const a = adapter();
      await expect(
        a.analyze({
          query: 'q',
          schema: z.object({ x: z.number() }),
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: PER_STEP_TIMEOUT_TINY_MS,
          model: TEST_MODEL,
        }),
      ).rejects.toBeInstanceOf(StructuredLlmTimeoutError);
    });

    it('attaches cache_control on system + tools when enablePromptCache=true and reports cache tokens', async () => {
      const { calls, fn } = captureFetch(() =>
        new Response(
          toolUseBody({
            toolInput: { x: 1 },
            usage: {
              input_tokens: 5,
              output_tokens: 2,
              cache_read_input_tokens: 800,
              cache_creation_input_tokens: 100,
            },
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fn);
      const result = await adapter().analyze({
        query: 'q',
        schema: z.object({ x: z.number() }),
        systemPrompt: 'sys',
        enablePromptCache: true,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });

      expect(calls.length).toBe(1);
      const body = calls[0]?.parsedBody;
      expect(body).toBeDefined();
      // system is an array with cache_control marker
      const systemArr = body!['system'] as Array<Record<string, unknown>>;
      expect(systemArr).toHaveLength(1);
      expect(systemArr[0]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      });
      // tools last entry carries cache_control
      const tools = body!['tools'] as Array<Record<string, unknown>>;
      expect(tools.length).toBeGreaterThan(0);
      const lastTool = tools[tools.length - 1];
      expect(lastTool).toMatchObject({ cache_control: { type: 'ephemeral' } });
      // tool_choice forces the respond tool
      expect(body!['tool_choice']).toEqual({ type: 'tool', name: 'respond' });
      // Cache token accounting reported
      expect(result.usage.cacheReadTokens).toBe(800);
      expect(result.usage.cacheCreationTokens).toBe(100);
      expect(result.usage.inputTokens).toBe(5);
      expect(result.usage.outputTokens).toBe(2);
    });

    it('omits cache_control markers when enablePromptCache is false', async () => {
      const { calls, fn } = captureFetch(() =>
        new Response(toolUseBody({ toolInput: { x: 1 } }), { status: 200 }),
      );
      vi.stubGlobal('fetch', fn);
      await adapter().analyze({
        query: 'q',
        schema: z.object({ x: z.number() }),
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      const body = calls[0]?.parsedBody;
      const systemArr = body!['system'] as Array<Record<string, unknown>>;
      expect(systemArr[0]).not.toHaveProperty('cache_control');
      const tools = body!['tools'] as Array<Record<string, unknown>>;
      expect(tools[tools.length - 1]).not.toHaveProperty('cache_control');
    });

    it('passes a Korean query through unchanged (preservedSurface contract)', async () => {
      const KOREAN_QUERY = '부르고뉴 피노누아 추천';
      const { calls, fn } = captureFetch(() =>
        new Response(toolUseBody({ toolInput: { ok: true } }), { status: 200 }),
      );
      vi.stubGlobal('fetch', fn);
      await adapter().analyze({
        query: KOREAN_QUERY,
        schema: z.object({ ok: z.boolean() }),
        systemPrompt: '한국어 응답',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });

      const body = calls[0]?.parsedBody;
      const messages = body!['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(1);
      const firstMsg = messages[0];
      expect(firstMsg!['role']).toBe('user');
      expect(firstMsg!['content']).toBe(KOREAN_QUERY);
    });

    it('coerces missing usage fields to 0 (NaN guard)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            toolUseBody({
              toolInput: { x: 1 },
              usage: {
                input_tokens: null,
                output_tokens: null,
                cache_read_input_tokens: null,
                cache_creation_input_tokens: null,
              },
            }),
            { status: 200 },
          ),
        ),
      );
      const result = await adapter().analyze({
        query: 'q',
        schema: z.object({ x: z.number() }),
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
      expect(result.usage.cacheReadTokens).toBe(0);
      expect(result.usage.cacheCreationTokens).toBe(0);
    });
  });

  // ---------------------- execute() ----------------------

  describe('execute', () => {
    it('returns tool_use calls when stop_reason=tool_use', async () => {
      const { fn } = captureFetch(() =>
        new Response(
          JSON.stringify({
            id: 'msg_test',
            model: TEST_MODEL,
            stop_reason: 'tool_use',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'search_wines',
                input: { region: 'Burgundy', vintage: 2018 },
              },
            ],
            usage: { input_tokens: 7, output_tokens: 11 },
          }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fn);

      const result = await adapter().execute({
        messages: [{ role: 'user', content: 'find me wines' }],
        tools: [
          {
            name: 'search_wines',
            description: 'Search the wine catalog',
            inputSchema: z.object({
              region: z.string(),
              vintage: z.number().int(),
            }),
          },
        ],
        systemPrompt: 'You are a wine assistant.',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });

      expect(result.kind).toBe('tool_use');
      if (result.kind !== 'tool_use') throw new Error('typeguard');
      expect(result.calls).toHaveLength(1);
      expect(result.calls[0]?.name).toBe('search_wines');
      expect(result.calls[0]?.input).toEqual({ region: 'Burgundy', vintage: 2018 });
      expect(result.stopReason).toBe('tool_use');
      expect(result.usage.inputTokens).toBe(7);
    });

    it('returns text result on end_turn', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(textBody({ text: 'final answer' }), { status: 200 })),
      );
      const result = await adapter().execute({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      expect(result.kind).toBe('text');
      if (result.kind !== 'text') throw new Error('typeguard');
      expect(result.text).toBe('final answer');
      expect(result.stopReason).toBe('end_turn');
    });

    it('returns text result with stopReason=max_tokens on truncation', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(textBody({ text: 'partial', stop_reason: 'max_tokens' }), { status: 200 })),
      );
      const result = await adapter().execute({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      expect(result.kind).toBe('text');
      if (result.kind !== 'text') throw new Error('typeguard');
      expect(result.stopReason).toBe('max_tokens');
    });

    it('honors toolChoice override', async () => {
      const { calls, fn } = captureFetch(() =>
        new Response(textBody({ text: 'ok' }), { status: 200 }),
      );
      vi.stubGlobal('fetch', fn);
      await adapter().execute({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'pick',
            description: 'd',
            inputSchema: z.object({ k: z.string() }),
          },
        ],
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
        toolChoice: { type: 'tool', name: 'pick' },
      });
      const body = calls[0]?.parsedBody;
      expect(body!['tool_choice']).toEqual({ type: 'tool', name: 'pick' });
    });

    it('defaults toolChoice to auto', async () => {
      const { calls, fn } = captureFetch(() =>
        new Response(textBody({ text: 'ok' }), { status: 200 }),
      );
      vi.stubGlobal('fetch', fn);
      await adapter().execute({
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      const body = calls[0]?.parsedBody;
      expect(body!['tool_choice']).toEqual({ type: 'auto' });
    });
  });

  // ---------------------- synthesize() ----------------------

  describe('synthesize', () => {
    it('forces the respond tool and validates output', async () => {
      const schema = z.object({ summary: z.string() });
      const { calls, fn } = captureFetch(() =>
        new Response(
          toolUseBody({ toolInput: { summary: 'A crisp Sancerre.' } }),
          { status: 200 },
        ),
      );
      vi.stubGlobal('fetch', fn);

      const result = await adapter().synthesize({
        messages: [
          { role: 'user', content: 'Find me white wine' },
          { role: 'assistant', content: 'Searching...' },
        ],
        schema,
        systemPrompt: 'You synthesize answers.',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });

      expect(result.data).toEqual({ summary: 'A crisp Sancerre.' });
      const body = calls[0]?.parsedBody;
      expect(body!['tool_choice']).toEqual({ type: 'tool', name: 'respond' });
      const messages = body!['messages'] as Array<Record<string, unknown>>;
      expect(messages).toHaveLength(2);
      expect(messages[0]?.['role']).toBe('user');
      expect(messages[1]?.['role']).toBe('assistant');
    });
  });

  // ---------------------- circuit breaker ----------------------

  describe('circuit breaker', () => {
    it('translates CircuitBreakerOpenError to StructuredLlmCircuitOpenError', async () => {
      const a = adapter();
      // Trigger 5 consecutive service-failure errors. We throw a non-transient
      // network-style error so retryWithBackoff exits on the first attempt
      // (not retried, not classified as caller-fault). This trips the breaker
      // after the configured threshold (5) and the next call fast-fails.
      const FAILURE_BURST = 5;
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          // Throw an error with no recognized transient code → retryWithBackoff
          // skips retry, runUnderLlmBreaker classifies as service-failure (no HTTP status).
          return Promise.reject(new Error('connection broken'));
        }),
      );
      for (let i = 0; i < FAILURE_BURST; i++) {
        await expect(
          a.execute({
            messages: [{ role: 'user', content: 'hi' }],
            tools: [],
            systemPrompt: 'sys',
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
            perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
            model: TEST_MODEL,
          }),
        ).rejects.toThrow();
      }
      // Next call should fast-fail with circuit-open mapped error.
      await expect(
        a.execute({
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
          model: TEST_MODEL,
        }),
      ).rejects.toBeInstanceOf(StructuredLlmCircuitOpenError);
    });
  });
});
