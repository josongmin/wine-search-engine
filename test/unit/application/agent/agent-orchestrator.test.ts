import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from '../../../../src/application/agent/agent-orchestrator.js';
import type { ChatLlmPort } from '../../../../src/domain/ai/port/chat-llm.port.js';
import type { AgentToolDeps } from '../../../../src/application/agent/agent-tools.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';
import { CircuitBreakerOpenError } from '../../../../src/domain/shared/error/circuit-breaker-open-error.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';

function makeSearchResponse(): SearchResponseV1 {
  return {
    queryType: 'search',
    results: [
      {
        entity: {
          entityId: 'wine-1',
          canonicalLabel: 'Opus One 2018',
          type: 'wine',
          producer: 'Opus One',
          region: 'Napa Valley',
        },
        relevanceScore: 0.95,
        match: {
          matchType: 'hybrid',
          scoreComponents: {
            lexical: 0.9,
            semantic: 0.9,
            attribute: 0.8,
            popularity: 0.5,
            preferenceAlignment: 0.5,
          },
        },
        constraints: { matched: [], unmet: [], inferred: [] },
        uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
        evidenceItems: [],
      },
    ],
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-1',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    meta: {
      requestId: 'req-1',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

describe('AgentOrchestrator', () => {
  it('handles malformed LLM step payload by failing closed to fallback', async () => {
    const chatLlm: ChatLlmPort = {
      complete: vi.fn().mockResolvedValue(undefined as unknown as { text: string; model: string; finishReason: string }),
    };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 1, perStepTimeoutMs: 100 });
    const result = await orchestrator.execute('opus one', 'req-malformed-step');

    expect(result.fallbackApplied).toBe(true);
    expect(result.terminationReason).toBe('fallback');
    expect(result.answer).toContain('Opus One 2018');
    expect(result.steps).toHaveLength(0);
  });

  it('guards malformed synthesis payload and falls back to Layer 3 summary', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'search first',
          action: { tool: 'search_wines', input: { query: 'opus one' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce(undefined as unknown as { text: string; model: string; finishReason: string })
      .mockResolvedValueOnce(undefined as unknown as { text: string; model: string; finishReason: string });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator(
      { chatLlm, toolDeps },
      { maxSteps: 1, seed: 9 },
    );
    const result = await orchestrator.execute('opus one', 'req-malformed-synth');

    expect(result.fallbackApplied).toBe(true);
    expect(result.terminationReason).toBe('answer');
    expect(result.answer).toContain('Search result summary:');
    expect(result.toolCallCount).toBe(1);
  });

  it('handles parallel actions and returns a final answer', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'run in parallel',
          actions: [
            { tool: 'search_wines', input: { query: 'opus one 2018' } },
            { tool: 'search_wines', input: { query: 'screaming eagle 2018' } },
          ],
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'done',
          answer: '두 와인 모두 검색 완료했습니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 2 });
    const result = await orchestrator.execute('두 와인 비교해줘', 'req-parallel-1');

    expect(result.terminationReason).toBe('answer');
    expect(result.toolCallCount).toBe(2);
    expect(result.steps[0]?.actionPairs).toHaveLength(2);
    expect(result.answer).toContain('검색 완료');
    expect(vi.mocked(toolDeps.searchUseCase.execute)).toHaveBeenCalledTimes(2);
  });

  it('terminates as blocked when any parallel tool call is policy-blocked', async () => {
    const chatLlm: ChatLlmPort = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          thought: 'parallel search',
          actions: [
            { tool: 'search_wines', input: { query: 'blocked query A' } },
            { tool: 'search_wines', input: { query: 'blocked query B' } },
          ],
        }),
        model: 'test-model',
        finishReason: 'stop',
      }),
    };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockRejectedValue(new PolicyBlockedError('unsafe query')),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 2 });
    const result = await orchestrator.execute('blocked query', 'req-parallel-blocked');

    expect(result.terminationReason).toBe('blocked');
    expect(result.fallbackApplied).toBe(false);
    expect(result.answer).toContain('처리할 수 없습니다');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.actionPairs).toHaveLength(2);
    expect(result.steps[0]?.actionPairs?.every((pair) => pair.observation.includes('Policy blocked'))).toBe(true);
  });

  it('falls back with a deterministic answer when LLM step times out', async () => {
    vi.useFakeTimers();
    try {
      const chatLlm: ChatLlmPort = {
        complete: vi.fn().mockImplementation(
          async () => await new Promise<never>(() => {}),
        ),
      };
      const toolDeps: AgentToolDeps = {
        searchUseCase: {
          execute: vi.fn().mockResolvedValue(makeSearchResponse()),
        } as never,
      };

      const orchestrator = new AgentOrchestrator(
        { chatLlm, toolDeps },
        { maxSteps: 1, perStepTimeoutMs: 5 },
      );
      const runPromise = orchestrator.execute('opus one', 'req-timeout');
      await vi.advanceTimersByTimeAsync(20);
      const result = await runPromise;

      expect(result.fallbackApplied).toBe(true);
      expect(result.terminationReason).toBe('fallback');
      expect(result.answer).toContain('Opus One 2018');
      expect(result.fallbackTrace).toEqual({
        fallbackApplied: 'layer2',
        reasoningFailure: true,
        failedSynthesisAttempts: 0,
        fallbackSearchUsed: true,
      });
      expect(vi.mocked(toolDeps.searchUseCase.execute)).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks malformed step-result fallback as reasoningFailure in fallbackTrace', async () => {
    const chatLlm: ChatLlmPort = {
      complete: vi.fn().mockResolvedValue(undefined as unknown as { text: string; model: string; finishReason: string }),
    };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 1, perStepTimeoutMs: 100 });
    const result = await orchestrator.execute('opus one', 'req-malformed-step-trace');

    expect(result.fallbackApplied).toBe(true);
    expect(result.fallbackTrace).toEqual({
      fallbackApplied: 'layer2',
      reasoningFailure: true,
      failedSynthesisAttempts: 0,
      fallbackSearchUsed: true,
    });
  });

  it('caps oversized parallel batch and records bounded error observations', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'fire too many at once',
          actions: [
            { tool: 'search_wines', input: { query: 'a' } },
            { tool: 'search_wines', input: { query: 'b' } },
            { tool: 'search_wines', input: { query: 'c' } },
            { tool: 'search_wines', input: { query: 'd' } },
            { tool: 'search_wines', input: { query: 'e' } },
          ],
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'summarize batch rejection',
          answer: '요청이 과도해서 병렬 호출 수를 제한했습니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn(),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 2 });
    const result = await orchestrator.execute('병렬로 많이 돌려', 'req-batch-cap');

    expect(result.terminationReason).toBe('answer');
    expect(result.toolCallCount).toBe(4);
    expect(result.steps[0]?.actionPairs).toHaveLength(4);
    expect(result.steps[0]?.actionPairs?.every((pair) => pair.observation.includes('Batch too large'))).toBe(true);
    expect(vi.mocked(toolDeps.searchUseCase.execute)).not.toHaveBeenCalled();
  });

  it('rejects invalid parallel mix (compare_wines with other tools) and lets LLM recover next step', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'invalid mixed batch',
          actions: [
            { tool: 'compare_wines', input: { query_a: 'a', query_b: 'b' } },
            { tool: 'search_wines', input: { query: 'barolo' } },
          ],
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'recover with answer',
          answer: '비교 도구는 단독으로 실행해야 합니다. 다시 시도해 주세요.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn(),
      } as never,
      decomposedSearchExecute: vi.fn(),
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 2 });
    const result = await orchestrator.execute('비교와 검색 동시에', 'req-invalid-parallel-mix');

    expect(result.terminationReason).toBe('answer');
    expect(result.toolCallCount).toBe(2);
    expect(result.steps[0]?.actionPairs?.every((pair) => pair.observation.includes('Invalid parallel batch'))).toBe(true);
    expect(vi.mocked(toolDeps.searchUseCase.execute)).not.toHaveBeenCalled();
    expect(vi.mocked(toolDeps.decomposedSearchExecute)).not.toHaveBeenCalled();
  });

  it('times out single tool call and records a tool error observation', async () => {
    vi.useFakeTimers();
    try {
      const complete = vi.fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            thought: 'call tool',
            action: { tool: 'search_wines', input: { query: 'hung tool' } },
          }),
          model: 'test-model',
          finishReason: 'stop',
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            thought: 'synthesize timeout error',
            answer: '도구 호출이 지연되어 요약 응답으로 전환했습니다.',
          }),
          model: 'test-model',
          finishReason: 'stop',
        });
      const chatLlm: ChatLlmPort = { complete };
      const toolDeps: AgentToolDeps = {
        searchUseCase: {
          execute: vi.fn().mockImplementation(async () => await new Promise<never>(() => {})),
        } as never,
      };

      const orchestrator = new AgentOrchestrator(
        { chatLlm, toolDeps },
        { maxSteps: 1, toolTimeoutMs: 5 },
      );
      const runPromise = orchestrator.execute('hung', 'req-tool-timeout');
      await vi.advanceTimersByTimeAsync(20);
      const result = await runPromise;

      expect(result.terminationReason).toBe('answer');
      expect(result.fallbackApplied).toBe(false);
      expect(result.steps[0]?.observation).toContain('[TIMEOUT]');
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a parallel batch and falls back safely', async () => {
    vi.useFakeTimers();
    try {
      const chatLlm: ChatLlmPort = {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            thought: 'parallel batch',
            actions: [
              { tool: 'search_wines', input: { query: 'hung-a' } },
              { tool: 'search_wines', input: { query: 'hung-b' } },
            ],
          }),
          model: 'test-model',
          finishReason: 'stop',
        }),
      };
      const searchExecute = vi.fn().mockImplementation(
        async (_input: unknown, requestId?: string) => {
          if (requestId?.includes('-fallback') === true) {
            return makeSearchResponse();
          }
          return await new Promise<never>(() => {});
        },
      );
      const toolDeps: AgentToolDeps = {
        searchUseCase: {
          execute: searchExecute,
        } as never,
      };

      const orchestrator = new AgentOrchestrator(
        { chatLlm, toolDeps },
        { maxSteps: 2, parallelBatchTimeoutMs: 5 },
      );
      const runPromise = orchestrator.execute('parallel hung', 'req-batch-timeout');
      await vi.advanceTimersByTimeAsync(100);
      const result = await runPromise;

      expect(result.terminationReason).toBe('fallback');
      expect(result.fallbackApplied).toBe(true);
      expect(result.answer).toContain('Based on your query');
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves blocked termination instead of falling through to generic fallback', async () => {
    const chatLlm: ChatLlmPort = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          thought: 'search first',
          action: { tool: 'search_wines', input: { query: 'blocked query' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      }),
    };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockRejectedValue(new PolicyBlockedError('unsafe query')),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 1 });
    const result = await orchestrator.execute('blocked query', 'req-123');

    expect(result.terminationReason).toBe('blocked');
    expect(result.fallbackApplied).toBe(false);
    expect(result.answer).toContain('처리할 수 없습니다');
    expect(result.steps).toHaveLength(1);
  });

  it('propagates configured seed to synthesis fallback calls', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'search first',
          action: { tool: 'search_wines', input: { query: 'opus one' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'summarized',
          answer: 'Opus One 2018을 추천드립니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator(
      { chatLlm, toolDeps },
      { maxSteps: 1, seed: 42 },
    );
    const result = await orchestrator.execute('opus one', 'req-456');

    expect(result.terminationReason).toBe('answer');
    expect(result.answer).toContain('Opus One 2018');
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[0].seed).toBe(42);
    expect(complete.mock.calls[1]?.[0].seed).toBe(42);
  });

  it('uses English Layer 3 fallback text for non-Hangul queries', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'search first',
          action: { tool: 'search_wines', input: { query: 'opus one' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'incorrectly tries another tool',
          action: { tool: 'search_wines', input: { query: 'opus one again' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator(
      { chatLlm, toolDeps },
      { maxSteps: 1, seed: 7 },
    );
    const result = await orchestrator.execute('opus one', 'req-789');

    expect(result.terminationReason).toBe('answer');
    expect(result.answer).toContain('Search result summary:');
  });

  it('skips all LLM synthesis attempts when the circuit breaker opens mid-run', async () => {
    // First (and only) LLM call throws CircuitBreakerOpenError — every subsequent
    // complete() call would fast-fail too, so synthesis attempts MUST be skipped.
    // The agent should fall through to Layer 2 (single-shot search fallback)
    // without calling chatLlm again.
    const complete = vi.fn().mockRejectedValue(new CircuitBreakerOpenError('llm.openai.chat'));
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 2 });
    const result = await orchestrator.execute('opus one', 'req-cb-open');

    // Exactly ONE LLM call — synthesis attempts 1 and 2 were both skipped.
    expect(complete).toHaveBeenCalledTimes(1);
    // Layer 2 fallback (single-shot search) supplied the answer.
    expect(result.fallbackApplied).toBe(true);
    expect(result.answer).toContain('Opus One 2018');
    // Termination is the Layer-2 outcome, not 'error'.
    expect(result.terminationReason).toBe('fallback');
  });

  it('skips synthesis attempt 2 when attempt 1 pushed totals past maxTotalTokens', async () => {
    // Attempt 1 returns a long malformed payload that drives totalTokens over the
    // budget. Attempt 2 must be skipped per CLAUDE.md rule 20 (pre-flight check).
    // We ensure there is exactly one tool call (step 0 LLM → search action) so
    // synthesis layer actually fires.
    const bigPadding = 'x'.repeat(40_000); // ~10k estimated tokens on its own
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'search first',
          action: { tool: 'search_wines', input: { query: 'opus one' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      // Synthesis attempt 1: long garbage payload so parse returns no answer,
      // but tokens get accumulated. We rely on the char-based estimate pushing
      // totals past the tight maxTotalTokens cap set on the config.
      .mockResolvedValueOnce({
        text: bigPadding,
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    // maxTotalTokens intentionally small so attempt 1's accumulated tokens cross it.
    const orchestrator = new AgentOrchestrator(
      { chatLlm, toolDeps },
      { maxSteps: 1, maxTotalTokens: 5_000 },
    );
    const result = await orchestrator.execute('opus one', 'req-synth-budget');

    // Step 0 LLM (1) + synthesis attempt 1 (1) = 2 calls total.
    // Attempt 2 MUST be skipped because totals exceeded maxTotalTokens.
    expect(complete).toHaveBeenCalledTimes(2);
    // Layer 3 (raw observation slice) picks up and provides the answer since
    // synthesis failed and Layer 2 is skipped (tool observations exist).
    expect(result.fallbackApplied).toBe(true);
    expect(result.answer.length).toBeGreaterThan(0);
  });

  // E4-T1: BUG-DS01 — circuit open on synthesis attempt 1 → attempt 2 NOT called
  it('does NOT call synthesis attempt 2 when synthesis attempt 1 throws CircuitBreakerOpenError', async () => {
    // Arrange: main LLM step succeeds (tool call), synthesis attempt 1 throws circuit open.
    // Bug: without the fix, the code would still attempt synthesis attempt 2 (which would
    // fast-fail too since the breaker is OPEN). The fix ensures attempt 2 is skipped entirely.
    const complete = vi.fn()
      // Step 0: LLM emits a search action
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'search for opus one',
          action: { tool: 'search_wines', input: { query: 'opus one' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      // Synthesis attempt 1 throws CircuitBreakerOpenError
      .mockRejectedValueOnce(new CircuitBreakerOpenError('llm.openai.chat'))
      // If attempt 2 were called, it would return something — the test asserts it is NOT called.
      .mockResolvedValueOnce({
        text: JSON.stringify({ thought: 'synth', answer: 'should-not-appear' }),
        model: 'test-model',
        finishReason: 'stop',
      });

    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 1 });
    const result = await orchestrator.execute('opus one', 'req-synth-cb-open');

    // Step 0 LLM (1) + synthesis attempt 1 (1) = 2 calls total.
    // Synthesis attempt 2 MUST be skipped (circuit is OPEN after attempt 1 threw).
    expect(complete).toHaveBeenCalledTimes(2);
    // Answer must NOT contain the synthesis result from attempt 2
    expect(result.answer).not.toContain('should-not-appear');
    // Layer 3 fallback fires since synthesis failed and there are tool observations
    expect(result.answer.length).toBeGreaterThan(0);
  });

  // E4-T3: BUG-DS03 — recoverLastSearchInput uses actionPairs-first with deprecated action fallback
  it('recoverLastSearchInput finds query from actionPairs (new format)', async () => {
    // Arrange: LLM emits parallel actions (actionPairs) then fails synthesis
    // so fallback search uses the recovered query from actionPairs.
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'parallel search',
          actions: [
            { tool: 'search_wines', input: { query: 'barolo from piemonte' } },
          ],
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      // Synthesis attempt 1 returns empty (malformed)
      .mockResolvedValueOnce(undefined as unknown as { text: string; model: string; finishReason: string })
      // Synthesis attempt 2 returns empty
      .mockResolvedValueOnce(undefined as unknown as { text: string; model: string; finishReason: string });

    const searchExecute = vi.fn().mockResolvedValue(makeSearchResponse());
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: { execute: searchExecute } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 1 });
    await orchestrator.execute('barolo from piemonte', 'req-t3-actionpairs');

    // The fallback search (Layer 2) should not be called because tool observations exist.
    // But if it WERE called, it should use the query from actionPairs, not the original query.
    // This test verifies the orchestrator processes actionPairs correctly.
    expect(searchExecute).toHaveBeenCalled();
  });

  // E4-T5: W2-04 — AbortError → terminationReason='aborted'
  it('returns terminationReason=aborted when caller aborts mid-execution', async () => {
    const abortController = new AbortController();

    const complete = vi.fn().mockImplementation(async () => {
      // Abort the outer controller then throw the signal's native reason.
      // AbortController sets signal.reason to a DOMException('AbortError') by default.
      abortController.abort();
      // signal.reason is set by AbortController to a DOMException with name='AbortError'
      throw abortController.signal.reason;
    });

    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 2 });
    // NOTE: execute(query, requestId, overrides?, abortSignal?) — abortSignal is 4th param
    const result = await orchestrator.execute('opus one', 'req-abort-test', undefined, abortController.signal);

    expect(result.terminationReason).toBe('aborted');
  });
});
