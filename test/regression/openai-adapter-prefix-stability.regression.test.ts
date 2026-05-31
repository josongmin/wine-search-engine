/**
 * Regression: OpenAI structured-LLM adapter must emit prefix-stable request
 * bytes for repeated calls within the same adapter mode.
 *
 * Why this contract exists:
 *   OpenAI's Chat Completions API performs *implicit* prefix caching when the
 *   FIRST ~1024 tokens of a request are byte-identical across calls. Cache
 *   hits give ~50% latency reduction and ~50% input-token discount. Unlike
 *   Anthropic's adapter (which uses explicit `cache_control: ephemeral`), the
 *   OpenAI adapter relies on the request bytes themselves being stable —
 *   meaning the `system` slot and `tools[]` order MUST NOT vary per request.
 *
 *   Concretely: any dynamic content (request id, timestamps, the user query,
 *   per-scenario rubric) must live in the trailing user turns, never in
 *   `messages[0]` (system) or in the tools array order. If a future refactor
 *   accidentally interpolates a per-request value into the system prompt, the
 *   prefix-cache hit rate silently drops to zero — there's no observable
 *   error, just a 2× latency / cost regression.
 *
 * Append-only — do NOT delete tests. If an invariant changes intentionally,
 * add a new test that documents the new contract and leave the old one
 * `.skip`'d for history (CLAUDE.md test discipline).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  OpenAIStructuredLlmAdapter,
} from '../../src/infrastructure/ai/openai-structured-llm-adapter.js';
import type { ToolDefinition } from '../../src/domain/ai/port/structured-llm.port.js';
import { globalCircuitBreakerRegistry } from '../../src/domain/observability/circuit-breaker-registry.js';

const DEFAULT_HTTP_TIMEOUT_MS = 60_000;
const DEFAULT_PER_STEP_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 256;
const TEST_MODEL = 'gpt-4o-mini';

interface CapturedRequest {
  readonly body: {
    readonly messages: readonly { readonly role: string; readonly content?: string }[];
    readonly tools?: readonly { readonly function: { readonly name: string } }[];
  };
}

/**
 * Stub `fetch` that captures the serialized POST body sent to OpenAI and
 * returns a deterministic tool_call response so the adapter's success path
 * runs end-to-end.
 */
