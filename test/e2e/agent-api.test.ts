/**
 * E2E tests for POST /v1/agent — agentic wine search.
 *
 * Uses a **scripted mock ChatLlm** that returns pre-defined ReAct steps,
 * so tests are deterministic and don't require a real OpenAI API key.
 * The actual search pipeline (Planner, Vespa in-memory, Ranker, Decision)
 * runs for real — only the LLM reasoning is scripted.
 */

import { describe, it, expect, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestContainer } from '../integration/helpers/test-container.js';
import { createServer } from '../../src/interface/http/server.js';
import { AgentOrchestrator } from '../../src/application/agent/agent-orchestrator.js';
import type { ChatLlmPort, ChatCompletionRequest, ChatCompletionResult } from '../../src/domain/ai/port/chat-llm.port.js';
import { postJson } from './helpers/http-transport.js';

// ---------------------------------------------------------------------------
// Scripted LLM mock — returns pre-defined responses in sequence
// ---------------------------------------------------------------------------

class ScriptedChatLlm implements ChatLlmPort {
  private callIndex = 0;
  constructor(private readonly responses: readonly string[]) {}

  async complete(_request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const text = this.responses[this.callIndex] ?? '{"thought":"no more script","answer":"I have no further information."}';
    this.callIndex++;
    return { text, model: 'scripted-test', finishReason: 'stop' };
  }
}

// ---------------------------------------------------------------------------
// Test server with agent wired
// ---------------------------------------------------------------------------

let app: FastifyInstance;

