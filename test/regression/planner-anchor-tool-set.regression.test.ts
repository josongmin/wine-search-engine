/**
 * Regression: `TOOLS_WITH_QUERY_ANCHOR` Set membership in the planner-phase
 * Korean-anchor enforcer.
 *
 * Both `search_wines` and `lookup_wine` route on the literal text of the user's
 * `query`, so the planner-phase sanitizer must restore the original Korean
 * anchor when the LLM paraphrases it into English — for BOTH tools. Before the
 * SOLID-MED extraction this rule was hardcoded to `tool === 'search_wines'`
 * and silently skipped `lookup_wine`, which then issued an English-only Vespa
 * lookup and missed the canonical match.
 *
 * We exercise the public `AgentPlannerPhaseRunner.run` path with a mocked
 * `chatLlm` rather than exporting the private sanitizer, so this test is a
 * faithful integration of how the rule is invoked in production.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentPlannerPhaseRunner } from '../../src/application/agent/agent-planner-phase-runner.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';

const KOREAN_QUERY = '사씨카이아 와인';

describe('TOOLS_WITH_QUERY_ANCHOR — planner-phase Korean anchor enforcement', () => {
  it('restores the Korean anchor on a lookup_wine action that the LLM paraphrased', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: 'entity lookup',
            action: {
              tool: 'lookup_wine',
              input: { query: 'Sassicaia wine' },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });

    const result = await runner.run(
      KOREAN_QUERY,
      'req-lookup-wine-korean-anchor',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.action?.tool).toBe('lookup_wine');
    expect(result?.parsed.action?.input).toEqual({ query: KOREAN_QUERY });
  });

  it('restores the Korean anchor on a lookup_wine inside a parallel actions batch', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: '병렬 lookup + food pairing',
            actions: [
              { tool: 'lookup_wine', input: { query: 'Sassicaia wine' } },
              { tool: 'get_food_pairings', input: { food: 'beef' } },
            ],
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });

    const result = await runner.run(
      KOREAN_QUERY,
      'req-lookup-wine-parallel-korean-anchor',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.actions).toEqual([
      { tool: 'lookup_wine', input: { query: KOREAN_QUERY } },
      { tool: 'get_food_pairings', input: { food: 'beef' } },
    ]);
  });

  it('still restores the Korean anchor for search_wines (regression: do not regress the original behavior)', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: 'search needed',
            action: {
              tool: 'search_wines',
              input: { query: 'Sassicaia wine recommendation' },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });

    const result = await runner.run(
      KOREAN_QUERY,
      'req-search-wines-korean-anchor-still-works',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.action?.tool).toBe('search_wines');
    expect(result?.parsed.action?.input).toEqual({ query: KOREAN_QUERY });
  });

  it('leaves food-pairing-only batches untouched (no anchor rewrite for non-anchor tools)', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: 'pairing only',
            action: { tool: 'get_food_pairings', input: { food: 'lamb' } },
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });

    const result = await runner.run(
      KOREAN_QUERY,
      'req-food-pairing-not-rewritten',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.action).toEqual({
      tool: 'get_food_pairings',
      input: { food: 'lamb' },
    });
  });
});
