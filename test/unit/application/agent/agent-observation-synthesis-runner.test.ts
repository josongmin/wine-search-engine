import { describe, expect, it, vi } from 'vitest';
import { AgentObservationSynthesisRunner } from '../../../../src/application/agent/agent-observation-synthesis-runner.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../../../src/domain/agent/model/agent-config.js';
import type { ChatLlmPort } from '../../../../src/domain/ai/port/chat-llm.port.js';
import { CircuitBreakerOpenError } from '../../../../src/domain/shared/error/circuit-breaker-open-error.js';

function makeObservedState() {
  const state = createAgentExecutionState();
  state.steps.push({
    index: 0,
    thought: 'searched',
    action: { tool: 'search_wines', input: { query: 'opus one' } },
    observation: 'Found Opus One 2018 in Napa Valley for 420000원',
    durationMs: 10,
    tokenCount: { input: 10, output: 10 },
  });
  state.toolOutcomes.push({
    stepId: 'req:0:0',
    tool: 'search_wines',
    kind: 'success',
    result: {
      queryType: 'search',
      results: [{ entity: { entityId: 'wine-1', canonicalLabel: 'Opus One 2018' } }],
    },
    durationMs: 10,
  });
  return state;
}

/**
 * RC3 high-fan-out fixture: 3 grounded outcomes (compare 3 vintages + drinking
 * window class). Each step carries a grounding observation; toolOutcomes hold
 * 3 successful grounded legs (≥ HIGH_FAN_OUT_GROUNDED_OUTCOME_THRESHOLD).
 */
function makeHighFanOutState() {
  const state = createAgentExecutionState();
  const vintages = [2016, 2018, 2020];
  vintages.forEach((vintage, i) => {
    state.steps.push({
      index: i,
      thought: `searched vintage ${vintage}`,
      action: { tool: 'search_wines', input: { query: `opus one ${vintage}` } },
      observation:
        `[Tool Result: search_wines]\n${i + 1}. Opus One ${vintage} | (id: opus-${vintage}) | region: Napa | vintage: ${vintage} | price: ₩420,000 | drink: ${vintage + 5}-${vintage + 20}\n` +
        `GROUNDING_JSON: {"query_type":"search","wines":[{"entity_id":"opus-${vintage}","canonical_label":"Opus One ${vintage}","vintage":${vintage},"region":"Napa"}]}`,
      durationMs: 10,
      tokenCount: { input: 10, output: 10 },
    });
    state.toolOutcomes.push({
      stepId: `req:${i}:0`,
      tool: 'search_wines',
      kind: 'success',
      result: {
        queryType: 'search',
        results: [{ entity: { entityId: `opus-${vintage}`, canonicalLabel: `Opus One ${vintage}` } }],
      },
      durationMs: 10,
    });
  });
  return state;
}

