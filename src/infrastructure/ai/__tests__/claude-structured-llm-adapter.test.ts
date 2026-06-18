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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  StructuredLlmCircuitOpenError,
  StructuredLlmPartialOutputError,
  StructuredLlmProviderError,
  StructuredLlmRefusalError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
} from '../../../domain/ai/port/structured-llm.port.js';
import {
  ClaudeStructuredLlmAdapter,
  __testOnly,
} from '../claude-structured-llm-adapter.js';
import { globalCircuitBreakerRegistry } from '../../../domain/observability/circuit-breaker-registry.js';

const { zodToJsonSchema, parseUsage } = __testOnly;

// Resolve fixtures directory relative to this test file (ESM-safe).
const FIXTURES_DIR = join(
  fileURLToPath(new URL('./fixtures/anthropic-responses/', import.meta.url)),
);

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

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
                name: 'search_hybrid',
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
            name: 'search_hybrid',
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
      expect(result.calls[0]?.name).toBe('search_hybrid');
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

  // ---------------------- fixture-based integration ----------------------

  describe('fixtures (real Anthropic response shapes)', () => {
    it('tool-use-single.json → parses input, reports usage', async () => {
      const body = readFixture('tool-use-single.json');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      const result = await adapter().analyze({
        query: 'q',
        schema: z.object({
          intent: z.enum(['recommend', 'lookup']),
          count: z.number().int(),
          regionPreference: z.string().optional(),
        }),
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      expect(result.data.intent).toBe('recommend');
      expect(result.data.count).toBe(5);
      expect(result.usage.inputTokens).toBe(1342);
      expect(result.usage.outputTokens).toBe(87);
      expect(result.usage.cacheReadTokens).toBe(0);
      expect(result.usage.cacheCreationTokens).toBe(0);
    });

    it('tool-use-parallel.json → execute() surfaces both calls', async () => {
      const body = readFixture('tool-use-parallel.json');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      const result = await adapter().execute({
        messages: [{ role: 'user', content: 'find me wines' }],
        tools: [
          {
            name: 'search_hybrid',
            description: 'd',
            inputSchema: z.object({
              region: z.string(),
              vintage: z.number().int(),
            }),
          },
        ],
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
        toolChoice: 'any',
      });
      expect(result.kind).toBe('tool_use');
      if (result.kind !== 'tool_use') throw new Error('typeguard');
      expect(result.calls).toHaveLength(2);
      expect(result.calls[0]?.input).toEqual({ region: 'Burgundy', vintage: 2018 });
      expect(result.calls[1]?.input).toEqual({ region: 'Loire', vintage: 2020 });
    });

    it('tool-use-truncated.json → PartialOutput on max_tokens+schema-miss', async () => {
      const body = readFixture('tool-use-truncated.json');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      // Schema demands `count` which the truncated input omits.
      await expect(
        adapter().analyze({
          query: 'q',
          schema: z.object({ intent: z.string(), count: z.number().int() }),
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
          model: TEST_MODEL,
        }),
      ).rejects.toBeInstanceOf(StructuredLlmPartialOutputError);
    });

    it('text-end-turn.json → execute() returns text kind', async () => {
      const body = readFixture('text-end-turn.json');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      const result = await adapter().execute({
        messages: [{ role: 'user', content: 'tell me about Sancerre' }],
        tools: [],
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      expect(result.kind).toBe('text');
      if (result.kind !== 'text') throw new Error('typeguard');
      expect(result.stopReason).toBe('end_turn');
      expect(result.text).toContain('Sancerre');
    });

    it('refusal.json → RefusalError', async () => {
      const body = readFixture('refusal.json');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
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

    it('cache-hit.json → all four usage fields propagate', async () => {
      const body = readFixture('cache-hit.json');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      const result = await adapter().analyze({
        query: 'q',
        schema: z.object({ intent: z.string(), count: z.number().int() }),
        systemPrompt: 'sys',
        enablePromptCache: true,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      expect(result.usage.inputTokens).toBe(42);
      expect(result.usage.outputTokens).toBe(11);
      expect(result.usage.cacheReadTokens).toBe(1287);
      expect(result.usage.cacheCreationTokens).toBe(0);
    });

    it('mixed-content.json → tool_use block extracted; text block ignored', async () => {
      const body = readFixture('mixed-content.json');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      const result = await adapter().analyze({
        query: 'q',
        schema: z.object({ intent: z.string(), count: z.number().int() }),
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      expect(result.data).toEqual({ intent: 'recommend', count: 3 });
    });

    it('wrong-tool-name.json → ValidationError (model emitted unexpected tool)', async () => {
      const body = readFixture('wrong-tool-name.json');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      let caught: unknown = null;
      try {
        await adapter().analyze({
          query: 'q',
          schema: z.object({ x: z.number() }),
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
      expect(valErr.message).toContain('search_database');
    });
  });

  // ---------------------- Anthropic edge cases ----------------------

  describe('response edge cases', () => {
    it('extra fields in tool input pass through (CLAUDE.md rule 10 — no .strict)', async () => {
      // LLMs frequently emit reasoning/confidence fields not in our schema.
      // Without .strict(), Zod ignores them — the caller schema controls.
      const schema = z.object({ intent: z.string() });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            toolUseBody({
              toolInput: {
                intent: 'recommend',
                reasoning: 'The user asked for fruity options',
                confidence: 0.93,
                extraGarbage: { nested: true },
              },
            }),
            { status: 200 },
          ),
        ),
      );
      const result = await adapter().analyze({
        query: 'q',
        schema,
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      expect(result.data).toEqual({ intent: 'recommend' });
    });

    it('empty content array → PartialOutputError', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              id: 'msg_test',
              model: TEST_MODEL,
              stop_reason: 'end_turn',
              content: [],
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

    it('malformed JSON body (200 OK) → adapter does NOT 500', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('not-json-at-all{{{', { status: 200 })),
      );
      // Should surface as a real error (not silent success), but not crash.
      await expect(
        adapter().analyze({
          query: 'q',
          schema: z.object({ x: z.number() }),
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
          model: TEST_MODEL,
        }),
      ).rejects.toThrow(/malformed JSON|unexpected response/i);
    });

    it('unexpected response shape (missing id/content) → typed error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ unrelated: true }), { status: 200 }),
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
      ).rejects.toThrow(/unexpected response/i);
    });

    it('execute() handles parallel tool_use blocks (multiple distinct calls)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              id: 'msg_test',
              model: TEST_MODEL,
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: 'a', name: 'tool_a', input: { p: 1 } },
                { type: 'tool_use', id: 'b', name: 'tool_b', input: { p: 2 } },
                { type: 'tool_use', id: 'c', name: 'tool_a', input: { p: 3 } },
              ],
              usage: { input_tokens: 5, output_tokens: 5 },
            }),
            { status: 200 },
          ),
        ),
      );
      const result = await adapter().execute({
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          { name: 'tool_a', description: 'd', inputSchema: z.object({ p: z.number() }) },
          { name: 'tool_b', description: 'd', inputSchema: z.object({ p: z.number() }) },
        ],
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
        toolChoice: 'any',
      });
      expect(result.kind).toBe('tool_use');
      if (result.kind !== 'tool_use') throw new Error('typeguard');
      expect(result.calls).toHaveLength(3);
      expect(result.calls.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    });

    it('tool input not an object (rare) → coerced to {value: ...}', async () => {
      // Anthropic input is typed `object` in spec but defensive — if a model
      // ever emits a literal string the helper should normalize it.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              id: 'msg_test',
              model: TEST_MODEL,
              stop_reason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: 'x',
                  name: 'tool_a',
                  input: 'plain-string',
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200 },
          ),
        ),
      );
      const result = await adapter().execute({
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'tool_a', description: 'd', inputSchema: z.object({}) }],
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
      if (result.kind !== 'tool_use') throw new Error('typeguard');
      expect(result.calls[0]?.input).toEqual({ value: 'plain-string' });
    });
  });

  // ---------------------- Zod → JSON Schema converter ----------------------

  describe('zodToJsonSchema converter', () => {
    it('z.string() with .min/.max/.regex/.email emits constraints', () => {
      const s = z.string().min(3).max(20).regex(/^[a-z]+$/);
      const out = zodToJsonSchema(s);
      expect(out).toMatchObject({
        type: 'string',
        minLength: 3,
        maxLength: 20,
        pattern: '^[a-z]+$',
      });

      const email = z.string().email();
      expect(zodToJsonSchema(email)).toMatchObject({ type: 'string', format: 'email' });

      const url = z.string().url();
      expect(zodToJsonSchema(url)).toMatchObject({ type: 'string', format: 'uri' });

      const uuid = z.string().uuid();
      expect(zodToJsonSchema(uuid)).toMatchObject({ type: 'string', format: 'uuid' });
    });

    it('z.number().int().multipleOf().min().max() emits constraints', () => {
      const n = z.number().int().multipleOf(2).min(0).max(100);
      const out = zodToJsonSchema(n);
      expect(out).toMatchObject({
        type: 'integer',
        multipleOf: 2,
        minimum: 0,
        maximum: 100,
      });
    });

    it('z.union([a, b]) → anyOf', () => {
      const u = z.union([z.string(), z.number()]);
      const out = zodToJsonSchema(u);
      expect(out['anyOf']).toEqual([{ type: 'string' }, { type: 'number' }]);
    });

    it('z.discriminatedUnion(kind, [...]) → oneOf with x-discriminator', () => {
      const du = z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), payload: z.string() }),
        z.object({ kind: z.literal('b'), payload: z.number() }),
      ]);
      const out = zodToJsonSchema(du);
      expect(Array.isArray(out['oneOf'])).toBe(true);
      const variants = out['oneOf'] as Array<Record<string, unknown>>;
      expect(variants).toHaveLength(2);
      expect((variants[0]?.['properties'] as Record<string, unknown>)?.['kind'])
        .toMatchObject({ const: 'a' });
      expect(out['x-discriminator']).toBe('kind');
    });

    it('z.intersection(a, b) → allOf', () => {
      const inter = z.intersection(
        z.object({ a: z.string() }),
        z.object({ b: z.number() }),
      );
      const out = zodToJsonSchema(inter);
      expect(Array.isArray(out['allOf'])).toBe(true);
      const branches = out['allOf'] as Array<Record<string, unknown>>;
      expect(branches).toHaveLength(2);
    });

    it('z.tuple([a, b, c]) → array with prefixItems and exact bounds', () => {
      const tup = z.tuple([z.string(), z.number(), z.boolean()]);
      const out = zodToJsonSchema(tup);
      expect(out).toMatchObject({
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: false,
      });
      const pref = out['prefixItems'] as Array<Record<string, unknown>>;
      expect(pref).toHaveLength(3);
      expect(pref[0]?.['type']).toBe('string');
      expect(pref[1]?.['type']).toBe('number');
      expect(pref[2]?.['type']).toBe('boolean');
    });

    it('z.tuple([a, b]).rest(c) → variadic tuple (items from rest)', () => {
      const tup = z.tuple([z.string(), z.number()]).rest(z.boolean());
      const out = zodToJsonSchema(tup);
      expect(out['minItems']).toBe(2);
      expect(out['maxItems']).toBeUndefined();
      expect(out['items']).toEqual({ type: 'boolean' });
    });

    it('z.lazy(() => inner) unwraps once to inner schema', () => {
      const lazy = z.lazy(() => z.object({ name: z.string() }));
      const out = zodToJsonSchema(lazy);
      expect(out['type']).toBe('object');
      expect((out['properties'] as Record<string, unknown>)['name'])
        .toMatchObject({ type: 'string' });
    });

    it('z.coerce.string() behaves like z.string() (coercion is JS-side only)', () => {
      const c = z.coerce.string().min(1);
      const out = zodToJsonSchema(c);
      expect(out).toMatchObject({ type: 'string', minLength: 1 });
    });

    it('z.array().nonempty() → minItems: 1', () => {
      const a = z.array(z.string()).nonempty();
      const out = zodToJsonSchema(a);
      expect(out).toMatchObject({ type: 'array', minItems: 1 });
    });

    it('z.array().min(2).max(5) → minItems / maxItems', () => {
      const a = z.array(z.string()).min(2).max(5);
      const out = zodToJsonSchema(a);
      expect(out).toMatchObject({ type: 'array', minItems: 2, maxItems: 5 });
    });

    it('z.record(z.string(), z.number()) → object additionalProperties: number', () => {
      const r = z.record(z.string(), z.number());
      const out = zodToJsonSchema(r);
      expect(out).toMatchObject({
        type: 'object',
        additionalProperties: { type: 'number' },
      });
    });

    it('z.nativeEnum dedupes numeric-enum reverse-mapped keys', () => {
      const NumE = { Low: 0, High: 1 } as const;
      // Simulate TS numeric enum reverse map: {0: 'Low', 1: 'High', Low: 0, High: 1}
      const NumericEnum: Record<string, string | number> = {
        ...NumE,
        0: 'Low',
        1: 'High',
      };
      const out = zodToJsonSchema(z.nativeEnum(NumericEnum));
      const enumValues = out['enum'] as Array<string | number>;
      // Dedupe yields the union of unique values in insertion order.
      expect(new Set(enumValues)).toEqual(new Set([0, 1, 'Low', 'High']));
    });

    it('z.object with optional + default keys → not in required', () => {
      const s = z.object({
        a: z.string(),
        b: z.string().optional(),
        c: z.number().default(1),
      });
      const out = zodToJsonSchema(s);
      expect(out['required']).toEqual(['a']);
    });

    it('z.nullable(z.string()) → type [string, null]', () => {
      const n = z.nullable(z.string());
      const out = zodToJsonSchema(n);
      expect(out['type']).toEqual(['string', 'null']);
    });

    it('completes a 50-field object schema within 10ms', () => {
      const shape: Record<string, z.ZodTypeAny> = {};
      const FIELD_COUNT = 50;
      for (let i = 0; i < FIELD_COUNT; i++) {
        shape[`field_${i}`] = z.string().min(1).max(100);
      }
      const big = z.object(shape);
      const PERF_BUDGET_MS = 10;
      const start = performance.now();
      const out = zodToJsonSchema(big);
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(PERF_BUDGET_MS);
      expect(Object.keys(out['properties'] as Record<string, unknown>)).toHaveLength(FIELD_COUNT);
    });

    it('bounded recursion depth (no infinite loop on self-referential lazy)', () => {
      // Construct a directly self-referential lazy (no base case). The
      // converter MUST terminate via depth guard, returning {} eventually.
      interface RecursiveBox { children?: RecursiveBox[] }
      const recursive: z.ZodType<RecursiveBox> = z.lazy(() =>
        z.object({ children: z.array(recursive).optional() }),
      );
      // Should not throw / hang.
      const out = zodToJsonSchema(recursive);
      expect(typeof out).toBe('object');
    });
  });

  // ---------------------- parseUsage edge cases ----------------------

  describe('parseUsage helper', () => {
    it('handles undefined usage entirely', () => {
      const out = parseUsage(undefined);
      expect(out).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
    });

    it('handles partial usage (only input/output, no cache fields)', () => {
      const out = parseUsage({ input_tokens: 10, output_tokens: 5 });
      expect(out.inputTokens).toBe(10);
      expect(out.outputTokens).toBe(5);
      expect(out.cacheReadTokens).toBe(0);
      expect(out.cacheCreationTokens).toBe(0);
    });

    it('handles all four fields populated', () => {
      const out = parseUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 4,
      });
      expect(out).toEqual({
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 4,
        cacheCreationTokens: 3,
      });
    });

    it('NaN / Infinity / null fields coerced to 0', () => {
      const out = parseUsage({
        // @ts-expect-error — exercising defensive runtime path
        input_tokens: Number.NaN,
        // @ts-expect-error — exercising defensive runtime path
        output_tokens: Number.POSITIVE_INFINITY,
        // @ts-expect-error — exercising defensive runtime path
        cache_creation_input_tokens: null,
      });
      expect(out.inputTokens).toBe(0);
      expect(out.outputTokens).toBe(0);
      expect(out.cacheCreationTokens).toBe(0);
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

  // ---------------------- provider HTTP errors (Move 1) ----------------------

  describe('provider HTTP rejection vs output validation', () => {
    it('HTTP 400 credit-balance → StructuredLlmProviderError (NOT a ValidationError)', async () => {
      // The provider rejected the request at the transport layer — the model
      // never produced output. This MUST NOT be conflated with a
      // ValidationError (which means "200 OK but the model output failed our
      // schema"). Historically HTTP 400 "credit balance too low" was mapped to
      // ValidationError, masquerading a provider outage as malformed output.
      const creditBody = JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.',
        },
      });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(creditBody, { status: 400 })));
      let caught: unknown = null;
      try {
        await adapter().analyze({
          query: 'q',
          schema: z.object({ x: z.number() }),
          systemPrompt: 'sys',
          maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
          perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
          model: TEST_MODEL,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StructuredLlmProviderError);
      expect(caught).not.toBeInstanceOf(StructuredLlmValidationError);
      expect((caught as StructuredLlmProviderError).httpStatus).toBe(400);
    });
  });
});