function stubFetch(opts: { readonly toolFnName: string; readonly toolArguments: string }): {
  readonly captures: CapturedRequest[];
} {
  const captures: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const rawBody = init?.body;
      if (typeof rawBody !== 'string') {
        throw new Error('expected JSON-string body');
      }
      const parsedUnknown: unknown = JSON.parse(rawBody);
      // Defensive narrowing — bench tests treat the body as opaque except for
      // the two arrays under test.
      if (typeof parsedUnknown !== 'object' || parsedUnknown === null) {
        throw new Error('expected object body');
      }
      const parsedRecord = parsedUnknown as { messages?: unknown; tools?: unknown };
      if (!Array.isArray(parsedRecord.messages)) {
        throw new Error('expected messages array');
      }
      const body = {
        messages: parsedRecord.messages as readonly { readonly role: string; readonly content?: string }[],
        ...(Array.isArray(parsedRecord.tools)
          ? { tools: parsedRecord.tools as readonly { readonly function: { readonly name: string } }[] }
          : {}),
      };
      captures.push({ body });
      const responseBody = {
        id: 'chatcmpl-test',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_test',
                  type: 'function',
                  function: {
                    name: opts.toolFnName,
                    arguments: opts.toolArguments,
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return { captures };
}

function adapter(): OpenAIStructuredLlmAdapter {
  return new OpenAIStructuredLlmAdapter({
    apiKey: 'sk-test',
    defaultModel: TEST_MODEL,
    httpTimeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
  });
}

describe('regression: openai-structured-llm-adapter prefix stability', () => {
  beforeEach(() => {
    globalCircuitBreakerRegistry.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    globalCircuitBreakerRegistry.clear();
  });

  // -------------------------------------------------------------------------
  // Invariant: analyze() system slot is byte-identical across queries
  // -------------------------------------------------------------------------
  it('analyze(): system message is byte-identical across two different queries', async () => {
    const { captures } = stubFetch({
      toolFnName: 'analyze',
      toolArguments: JSON.stringify({ intent: 'search' }),
    });
    const ad = adapter();
    const schema = z.object({ intent: z.string() });
    const SYSTEM_PROMPT = 'You are a wine analyzer. Static instructions only.';
    await ad.analyze({
      query: 'first query — Bordeaux red 2018',
      schema,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    await ad.analyze({
      query: 'completely different query about Burgundy whites',
      schema,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    expect(captures.length).toBe(2);
    const sys0 = captures[0]?.body.messages[0];
    const sys1 = captures[1]?.body.messages[0];
    expect(sys0?.role).toBe('system');
    expect(sys1?.role).toBe('system');
    // Byte-identical assertion — this is the prefix-cache hit precondition.
    expect(sys1?.content).toBe(sys0?.content);
    expect(sys0?.content).toBe(SYSTEM_PROMPT);
    // Sanity: the user query DID vary, so we know the test is exercising
    // distinct inputs (not just hitting identical request paths).
    const user0 = captures[0]?.body.messages[1];
    const user1 = captures[1]?.body.messages[1];
    expect(user0?.content).not.toBe(user1?.content);
  });

  // -------------------------------------------------------------------------
  // Invariant: execute() system slot is byte-identical across calls
  // -------------------------------------------------------------------------
  it('execute(): system message is byte-identical across two different chat histories', async () => {
    const { captures } = stubFetch({
      toolFnName: 'search_hybrid',
      toolArguments: JSON.stringify({ query: 'x' }),
    });
    const ad = adapter();
    const SYSTEM_PROMPT = 'You are a tool-using agent. Static rules only.';
    const tools: readonly ToolDefinition[] = [
      {
        name: 'search_hybrid',
        description: 'Search wines',
        inputSchema: z.object({ query: z.string() }),
      },
    ];
    await ad.execute({
      messages: [{ role: 'user', content: 'first turn' }],
      tools,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    await ad.execute({
      messages: [
        { role: 'user', content: 'an entirely different turn with longer content' },
        { role: 'assistant', content: 'prior assistant turn' },
        { role: 'user', content: 'follow-up' },
      ],
      tools,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    expect(captures.length).toBe(2);
    const sys0 = captures[0]?.body.messages[0];
    const sys1 = captures[1]?.body.messages[0];
    expect(sys0?.role).toBe('system');
    expect(sys1?.role).toBe('system');
    expect(sys1?.content).toBe(sys0?.content);
    expect(sys0?.content).toBe(SYSTEM_PROMPT);
  });

  // -------------------------------------------------------------------------
  // Invariant: execute() tools array is byte-identical when same tool set is
  // passed in different orderings
  // -------------------------------------------------------------------------
  it('execute(): tools array is byte-identical regardless of caller-supplied ordering', async () => {
    const { captures } = stubFetch({
      toolFnName: 'search_hybrid',
      toolArguments: JSON.stringify({ query: 'x' }),
    });
    const ad = adapter();
    const SYSTEM_PROMPT = 'static system';
    const toolA: ToolDefinition = {
      name: 'search_hybrid',
      description: 'a',
      inputSchema: z.object({ query: z.string() }),
    };
    const toolB: ToolDefinition = {
      name: 'lookup_wine',
      description: 'b',
      inputSchema: z.object({ query: z.string() }),
    };
    const toolC: ToolDefinition = {
      name: 'search_semantic',
      description: 'c',
      inputSchema: z.object({ query: z.string() }),
    };

    // Call 1: A, B, C
    await ad.execute({
      messages: [{ role: 'user', content: 'q1' }],
      tools: [toolA, toolB, toolC],
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    // Call 2: C, A, B  (different array order — same logical tool set)
    await ad.execute({
      messages: [{ role: 'user', content: 'q2' }],
      tools: [toolC, toolA, toolB],
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    expect(captures.length).toBe(2);
    const tools0 = captures[0]?.body.tools;
    const tools1 = captures[1]?.body.tools;
    expect(tools0).toBeDefined();
    expect(tools1).toBeDefined();
    // Tool order is deterministic (sorted by name) → JSON bytes match.
    expect(JSON.stringify(tools1)).toBe(JSON.stringify(tools0));
    // Confirm sort order is alphabetical so a caller can predict the prefix.
    expect(tools0?.map((t) => t.function.name)).toEqual([
      'lookup_wine',
      'search_hybrid',
      'search_semantic',
    ]);
  });

  // -------------------------------------------------------------------------
  // Invariant: synthesize() system slot is byte-identical across calls with
  // different message histories
  // -------------------------------------------------------------------------
  it('synthesize(): system message is byte-identical across two different histories', async () => {
    const { captures } = stubFetch({
      toolFnName: 'synthesize',
      toolArguments: JSON.stringify({ answer: 'ok' }),
    });
    const ad = adapter();
    const schema = z.object({ answer: z.string() });
    const SYSTEM_PROMPT = 'You are a synthesizer. Static-only.';
    await ad.synthesize({
      messages: [
        { role: 'user', content: 'first user turn' },
        { role: 'user', content: 'grounding A: short blob' },
      ],
      schema,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    await ad.synthesize({
      messages: [
        { role: 'user', content: 'totally different user turn' },
        { role: 'user', content: 'grounding B: much longer blob with different content entirely' },
        { role: 'user', content: 'extra directive turn' },
      ],
      schema,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    expect(captures.length).toBe(2);
    const sys0 = captures[0]?.body.messages[0];
    const sys1 = captures[1]?.body.messages[0];
    expect(sys0?.role).toBe('system');
    expect(sys1?.role).toBe('system');
    expect(sys1?.content).toBe(sys0?.content);
    expect(sys0?.content).toBe(SYSTEM_PROMPT);
  });

  // -------------------------------------------------------------------------
  // Invariant: a caller-supplied `system` role message inside `messages[]`
  // is demoted to a `user` directive so the system slot stays byte-identical.
  // -------------------------------------------------------------------------
  it('execute(): inbound `system` role message in `messages[]` is demoted to user (system slot stays clean)', async () => {
    const { captures } = stubFetch({
      toolFnName: 'search_hybrid',
      toolArguments: JSON.stringify({ query: 'x' }),
    });
    const ad = adapter();
    const SYSTEM_PROMPT = 'static system bytes only';
    const tools: readonly ToolDefinition[] = [
      {
        name: 'search_hybrid',
        description: 'a',
        inputSchema: z.object({ query: z.string() }),
      },
    ];
    // First call — no extra system message.
    await ad.execute({
      messages: [{ role: 'user', content: 'plain user turn' }],
      tools,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    // Second call — caller smuggled a `system` role into the conversation.
    // The adapter must NOT extend the system slot; it must demote the extra
    // bytes into a trailing user directive.
    await ad.execute({
      messages: [
        { role: 'system', content: 'this is dynamic per-request content that would defeat the prefix cache' },
        { role: 'user', content: 'plain user turn' },
      ],
      tools,
      systemPrompt: SYSTEM_PROMPT,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      perStepTimeoutMs: DEFAULT_PER_STEP_TIMEOUT_MS,
      model: TEST_MODEL,
    });
    expect(captures.length).toBe(2);
    const sys0 = captures[0]?.body.messages[0];
    const sys1 = captures[1]?.body.messages[0];
    // Both calls — system slot is byte-identical to `SYSTEM_PROMPT`.
    expect(sys0?.role).toBe('system');
    expect(sys1?.role).toBe('system');
    expect(sys0?.content).toBe(SYSTEM_PROMPT);
    expect(sys1?.content).toBe(SYSTEM_PROMPT);
    // Confirm there is exactly ONE system slot in the second call (no extra
    // system role smuggled through). The demoted content shows up as a USER
    // turn after the system slot.
    const systemSlotCount = captures[1]?.body.messages.filter((m) => m.role === 'system').length;
    expect(systemSlotCount).toBe(1);
    const demotedTurn = captures[1]?.body.messages.find(
      (m) => m.role === 'user' && m.content?.includes('this is dynamic per-request content'),
    );
    expect(demotedTurn).toBeDefined();
  });
});