async function createAgentTestServer(llm: ChatLlmPort): Promise<FastifyInstance> {
  const parts = createTestContainer();

  const agentOrchestrator = new AgentOrchestrator(
    {
      chatLlm: llm,
      toolDeps: {
        searchUseCase: parts.container.searchUseCase,
      },
    },
    { maxSteps: 5, agentTimeoutMs: 15_000, perStepTimeoutMs: 10_000, maxContextChars: 8_000 },
  );

  const server = await createServer(
    { ...parts.container, agentOrchestrator },
    { logLevel: 'silent', nodeEnv: 'test' },
  );
  await server.ready();
  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentPost(server: FastifyInstance, body: unknown) {
  return postJson(server, '/v1/agent', body);
}

function parseAgentResponse(res: { json(): unknown }) {
  return res.json() as {
    query_type: string;
    answer: string;
    steps: Array<{
      index: number;
      thought: string;
      action?: { tool: string; input: Record<string, unknown> };
      observation?: string;
      answer?: string;
      duration_ms: number;
      token_count: { input: number; output: number };
    }>;
    meta: {
      request_id: string;
      total_duration_ms: number;
      tool_call_count: number;
      termination_reason: string;
      fallback_applied: boolean;
      total_tokens: { input: number; output: number };
    };
  };
}

// ---------------------------------------------------------------------------
// Tier 1: Single-shot scenarios
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Tier 1: Single-shot', () => {
  afterAll(async () => { if (app) await app.close(); });

  it('simple wine search → 1 tool call + answer', async () => {
    const llm = new ScriptedChatLlm([
      // Step 1: search
      '{"thought":"User wants Opus One 2018","action":{"tool":"search_wines","input":{"query":"Opus One 2018"}}}',
      // Step 2: answer
      '{"thought":"Found results","answer":"Opus One 2018 is a premium Napa Valley red blend."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'Opus One 2018' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.query_type).toBe('agent');
    expect(body.answer).toContain('Opus One');
    expect(body.meta.termination_reason).toBe('answer');
    expect(body.meta.tool_call_count).toBe(1);
    expect(body.steps.length).toBe(2);
    expect(body.steps[0]?.action?.tool).toBe('search_wines');
    expect(body.steps[0]?.observation).toBeDefined();
    expect(body.steps[1]?.answer).toBeDefined();
  });

  it('direct answer without tools (out of domain)', async () => {
    const llm = new ScriptedChatLlm([
      '{"thought":"This is about beer, not wine","answer":"I specialize in wine. I can\'t help with beer, but I\'d be happy to find you a wine instead."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: '맥주 추천해줘' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.meta.tool_call_count).toBe(0);
    expect(body.meta.termination_reason).toBe('answer');
    expect(body.answer).toContain('wine');
  });
});

// ---------------------------------------------------------------------------
// Tier 2: Multi-step scenarios
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Tier 2: Multi-step', () => {
  afterAll(async () => { if (app) await app.close(); });

  it('food pairing + price filter → 2 tool calls', async () => {
    const llm = new ScriptedChatLlm([
      '{"thought":"Need steak pairing","action":{"tool":"get_food_pairings","input":{"food":"steak","color":"red"}}}',
      '{"thought":"Got pairings, now filter by price","action":{"tool":"search_wines","input":{"query":"steak pairing red wine under $50"}}}',
      '{"thought":"Found affordable options","answer":"For steak, I recommend these red wines under $50: ..."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: '스테이크에 어울리는 와인 중에 5만원 이하' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.meta.tool_call_count).toBe(2);
    expect(body.meta.termination_reason).toBe('answer');
    expect(body.steps[0]?.action?.tool).toBe('get_food_pairings');
    expect(body.steps[1]?.action?.tool).toBe('search_wines');
  });

  it('compare + drinking window → 3 tool calls', async () => {
    const llm = new ScriptedChatLlm([
      '{"thought":"Compare Barolo and Brunello","action":{"tool":"compare_wines","input":{"query_a":"Barolo","query_b":"Brunello"}}}',
      '{"thought":"Check if Barolo is drinkable now","action":{"tool":"check_drinking_window","input":{"entity_id":"wine-barolo-2019"}}}',
      '{"thought":"Check Brunello too","action":{"tool":"check_drinking_window","input":{"entity_id":"wine-brunello-2018"}}}',
      '{"thought":"Both wines compared and checked","answer":"Barolo 2019 is currently drinkable..."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: '바롤로랑 브루넬로 비교해주고 지금 마시기 좋은 거로 골라줘' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.meta.tool_call_count).toBe(3);
    expect(body.steps[0]?.action?.tool).toBe('compare_wines');
  });
});

// ---------------------------------------------------------------------------
// Tier 3: Safety & edge cases
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Tier 3: Safety', () => {
  afterAll(async () => { if (app) await app.close(); });

  it('max steps enforcement → terminates at limit', async () => {
    // LLM keeps calling tools forever
    const llm = new ScriptedChatLlm([
      '{"thought":"search 1","action":{"tool":"search_wines","input":{"query":"wine 1"}}}',
      '{"thought":"search 2","action":{"tool":"search_wines","input":{"query":"wine 2"}}}',
      '{"thought":"search 3","action":{"tool":"search_wines","input":{"query":"wine 3"}}}',
      '{"thought":"search 4","action":{"tool":"search_wines","input":{"query":"wine 4"}}}',
      '{"thought":"search 5","action":{"tool":"search_wines","input":{"query":"wine 5"}}}',
      '{"thought":"search 6","action":{"tool":"search_wines","input":{"query":"wine 6"}}}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'keep searching forever' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    // max_steps triggers fallback, so termination_reason is 'fallback'
    expect(body.meta.termination_reason).toBe('fallback');
    expect(body.meta.tool_call_count).toBeLessThanOrEqual(5);
    expect(body.meta.fallback_applied).toBe(true);
  });

  it('loop detection → terminates on repeated tool call', async () => {
    const llm = new ScriptedChatLlm([
      '{"thought":"search","action":{"tool":"search_wines","input":{"query":"Opus One"}}}',
      '{"thought":"search again same thing","action":{"tool":"search_wines","input":{"query":"Opus One"}}}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'Opus One' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.meta.termination_reason).toBe('loop_detected');
  });

  it('unknown tool → agent recovers with feedback', async () => {
    const llm = new ScriptedChatLlm([
      '{"thought":"try fake tool","action":{"tool":"fake_tool","input":{"x":1}}}',
      '{"thought":"that failed, try real tool","action":{"tool":"search_wines","input":{"query":"wine"}}}',
      '{"thought":"got results","answer":"Here are some wines..."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'test unknown tool recovery' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.steps[0]?.observation).toContain('Unknown tool');
    expect(body.meta.termination_reason).toBe('answer');
  });

  it('invalid tool input → agent gets validation feedback', async () => {
    const llm = new ScriptedChatLlm([
      // query field missing
      '{"thought":"search without query","action":{"tool":"search_wines","input":{"limit":5}}}',
      '{"thought":"need query field","action":{"tool":"search_wines","input":{"query":"wine"}}}',
      '{"thought":"got results","answer":"Found wines."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'test validation feedback' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.steps[0]?.observation).toContain('Invalid input');
    expect(body.meta.termination_reason).toBe('answer');
  });

  it('empty query → 400 validation error', async () => {
    const llm = new ScriptedChatLlm([]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: '' });
    expect(res.statusCode).toBe(400);
  });

  it('missing query field → 400 validation error', async () => {
    const llm = new ScriptedChatLlm([]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, {});
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tier 4: Response schema contract
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Tier 4: Response contract', () => {
  afterAll(async () => { if (app) await app.close(); });

  it('response has all required meta fields', async () => {
    const llm = new ScriptedChatLlm([
      '{"thought":"quick answer","answer":"Here is a wine recommendation."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: '와인 추천' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.query_type).toBe('agent');
    expect(typeof body.answer).toBe('string');
    expect(Array.isArray(body.steps)).toBe(true);
    expect(typeof body.meta.request_id).toBe('string');
    expect(typeof body.meta.total_duration_ms).toBe('number');
    expect(body.meta.total_duration_ms).toBeGreaterThanOrEqual(0);
    expect(typeof body.meta.tool_call_count).toBe('number');
    expect(typeof body.meta.termination_reason).toBe('string');
    expect(typeof body.meta.fallback_applied).toBe('boolean');
    expect(typeof body.meta.total_tokens.input).toBe('number');
    expect(typeof body.meta.total_tokens.output).toBe('number');
  });

  it('each step has required fields', async () => {
    const llm = new ScriptedChatLlm([
      '{"thought":"searching","action":{"tool":"search_wines","input":{"query":"wine"}}}',
      '{"thought":"done","answer":"Found wine."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'wine' });
    const body = parseAgentResponse(res);

    for (const step of body.steps) {
      expect(typeof step.index).toBe('number');
      expect(step.index).toBeGreaterThanOrEqual(0);
      expect(typeof step.thought).toBe('string');
      expect(typeof step.duration_ms).toBe('number');
      expect(step.duration_ms).toBeGreaterThanOrEqual(0);
      expect(typeof step.token_count.input).toBe('number');
      expect(typeof step.token_count.output).toBe('number');
    }
  });
});
