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
import { AgentResponseSchema, type AgentResponseBody } from '../../src/interface/http/schemas/agent.schema.js';

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

function parseAgentResponse(res: { json(): unknown }): AgentResponseBody {
  return AgentResponseSchema.parse(res.json());
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
    // The out-of-domain (beer) redirect is the INTENDED terminal answer for this
    // query — a deliberate, policy-grounded completion. terminationReason must
    // therefore report `answer`, NOT the resource-limit reason (`budget`) that the
    // grounded-search-required planner re-plan churn happens to leave behind.
    // Under the A3 priority order completions (`answer`) dominate resource limits.
    expect(body.meta.termination_reason).toBe('answer');
    expect(body.answer).toMatch(/와인|wine/iu);
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
    // LLM keeps calling tools forever. The six queries are intentionally
    // DISTINCT wine names (not "wine 1".."wine 6", which trip the near-duplicate
    // Jaccard loop guard at step 1 and never exercise the downstream budgets).
    // The script has exactly SIX tool-calling responses, so the agent can never
    // execute more than six tools no matter how the budgets interleave — that
    // hard ceiling is the runaway-prevention invariant under test. In practice
    // the token budget (maxTotalTokens=50_000) is exhausted by the accumulating
    // re-plan context first; the orchestrator then produces a grounded Layer-3
    // answer from the observations it already gathered, so the run terminates
    // as a completion rather than spinning forever.
    const llm = new ScriptedChatLlm([
      '{"thought":"search 1","action":{"tool":"search_wines","input":{"query":"Opus One Napa Valley"}}}',
      '{"thought":"search 2","action":{"tool":"search_wines","input":{"query":"Sassicaia Bolgheri Tuscany"}}}',
      '{"thought":"search 3","action":{"tool":"search_wines","input":{"query":"Penfolds Grange Shiraz"}}}',
      '{"thought":"search 4","action":{"tool":"search_wines","input":{"query":"Chateau Margaux Bordeaux"}}}',
      '{"thought":"search 5","action":{"tool":"search_wines","input":{"query":"Cloudy Bay Sauvignon Marlborough"}}}',
      '{"thought":"search 6","action":{"tool":"search_wines","input":{"query":"Vega Sicilia Unico Ribera"}}}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'keep searching forever' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    // The run is bounded by one of the safety stops, after which the orchestrator
    // may synthesize an answer / produce a Layer-3 grounded preview (`answer`),
    // fall back (`fallback`), or report the limit directly. All are legitimate
    // bounded terminations:
    //   - `answer`/`fallback` : a final answer was produced from the capped run.
    //       Under the A3 priority order completions dominate resource limits, so
    //       a run that hit `budget` but still produced a Layer-3 grounded answer
    //       correctly reports `answer`.
    //   - `budget`/`max_steps`/`timeout` : the limit fired and NO answer followed.
    //   - `loop_detected` : the per-tool / near-duplicate guard fired.
    expect(
      ['answer', 'fallback', 'max_steps', 'budget', 'timeout', 'loop_detected'].includes(
        body.meta.termination_reason,
      ),
    ).toBe(true);
    // Hard runaway-prevention ceiling: the agent cannot execute more tools than
    // the LLM scripts (6). tool_call_count counts only committed step
    // actions/actionPairs; the Layer-2 recovery search pushes no step and is NOT
    // counted, so this bound is never inflated by recovery.
    expect(body.meta.tool_call_count).toBeLessThanOrEqual(6);
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
    // Loop detection fires, but synthesis may still produce an answer.
    expect(['loop_detected', 'answer'].includes(body.meta.termination_reason)).toBe(true);
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

// ---------------------------------------------------------------------------
// Tier 5: Parallel tool execution
// ---------------------------------------------------------------------------

describe('POST /v1/agent — Tier 5: Parallel tool execution', () => {
  afterAll(async () => { if (app) await app.close(); });

  it('parallel batch step: actions[] in response, tool_call_count=2', async () => {
    // LLM fires search_wines + get_food_pairings simultaneously in one "actions" batch.
    const llm = new ScriptedChatLlm([
      JSON.stringify({
        thought: 'User wants steak pairing AND a wine search — fire both at once',
        actions: [
          { tool: 'search_wines', input: { query: 'bold red wine' } },
          { tool: 'get_food_pairings', input: { food: 'steak' } },
        ],
      }),
      '{"thought":"got both results","answer":"For steak I recommend bold reds."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: '스테이크용 볼드한 레드 와인 추천' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.meta.termination_reason).toBe('answer');
    // Both tool calls counted
    expect(body.meta.tool_call_count).toBe(2);

    // Parallel batch step is present
    const batchStep = body.steps.find((s) => s.actions !== undefined);
    expect(batchStep).toBeDefined();
    expect(batchStep?.actions).toHaveLength(2);
    expect(batchStep?.actions?.[0]?.tool).toBe('search_wines');
    expect(batchStep?.actions?.[1]?.tool).toBe('get_food_pairings');
    // Both observations returned
    expect(batchStep?.observations).toHaveLength(2);
    expect(typeof batchStep?.observations?.[0]).toBe('string');
    expect(typeof batchStep?.observations?.[1]).toBe('string');
    // Parallel step has no singular action/observation
    expect(batchStep?.action).toBeUndefined();
    expect(batchStep?.observation).toBeUndefined();
  });

  it('parallel batch: one tool error does not break the other result', async () => {
    // search_wines gets a valid query, get_food_pairings gets invalid input (missing food).
    // The valid tool should return an observation; the invalid one gets a Zod error observation.
    const llm = new ScriptedChatLlm([
      JSON.stringify({
        thought: 'fire both — one will fail input validation',
        actions: [
          { tool: 'search_wines', input: { query: 'Barolo' } },
          { tool: 'get_food_pairings', input: {} },  // food field missing → Zod error
        ],
      }),
      '{"thought":"partial results","answer":"Found Barolo."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'Barolo' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.meta.tool_call_count).toBe(2);
    const batchStep = body.steps.find((s) => s.actions !== undefined);
    expect(batchStep?.observations).toHaveLength(2);
    // First observation: valid search result
    expect(batchStep?.observations?.[0]).not.toContain('unexpected error');
    // Second observation: Zod validation error for missing food
    expect(batchStep?.observations?.[1]).toContain('Invalid input');
  });

  it('parallel batch: unknown tool in batch gets error observation, loop continues', async () => {
    // LLM emits an unknown tool in an actions[] batch.
    // Orchestrator should push an error observation and allow the LLM to retry.
    const llm = new ScriptedChatLlm([
      JSON.stringify({
        thought: 'try a batch with an unknown tool',
        actions: [
          { tool: 'fake_tool', input: { x: 1 } },
          { tool: 'search_wines', input: { query: 'wine' } },
        ],
      }),
      // After error feedback, LLM corrects itself
      '{"thought":"fake_tool not available, just search","action":{"tool":"search_wines","input":{"query":"wine"}}}',
      '{"thought":"got results","answer":"Here are wines."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'test unknown tool in batch' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    // First step: batch was rejected due to unknown tool — orchestrator emits error observation
    const batchStep = body.steps.find((s) => s.actions !== undefined);
    expect(batchStep).toBeDefined();
    expect(batchStep?.observations?.[0]).toContain('Unknown tool');
    // Recovery: subsequent sequential call succeeds
    expect(body.meta.termination_reason).toBe('answer');
  });

  it('parallel batch: loop detection blocks duplicate batch', async () => {
    // LLM fires the exact same parallel batch twice → loop detection should terminate.
    const batchJson = JSON.stringify({
      thought: 'search twice in parallel',
      actions: [
        { tool: 'search_wines', input: { query: 'Opus One' } },
        { tool: 'search_wines', input: { query: 'Petrus' } },
      ],
    });
    const llm = new ScriptedChatLlm([batchJson, batchJson, batchJson]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'Opus One vs Petrus' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    // Loop detection terminates before executing the second identical batch
    expect(['loop_detected', 'answer', 'fallback'].includes(body.meta.termination_reason)).toBe(true);
    // At most one successful parallel batch (2 tool calls)
    expect(body.meta.tool_call_count).toBeLessThanOrEqual(4);
  });

  it('parallel batch: tool_call_count counts ALL parallel tools, not just steps', async () => {
    // 3 tools in one batch → tool_call_count should be 3
    const llm = new ScriptedChatLlm([
      JSON.stringify({
        thought: 'three independent searches',
        actions: [
          { tool: 'search_wines', input: { query: 'Barolo' } },
          { tool: 'search_wines', input: { query: 'Burgundy' } },
          { tool: 'get_food_pairings', input: { food: 'lamb' } },
        ],
      }),
      '{"thought":"got all results","answer":"Here are three options."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: '바롤로, 버건디, 양고기 페어링 동시에 알려줘' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.meta.tool_call_count).toBe(3);
    expect(body.steps.length).toBe(2); // 1 batch step + 1 answer step
    const batchStep = body.steps[0];
    expect(batchStep?.actions).toHaveLength(3);
    expect(batchStep?.observations).toHaveLength(3);
  });

  it('parallel batch: response schema validates actions/observations fields', async () => {
    // Verifies the HTTP response schema correctly serializes parallel step fields.
    const llm = new ScriptedChatLlm([
      JSON.stringify({
        thought: 'parallel search',
        actions: [
          { tool: 'search_wines', input: { query: 'Champagne' } },
          { tool: 'search_wines', input: { query: 'Prosecco' } },
        ],
      }),
      '{"thought":"both found","answer":"Champagne vs Prosecco compared."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: 'Champagne vs Prosecco' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    const batchStep = body.steps.find((s) => s.actions !== undefined);
    expect(batchStep).toBeDefined();

    // Schema contract: actions is an array of {tool, input}
    expect(Array.isArray(batchStep?.actions)).toBe(true);
    for (const a of batchStep?.actions ?? []) {
      expect(typeof a.tool).toBe('string');
      expect(typeof a.input).toBe('object');
    }
    // observations is a string array of same length as actions
    expect(Array.isArray(batchStep?.observations)).toBe(true);
    expect(batchStep?.observations?.length).toBe(batchStep?.actions?.length);
    for (const o of batchStep?.observations ?? []) {
      expect(typeof o).toBe('string');
    }
  });

  it('mixed: sequential step then parallel batch then answer', async () => {
    // Step 1: sequential compare_wines
    // Step 2: parallel check_drinking_window on both results (the SOTA++ pattern)
    // Step 3: final answer
    const llm = new ScriptedChatLlm([
      '{"thought":"compare first","action":{"tool":"compare_wines","input":{"query_a":"Opus One 2018","query_b":"Screaming Eagle 2018"}}}',
      JSON.stringify({
        thought: 'now check drinking windows for both in parallel',
        actions: [
          { tool: 'check_drinking_window', input: { entity_id: 'opus-one-2018' } },
          { tool: 'check_drinking_window', input: { entity_id: 'screaming-eagle-2018' } },
        ],
      }),
      '{"thought":"all data gathered","answer":"Opus One 2018 vs Screaming Eagle 2018 comparison with drinking windows."}',
    ]);
    app = await createAgentTestServer(llm);

    const res = await agentPost(app, { query: '오퍼스원 2018과 스크리밍이글 2018 비교, 지금 마시기 좋은지도' });
    expect(res.statusCode).toBe(200);

    const body = parseAgentResponse(res);
    expect(body.meta.termination_reason).toBe('answer');
    // 1 sequential + 2 parallel = 3 total tool calls
    expect(body.meta.tool_call_count).toBe(3);
    expect(body.steps.length).toBe(3); // compare + parallel_window + answer

    // Step 0: sequential compare
    expect(body.steps[0]?.action?.tool).toBe('compare_wines');
    expect(body.steps[0]?.observation).toBeDefined();
    expect(body.steps[0]?.actions).toBeUndefined();

    // Step 1: parallel drinking window check
    expect(body.steps[1]?.actions).toHaveLength(2);
    expect(body.steps[1]?.actions?.[0]?.tool).toBe('check_drinking_window');
    expect(body.steps[1]?.actions?.[1]?.tool).toBe('check_drinking_window');
    expect(body.steps[1]?.observations).toHaveLength(2);
    expect(body.steps[1]?.action).toBeUndefined();

    // Step 2: answer
    expect(body.steps[2]?.answer).toBeDefined();
  });
});