describe('AgentObservationSynthesisRunner', () => {
  it('synthesizes a final answer and updates token counters', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        thought: 'summarize',
        answer: '오퍼스 원 2018을 추천합니다. 나파 밸리 스타일입니다.',
      }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();

    await runner.run('opus one', 'req-synth-success', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toContain('오퍼스 원 2018');
    expect(state.terminationReason).toBe('answer');
    expect(state.failedSynthesisAttempts).toBe(0);
    expect(state.totalInputTokens).toBeGreaterThan(0);
    expect(state.totalOutputTokens).toBeGreaterThan(0);
    expect(complete).toHaveBeenCalledTimes(1);
    const messages = complete.mock.calls[0]?.[0].messages ?? [];
    expect(messages.some((message) => message.content.includes('[Typed Tool Outcomes]'))).toBe(false);
    expect(messages.some((message) => message.role === 'assistant')).toBe(false);
    expect(messages.some((message) => message.content.includes('[Tool Result: search_wines]'))).toBe(true);
  });

  it('retries malformed synthesis twice and leaves fallback layers to finish', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ text: '{}', model: 'test-model', finishReason: 'stop' });
    const chatLlm: ChatLlmPort = { complete: complete as unknown as ChatLlmPort['complete'] };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();

    await runner.run('opus one', 'req-synth-malformed', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toBe('');
    expect(state.terminationReason).toBe('max_steps');
    expect(state.failedSynthesisAttempts).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('rejects synthesis tool-call output and accepts second-attempt answer', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'call again',
          action: { tool: 'search_wines', input: { query: 'opus one' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'done',
          answer: '도구 재호출 없이 오퍼스 원 2018을 요약합니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();

    await runner.run('opus one', 'req-synth-tool-call', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toContain('오퍼스 원 2018');
    expect(state.terminationReason).toBe('answer');
    expect(state.failedSynthesisAttempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('accepts explicit short final answers without length-based gating', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        thought: 'short grounded answer',
        answer: '가능합니다.',
      }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();

    await runner.run('opus one 지금 마셔도 돼?', 'req-synth-short-answer', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toBe('가능합니다.');
    expect(state.terminationReason).toBe('answer');
    expect(state.failedSynthesisAttempts).toBe(0);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('rejects JSON shells without an explicit answer field', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({ text: '{}', model: 'test-model', finishReason: 'stop' })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'second attempt',
          answer: '오퍼스 원 2018 관측 결과를 기준으로 답변합니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();

    await runner.run('opus one', 'req-synth-json-shell', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toContain('오퍼스 원 2018');
    expect(state.terminationReason).toBe('answer');
    expect(state.failedSynthesisAttempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('marks llm circuit-open and stops retrying when synthesis throws breaker-open', async () => {
    const complete = vi.fn().mockRejectedValue(new CircuitBreakerOpenError('llm.openai.chat'));
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();

    await runner.run('opus one', 'req-synth-cb-open', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toBe('');
    expect(state.llmCircuitOpen).toBe(true);
    expect(state.failedSynthesisAttempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('marks aborted synthesis and does not retry when the caller aborts mid-call', async () => {
    const abortController = new AbortController();
    const complete = vi.fn().mockImplementation(async (request: { readonly abortSignal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        request.abortSignal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
        abortController.abort();
      });
    });
    const chatLlm: ChatLlmPort = { complete: complete as unknown as ChatLlmPort['complete'] };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();

    await runner.run('opus one', 'req-synth-abort', DEFAULT_AGENT_CONFIG, state, abortController.signal);

    expect(state.answer).toBe('');
    expect(state.terminationReason).toBe('aborted');
    expect(state.failedSynthesisAttempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not retry synthesis when attempt 1 throws a non-abort error', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('provider timeout'));
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();

    await runner.run('opus one', 'req-synth-provider-error', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toBe('');
    expect(state.failedSynthesisAttempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('includes typed tool outcomes only when a non-success tool result exists', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        thought: 'recover',
        answer: '검색 결과 기준으로 일부 도구 실패가 있었지만 오퍼스 원 2018은 확인됐습니다.',
      }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeObservedState();
    state.toolOutcomes.push({
      stepId: 'req:1:0',
      tool: 'check_drinking_window',
      kind: 'tool_error',
      errorMessage: 'Tool "check_drinking_window" timed out',
      durationMs: 25,
    });

    await runner.run('opus one', 'req-synth-tool-error', DEFAULT_AGENT_CONFIG, state);

    const messages = complete.mock.calls[0]?.[0].messages ?? [];
    expect(messages.some((message) => message.content.includes('[Typed Tool Outcomes]'))).toBe(true);
    expect(messages.some((message) => message.content.includes('"kind":"tool_error"'))).toBe(true);
  });

  it('short-circuits synthesis when all search outcomes are empty and emits fallback answer', async () => {
    const complete = vi.fn();
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'searched',
      action: { tool: 'search_wines', input: { query: 'white wine' } },
      observation: '검색 결과가 없습니다.',
      durationMs: 10,
      tokenCount: { input: 10, output: 10 },
    });
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'search_wines',
      kind: 'success',
      result: { queryType: 'search', results: [] },
      durationMs: 10,
    });

    await runner.run('화이트 와인 알려줘', 'req-synth-no-match', DEFAULT_AGENT_CONFIG, state);

    expect(complete).not.toHaveBeenCalled();
    expect(state.answer).toContain('검색 결과를 찾지 못했습니다');
    expect(state.failedSynthesisAttempts).toBe(1);
    expect(state.terminationReason).toBe('fallback');
    expect(state.fallbackApplied).toBe(true);
    expect(state.fallbackLayer).toBe('layer3');
    expect(state.reasoningFailureDetected).toBe(true);
  });

  // ── RC3: high-fan-out synthesis robustness ──────────────────────────────

  it('produces a non-empty structured answer on high fan-out (3 grounded outcomes)', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        thought: 'compare three vintages',
        answer: '오퍼스 원 2016은 피크에 도달했고, 2018은 곧 마시기 좋으며, 2020은 더 숙성이 필요합니다. 세 빈티지 모두 나파 밸리산입니다.',
      }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeHighFanOutState();

    await runner.run('오퍼스 원 2016 2018 2020 비교하고 음용 시기 알려줘', 'req-synth-fanout-ok', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer.length).toBeGreaterThanOrEqual(40);
    expect(state.terminationReason).toBe('answer');
    expect(state.failedSynthesisAttempts).toBe(0);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('rejects a collapsed near-empty answer on high fan-out and retries with the structured per-entity prompt', async () => {
    const complete = vi.fn()
      // Attempt 1: collapsed 1-word answer despite 3 grounded outcomes.
      .mockResolvedValueOnce({
        text: JSON.stringify({ thought: 'collapse', answer: '좋습니다.' }),
        model: 'test-model',
        finishReason: 'stop',
      })
      // Attempt 2 (structured retry): full per-entity answer.
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'structured',
          answer: '오퍼스 원 2016 (나파, 음용 적기), 2018 (나파, 곧 적기), 2020 (나파, 숙성 필요)을 각각 정리했습니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeHighFanOutState();

    await runner.run('오퍼스 원 세 빈티지 비교', 'req-synth-fanout-collapse-recover', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toContain('2016');
    expect(state.answer).toContain('2020');
    expect(state.terminationReason).toBe('answer');
    expect(state.failedSynthesisAttempts).toBe(1);
    expect(complete).toHaveBeenCalledTimes(2);
    // The structured retry must carry the per-entity directive, not the default sentinel.
    const retryMessages = complete.mock.calls[1]?.[0].messages ?? [];
    expect(retryMessages.some((m) => m.content.includes('STRUCTURED_FINAL_ANSWER_REQUIRED'))).toBe(true);
    expect(retryMessages.some((m) => m.content.includes('summarizes EACH wine/vintage'))).toBe(true);
  });

  it('does NOT terminate as answer when high-fan-out synthesis collapses on both attempts (leaves recovery to orchestrator)', async () => {
    // Both attempts return collapsed near-empty answers → never accepted.
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ thought: 'collapse', answer: '네.' }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeHighFanOutState();

    await runner.run('오퍼스 원 세 빈티지 비교', 'req-synth-fanout-collapse', DEFAULT_AGENT_CONFIG, state);

    // Collapsed answers rejected on both attempts → answer stays empty so the
    // orchestrator's Layer-3 structured grounding preview can recover.
    expect(state.answer).toBe('');
    expect(state.terminationReason).not.toBe('answer');
    expect(state.failedSynthesisAttempts).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('budgets observation context to maxContextChars while preserving grounding-bearing observations', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        thought: 'ok',
        answer: '오퍼스 원 2016, 2018, 2020 세 빈티지를 나파 밸리 기준으로 비교해 정리했습니다.',
      }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const chatLlm: ChatLlmPort = { complete };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });
    const state = makeHighFanOutState();
    // Tight budget that cannot hold all three observation messages.
    const tightConfig = { ...DEFAULT_AGENT_CONFIG, maxContextChars: 220 };

    await runner.run('오퍼스 원 세 빈티지 비교', 'req-synth-fanout-budget', tightConfig, state);

    const messages = complete.mock.calls[0]?.[0].messages ?? [];
    const toolResultMessages = messages.filter((m) => m.content.includes('[Tool Result: search_wines]'));
    // Budget enforced: not all three observations included.
    expect(toolResultMessages.length).toBeLessThan(3);
    expect(toolResultMessages.length).toBeGreaterThanOrEqual(1);
    // Grounding payload preserved in whatever was kept.
    expect(toolResultMessages.some((m) => m.content.includes('GROUNDING_JSON'))).toBe(true);
  });

  it('skips synthesis when token budget is already exhausted or no observation exists', async () => {
    const complete = vi.fn();
    const chatLlm: ChatLlmPort = { complete: complete as unknown as ChatLlmPort['complete'] };
    const runner = new AgentObservationSynthesisRunner({ chatLlm });

    const budgetExhausted = makeObservedState();
    budgetExhausted.totalInputTokens = DEFAULT_AGENT_CONFIG.maxTotalTokens;
    await runner.run('opus one', 'req-synth-budget-skip', DEFAULT_AGENT_CONFIG, budgetExhausted);

    const noObservation = createAgentExecutionState();
    noObservation.steps.push({
      index: 0,
      thought: 'searched',
      action: { tool: 'search_wines', input: { query: 'opus one' } },
      observation: '',
      durationMs: 10,
      tokenCount: { input: 10, output: 10 },
    });
    await runner.run('opus one', 'req-synth-no-observation', DEFAULT_AGENT_CONFIG, noObservation);

    expect(complete).not.toHaveBeenCalled();
    expect(budgetExhausted.answer).toBe('');
    expect(noObservation.answer).toBe('');
  });
});
