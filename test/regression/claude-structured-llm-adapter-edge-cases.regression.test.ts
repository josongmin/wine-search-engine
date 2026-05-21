/**
 * Regression: Anthropic structured-LLM adapter must defend against the
 * non-happy-path response shapes that real Claude API traffic exhibits.
 *
 * Append-only. Each invariant below was a real failure mode discovered while
 * hardening `claude-structured-llm-adapter.ts`. Do not delete tests; if an
 * invariant changes intentionally, add a NEW test that documents the new
 * contract and leave the old one (with a `.skip` + comment) for history.
 *
 * Invariants verified:
 *   1. Truncated (`stop_reason: 'max_tokens'`) tool_use blocks raise
 *      StructuredLlmPartialOutputError (NOT validation), so callers retry
 *      with a bigger token budget instead of marking the schema broken.
 *   2. Wrong tool name in tool_use block raises StructuredLlmValidationError
 *      (NOT partial-output), so callers treat it as a Claude contract
 *      violation rather than retrying blindly.
 *   3. Extra fields in tool input (reasoning, confidence, …) pass through
 *      unrejected (CLAUDE.md rule 10).
 *   4. Token-usage accounting reports 0 for missing cache fields on
 *      pre-prompt-caching Claude versions instead of NaN-propagating.
 *   5. Malformed JSON in a 200 response is surfaced as a typed transport
 *      error — the adapter does NOT crash with a 500-shaped exception.
 *   6. Parallel tool_use blocks are all surfaced by execute().
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  StructuredLlmPartialOutputError,
  StructuredLlmValidationError,
} from '../../src/domain/ai/port/structured-llm.port.js';
import { ClaudeStructuredLlmAdapter } from '../../src/infrastructure/ai/claude-structured-llm-adapter.js';
import { globalCircuitBreakerRegistry } from '../../src/domain/observability/circuit-breaker-registry.js';

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

interface AnthropicResponseBody {
  readonly id?: string;
  readonly model?: string;
  readonly stop_reason: string;
  readonly content: readonly unknown[];
  readonly usage?: Record<string, unknown>;
}

function mockResponse(body: AnthropicResponseBody): Response {
  return new Response(
    JSON.stringify({
      id: body.id ?? 'msg_regression',
      type: 'message',
      role: 'assistant',
      model: body.model ?? TEST_MODEL,
      stop_reason: body.stop_reason,
      stop_sequence: null,
      content: body.content,
      usage: body.usage,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('regression: claude-structured-llm-adapter edge cases', () => {
  beforeEach(() => {
    globalCircuitBreakerRegistry.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalCircuitBreakerRegistry.clear();
  });

  // -------------------------------------------------------------------------
  // Invariant 1: truncation precedes validation
  // -------------------------------------------------------------------------
  it('max_tokens truncation surfaces PartialOutput, not Validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse({
          stop_reason: 'max_tokens',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_trunc',
              name: 'respond',
              // Missing required `count` — Zod would normally reject, but
              // truncation takes priority.
              input: { intent: 'recommend' },
            },
          ],
          usage: { input_tokens: 100, output_tokens: 256 },
        }),
      ),
    );

    let caught: unknown = null;
    try {
      await adapter().analyze({
        query: 'q',
        schema: z.object({ intent: z.string(), count: z.number() }),
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StructuredLlmPartialOutputError);
    expect(caught).not.toBeInstanceOf(StructuredLlmValidationError);
  });

  // -------------------------------------------------------------------------
  // Invariant 2: wrong tool name → validation error (Claude contract breach)
  // -------------------------------------------------------------------------
  it('wrong tool name on forced tool_choice → ValidationError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_wrong',
              name: 'not_the_respond_tool',
              input: { anything: true },
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
      ),
    );

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
    expect((caught as Error).message).toContain('not_the_respond_tool');
  });

  // -------------------------------------------------------------------------
  // Invariant 3: extra fields pass through
  // -------------------------------------------------------------------------
  it('LLM extra fields (reasoning/confidence/metadata) pass through', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_extra',
              name: 'respond',
              input: {
                intent: 'recommend',
                reasoning: 'because the user said fruity',
                confidence: 0.9,
                debug: { trace: [1, 2, 3] },
              },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    );
    const result = await adapter().analyze({
      query: 'q',
      schema: z.object({ intent: z.string() }),
      systemPrompt: 'sys',
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    expect(result.data).toEqual({ intent: 'recommend' });
  });

  // -------------------------------------------------------------------------
  // Invariant 4: missing cache fields → 0, not NaN
  // -------------------------------------------------------------------------
  it('pre-caching response shape: cache fields default to 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 'toolu_legacy', name: 'respond', input: { ok: true } },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      ),
    );
    const result = await adapter().analyze({
      query: 'q',
      schema: z.object({ ok: z.boolean() }),
      systemPrompt: 'sys',
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    expect(result.usage.cacheReadTokens).toBe(0);
    expect(result.usage.cacheCreationTokens).toBe(0);
    expect(Number.isFinite(result.usage.cacheReadTokens)).toBe(true);
    expect(Number.isFinite(result.usage.cacheCreationTokens)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Invariant 5: malformed JSON → typed error, no crash
  // -------------------------------------------------------------------------
  it('malformed JSON in 200 response → throws, does not crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('}{not json', { status: 200 })),
    );
    await expect(
      adapter().analyze({
        query: 'q',
        schema: z.object({ ok: z.boolean() }),
        systemPrompt: 'sys',
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
        model: TEST_MODEL,
      }),
    ).rejects.toThrow(/malformed JSON|unexpected response/i);
  });

  // -------------------------------------------------------------------------
  // Invariant 6: parallel tool_use blocks surface all calls
  // -------------------------------------------------------------------------
  it('execute() with parallel tool_use blocks returns ALL calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockResponse({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } },
            { type: 'tool_use', id: 't2', name: 'search', input: { q: 'b' } },
            { type: 'tool_use', id: 't3', name: 'search', input: { q: 'c' } },
          ],
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      ),
    );
    const result = await adapter().execute({
      messages: [{ role: 'user', content: 'parallel search' }],
      tools: [
        {
          name: 'search',
          description: 'd',
          inputSchema: z.object({ q: z.string() }),
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
    expect(result.calls).toHaveLength(3);
    expect(result.calls.map((c) => c.input)).toEqual([
      { q: 'a' },
      { q: 'b' },
      { q: 'c' },
    ]);
  });

  // -------------------------------------------------------------------------
  // Invariant 7: Korean input round-trips unchanged through messages
  // -------------------------------------------------------------------------
  it('Korean (한글) query content reaches the API body verbatim', async () => {
    const KOREAN_QUERY = '한국 와인 추천 부탁드립니다 🍷';
    let capturedBody = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = typeof init.body === 'string' ? init.body : '';
        return mockResponse({
          stop_reason: 'tool_use',
          content: [
            { type: 'tool_use', id: 't', name: 'respond', input: { ok: true } },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );
    await adapter().analyze({
      query: KOREAN_QUERY,
      schema: z.object({ ok: z.boolean() }),
      systemPrompt: 'sys',
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    expect(capturedBody).toContain(KOREAN_QUERY);
  });
});
