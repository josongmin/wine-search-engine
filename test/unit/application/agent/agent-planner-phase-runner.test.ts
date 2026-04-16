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

  it('drops mixed retrieval overrides for anchorless recommendation queries', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: '선물 추천 검색',
            action: {
              tool: 'search_wines',
              input: {
                query: '와인 입문자 선물용 달달하면서 도수 낮은 거, 예쁜 라벨',
                retrieval_mode: 'mixed',
                styles: ['approachable', 'crowd_pleasing', 'sweet'],
                max_alcohol_pct: 12,
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });

    const result = await runner.run(
      '와인 입문자 선물용 달달하면서 도수 낮은 거, 예쁜 라벨',
      'req-drop-mixed-anchorless',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.action?.tool).toBe('search_wines');
    expect(result?.parsed.action?.input).toEqual(expect.objectContaining({
      query: '와인 입문자 선물용 달달하면서 도수 낮은 거, 예쁜 라벨',
      styles: ['approachable', 'crowd_pleasing', 'sweet'],
      max_alcohol_pct: 12,
    }));
    expect(result?.parsed.action?.input).not.toHaveProperty('retrieval_mode');
  });

  it('preserves mixed retrieval overrides for anchored mixed-query searches', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: '오퍼스원 anchor 기반 mixed 검색',
            action: {
              tool: 'search_wines',
              input: {
                query: '오퍼스원 같은 와인 추천',
                retrieval_mode: 'mixed',
                styles: ['approachable'],
              },
            },
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });

    const result = await runner.run(
      '오퍼스원 같은 와인 추천',
      'req-keep-mixed-anchored',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.action?.tool).toBe('search_wines');
    expect(result?.parsed.action?.input).toEqual(expect.objectContaining({
      query: '오퍼스원 같은 와인 추천',
      retrieval_mode: 'mixed',
      styles: ['approachable'],
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

  it('clamps parallel red/white per-slot searches to exact cardinality for "한 병씩" queries', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: '커플 선물용으로 레드/화이트 각각 검색',
            actions: [
              {
                tool: 'search_wines',
                input: {
                  query: '커플 세트로 레드 화이트 한 병씩, 예쁜 거',
                  wine_type: 'red',
                  limit: 3,
                  want_diversity: true,
                },
              },
              {
                tool: 'search_wines',
                input: {
                  query: '커플 세트로 레드 화이트 한 병씩, 예쁜 거',
                  wine_type: 'white',
                  limit: 3,
                  want_diversity: true,
                },
              },
            ],
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });

    const result = await runner.run(
      '커플 세트로 레드 화이트 한 병씩, 예쁜 거',
      'req-couple-gift-cardinality',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.actions).toEqual([
      {
        tool: 'search_wines',
        input: expect.objectContaining({
          wine_type: 'red',
          limit: 1,
          want_diversity: false,
        }),
      },
      {
        tool: 'search_wines',
        input: expect.objectContaining({
          wine_type: 'white',
          limit: 1,
          want_diversity: false,
        }),
      },
    ]);
  });

  it('splits a single broad search into red/white exact-count parallel searches for pair-set queries', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: '커플 선물 세트 검색',
            action: {
              tool: 'search_wines',
              input: {
                query: '커플 세트로 레드 화이트 한 병씩, 예쁜 거',
                limit: 4,
                want_diversity: true,
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
      '커플 세트로 레드 화이트 한 병씩, 예쁜 거',
      'req-couple-gift-split',
      DEFAULT_AGENT_CONFIG,
      createAgentExecutionState(),
      3,
      false,
    );

    expect(result?.parsed.action).toBeUndefined();
    expect(result?.parsed.actions).toEqual([
      {
        tool: 'search_wines',
        input: expect.objectContaining({
          wine_type: 'red',
          limit: 1,
          want_diversity: false,
          styles: ['approachable', 'crowd_pleasing'],
        }),
      },
      {
        tool: 'search_wines',
        input: expect.objectContaining({
          wine_type: 'white',
          limit: 1,
          want_diversity: false,
          styles: ['approachable', 'crowd_pleasing'],
        }),
      },
    ]);
  });

  it('fails closed on JSON-like but unparseable planner output so recovery can run', async () => {
    const runner = new AgentPlannerPhaseRunner({
      chatLlm: {
        complete: vi.fn().mockResolvedValue({
          text: '{"thought":"검색","action":{"tool":"search_wines","input":{"query":"결혼기념일"}}\n{"thought":"검색 시작"}',
          model: 'test-model',
          finishReason: 'stop',
        }),
      } as unknown as ChatLlmPort,
    });
    const state = createAgentExecutionState();

    const result = await runner.run(
      '결혼기념일 디너 와인 추천',
      'req-json-like-malformed',
      DEFAULT_AGENT_CONFIG,
      state,
      3,
      false,
    );

    expect(result).toBeNull();
    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.terminationReason).toBe('error');
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
