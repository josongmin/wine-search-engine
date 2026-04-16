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
