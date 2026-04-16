import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentPlannerPhaseRunner } from '../../../../src/application/agent/agent-planner-phase-runner.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../../../src/domain/agent/model/agent-config.js';
import type { ChatLlmPort } from '../../../../src/domain/ai/port/chat-llm.port.js';
import { CircuitBreakerOpenError } from '../../../../src/domain/shared/error/circuit-breaker-open-error.js';

describe('AgentPlannerPhaseRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fails closed on malformed llm results', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: { complete: vi.fn().mockResolvedValue(undefined) } as unknown as ChatLlmPort,
    });
    const state = createAgentExecutionState();

    const result = await runner.run(
      'opus one',
      'req-malformed',
      DEFAULT_AGENT_CONFIG,
      state,
      3,
      false,
    );

    expect(result).toBeNull();
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.terminationReason).toBe('error');
  });

  it('marks already-aborted planner calls as aborted without invoking the llm', async () => {
    const complete = vi.fn();
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: { complete } as unknown as ChatLlmPort,
    });
    const state = createAgentExecutionState();
    const abortController = new AbortController();
    abortController.abort();

    const result = await runner.run(
      'opus one',
      'req-pre-aborted',
      DEFAULT_AGENT_CONFIG,
      state,
      3,
      false,
      abortController.signal,
    );

    expect(result).toBeNull();
    expect(state.terminationReason).toBe('aborted');
    expect(complete).not.toHaveBeenCalled();
  });

  it('marks timeout and llm timeout stats when a planner step exceeds budget', async () => {
    vi.useFakeTimers();
    const complete = vi.fn().mockImplementation(async () => {
      await new Promise(() => {});
    });
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: { complete } as unknown as ChatLlmPort,
    });
    const state = createAgentExecutionState();

    const runPromise = runner.run(
      'opus one',
      'req-timeout',
      { ...DEFAULT_AGENT_CONFIG, perStepTimeoutMs: 5 },
      state,
      3,
      false,
    );

    await vi.advanceTimersByTimeAsync(10);
    const result = await runPromise;

    expect(result).toBeNull();
    expect(state.timeoutStats.llmStep).toBe(1);
    expect(state.terminationReason).toBe('timeout');
    expect(state.reasoningFailureDetected).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('marks circuit-open failures explicitly', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: { complete: vi.fn().mockRejectedValue(new CircuitBreakerOpenError('llm.openai.chat')) } as unknown as ChatLlmPort,
    });
    const state = createAgentExecutionState();

    const result = await runner.run(
      'opus one',
      'req-circuit-open',
      DEFAULT_AGENT_CONFIG,
      state,
      3,
      false,
    );

    expect(result).toBeNull();
    expect(state.llmCircuitOpen).toBe(true);
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.terminationReason).toBe('error');
  });

  it('terminates the planner phase when token budget is exceeded after a valid llm response', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({ thought: 'done', answer: 'Opus One 2018입니다.' }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });
    const state = createAgentExecutionState();

    const result = await runner.run(
      'opus one',
      'req-budget',
      { ...DEFAULT_AGENT_CONFIG, maxTotalTokens: 1 },
      state,
      3,
      false,
    );

    expect(result).toBeNull();
    expect(state.terminationReason).toBe('budget');
    expect(state.totalInputTokens + state.totalOutputTokens).toBeGreaterThanOrEqual(1);
  });

  it('uses a lower output cap for non-last planner steps', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ thought: 'search', action: { tool: 'search_wines', input: { query: 'opus one' } } }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: { complete } as unknown as ChatLlmPort,
    });

    await runner.run(
      'opus one',
      'req-output-cap-default',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 1024,
    }));
  });

  it('restores Korean search query anchors when the planner drifts into English paraphrase', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: '검색 필요',
            action: {
              tool: 'search_wines',
              input: {
                query: 'gift recommendation for someone who does not know wine',
                styles: ['approachable', 'crowd_pleasing'],
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });

    const result = await runner.run(
      '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
      'req-korean-anchor',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.action?.tool).toBe('search_wines');
    expect(result?.parsed.action?.input).toEqual(expect.objectContaining({
      query: '와인 잘 모르는 사람한테 선물할 거, 실패 없는 걸로',
      styles: ['approachable', 'crowd_pleasing'],
    }));
  });

  it('keeps a higher output cap on the last step to allow final answers', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ thought: 'done', answer: '오퍼스 원 2018입니다.' }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: { complete } as unknown as ChatLlmPort,
    });

    await runner.run(
      'opus one',
      'req-output-cap-last-step',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      1,
      true,
    );

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      maxOutputTokens: 1536,
    }));
  });

  it('renders and clears typed planner directives in the next planner call', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify({ thought: 'search', action: { tool: 'search_wines', input: { query: 'opus one' } } }),
      model: 'test-model',
      finishReason: 'stop',
    });
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: { complete } as unknown as ChatLlmPort,
    });
    const state = createAgentExecutionState();
    state.pendingPlannerDirective = { kind: 'pending_drinkability_check', entityIds: ['wine-1'] };

    await runner.run(
      'opus one 지금 마시기 좋아?',
      'req-directive',
      DEFAULT_AGENT_CONFIG,
      state,
      3,
      false,
    );

    const messages = complete.mock.calls[0]?.[0].messages ?? [];
    expect(messages[1]?.content).toContain('[DRINKABILITY_PENDING]');
    expect(messages[1]?.content).toContain('"wine-1"');
    expect(state.pendingPlannerDirective).toBeUndefined();
  });
});
