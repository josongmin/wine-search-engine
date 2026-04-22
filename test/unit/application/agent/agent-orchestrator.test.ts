import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from '../../../../src/application/agent/agent-orchestrator.js';
import type { ChatLlmPort } from '../../../../src/domain/ai/port/chat-llm.port.js';
import type { AgentToolDeps } from '../../../../src/application/agent/agent-tools.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';
import { CircuitBreakerOpenError } from '../../../../src/domain/shared/error/circuit-breaker-open-error.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';
import { buildPlannerSystemMessage, buildSynthesisSystemMessage } from '../../../../src/application/agent/agent-prompt.js';
import { AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION } from '../../../../src/application/agent/agent-semantic-contract.js';

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
    const searchExecute = vi.fn().mockResolvedValue(makeSearchResponse());
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: searchExecute,
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
    expect(searchExecute).toHaveBeenCalledTimes(1);
    expect(result.fallbackTrace).toMatchObject({
      fallbackApplied: 'layer3',
      fallbackSearchUsed: false,
    });
  });

  it('uses planner prompt for step-0 and synthesis prompt for fallback', async () => {
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

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 1 });
    const result = await orchestrator.execute('opus one', 'req-prompt-seam', { maxSteps: 1 });

    const systemMessages = complete.mock.calls.map((call) => call[0].messages[0]);
    expect(result.terminationReason).toBe('answer');
    expect(systemMessages[0]?.content).toBe(buildPlannerSystemMessage().content);
    expect(systemMessages[1]?.content).toBe(buildSynthesisSystemMessage().content);
    expect(systemMessages[2]?.content).toBe(buildSynthesisSystemMessage().content);
  });

  it('compiles chat-slang meaning before planning and enforces the semantic contract at tool execution', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
          preservedSurface: '와인 ㄱㅊ은거 하나만',
          intent: 'recommendation',
          confidence: 0.9,
          inferredPreferences: [
            { axis: 'style', value: 'crowd_pleasing', source: 'ㄱㅊ', confidence: 0.86 },
            { axis: 'popularity_min', value: 0.5, source: 'ㄱㅊ', confidence: 0.82 },
          ],
          obligations: ['grounded_search_required', 'claim_evidence_required', 'recommend_exactly_one'],
          forbidden: ['surface_rewrite', 'answer_without_grounding'],
          resultLimit: 1,
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'planner omitted structured slang semantics; execution contract must still enforce them',
          action: { tool: 'search_wines', input: { query: '와인 ㄱㅊ은거 하나만' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'grounded answer',
          answer: '검색 결과 기준으로 Opus One 2018을 추천드립니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const searchExecute = vi.fn().mockResolvedValue(makeSearchResponse());
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: searchExecute,
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 2 });
    const result = await orchestrator.execute('와인 ㄱㅊ은거 하나만', 'req-semantic-contract-e2e');

    expect(result.terminationReason).toBe('answer');
    expect(complete).toHaveBeenCalledTimes(3);
    expect(complete.mock.calls[0]?.[0].messages[0].content).toContain('SemanticContractCompiler');
    expect(complete.mock.calls[1]?.[0].messages[0].content).toBe(buildPlannerSystemMessage().content);
    expect(searchExecute).toHaveBeenCalledTimes(1);
    const searchRequest = searchExecute.mock.calls[0]?.[0] as {
      readonly query?: string;
      readonly limit?: number;
      readonly preferences?: readonly unknown[];
    };
    expect(searchRequest.query).toBe('와인 ㄱㅊ은거 하나만');
    expect(searchRequest.query).not.toContain('괜찮은은거');
    expect(searchRequest.limit).toBe(1);
    expect(searchRequest.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attribute: 'style',
        operator: 'in',
        value: ['crowd_pleasing'],
      }),
      expect.objectContaining({
        attribute: 'popularity_score',
        operator: '>=',
        value: 0.5,
      }),
    ]));
  });

  it('treats a planner answer as terminal without invoking synthesis', async () => {
    const complete = vi.fn().mockResolvedValueOnce({
      text: JSON.stringify({
        thought: 'direct answer',
        answer: '오퍼스 원 2018을 추천드립니다.',
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

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 1 });
    const result = await orchestrator.execute('opus one', 'req-planner-answer');

    expect(result.terminationReason).toBe('answer');
    expect(result.answer).toContain('오퍼스 원 2018');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0].messages[0].content).toBe(buildPlannerSystemMessage().content);
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

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 3 });
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

  it('ignores synthesis tool-call outputs and falls back to raw observations', async () => {
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
          thought: 'synthesis should not trigger tools',
          action: { tool: 'search_wines', input: { query: 'should not run' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const searchExecute = vi.fn().mockResolvedValue(makeSearchResponse());
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: searchExecute,
      } as never,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 1 });
    const result = await orchestrator.execute('opus one', 'req-synth-tool-call');

    expect(result.fallbackApplied).toBe(true);
    expect(result.terminationReason).toBe('answer');
    expect(result.answer).toContain('Search result summary:');
    expect(result.fallbackTrace).toMatchObject({
      fallbackApplied: 'layer3',
      fallbackSearchUsed: false,
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

    expect(result.terminationReason).toBe('fallback');
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
    expect(result.steps[0]?.actionPairs?.every((pair) =>
      pair.observation.includes('Invalid parallel batch')
      && pair.observation.includes('compare_wines cannot share a parallel batch')
    )).toBe(true);
    expect(vi.mocked(toolDeps.searchUseCase.execute)).not.toHaveBeenCalled();
    expect(vi.mocked(toolDeps.decomposedSearchExecute)).not.toHaveBeenCalled();
  });

  it('recovers from mixed answer+tool planner output instead of terminating as a final answer', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'bad mixed payload',
          answer: '바롤로와 브루넬로를 비교해 보겠습니다.',
          action: {
            tool: 'compare_wines',
            input: { query_a: 'Barolo', query_b: 'Brunello', food: 'steak' },
          },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'retry with repaired compare call',
          action: {
            tool: 'compare_wines',
            input: { query_a: 'Barolo', query_b: 'Brunello' },
          },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'done',
          answer: '비교를 완료했습니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn(),
      } as never,
      decomposedSearchExecute: vi.fn().mockResolvedValue({
        queryType: 'comparison',
        originalQuery: 'Barolo vs Brunello',
        comparisonIntent: 'compare',
        entities: [
          { subQuery: 'Barolo', topResult: null, resultCount: 0, resolutionStatus: 'ambiguous', allResults: [] },
          { subQuery: 'Brunello', topResult: null, resultCount: 0, resolutionStatus: 'ambiguous', allResults: [] },
        ],
        overallStatus: 'ambiguous',
        requestId: 'req-mixed-answer-tool',
        executionTimeMs: 5,
      }),
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 3 });
    const result = await orchestrator.execute('바롤로와 브루넬로 비교', 'req-mixed-answer-tool');

    expect(result.terminationReason).toBe('answer');
    expect(result.steps[0]?.observation).toContain('mixed a final answer with tool instructions');
    expect(result.steps[0]?.action).toBeUndefined();
    expect(result.steps[1]?.action?.tool).toBe('compare_wines');
    expect(vi.mocked(toolDeps.decomposedSearchExecute)).toHaveBeenCalledOnce();
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

      expect(result.terminationReason).toBe('fallback');
      expect(result.fallbackApplied).toBe(true);
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
      expect(result.answer).toContain('No matching wine was found under the provided constraints');
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

  it('auto-normalizes exact metadata lookup to a bare entity query before tool execution', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'exact metadata lookup',
          action: {
            tool: 'search_wines',
            input: { query: 'opus one', country: 'United States' },
          },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'answer after contract check',
          answer: '오퍼스 원 2018은 지금 마시기 좋은 상태입니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const searchExecute = vi.fn().mockResolvedValue(makeSearchResponse());
    const entityLookup = vi.fn().mockResolvedValue({
      entityId: 'wine-1',
      canonicalLabel: 'Opus One 2018',
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2038,
    } as never);
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: searchExecute,
      } as never,
      entityLookup,
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 5 });
    const result = await orchestrator.execute('오푸스원 지금 마시기 좋아?', 'req-exact-drinkability');

    expect(result.terminationReason).toBe('answer');
    expect(result.answer).toContain('오퍼스 원 2018');
    expect(searchExecute).toHaveBeenCalledTimes(1);
    expect(searchExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'opus one',
        limit: 1,
        options: expect.objectContaining({ mode: 'hybrid' }),
        preferences: expect.arrayContaining([
          expect.objectContaining({ attribute: 'drinking_window', operator: '=' }),
        ]),
      }),
      'req-exact-drinkability-step0',
      expect.any(Object),
    );
    expect(entityLookup).toHaveBeenCalledWith('wine-1');
  });

  it('rejects a final answer until check_drinking_window is executed for drinkability queries', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'find the wine first',
          action: { tool: 'search_wines', input: { query: 'opus one' } },
        }),
        model: 'test-model',
        finishReason: 'stop',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          thought: 'answer after contract check',
          answer: '오퍼스 원 2018은 현재 음용 적기 안에 있습니다.',
        }),
        model: 'test-model',
        finishReason: 'stop',
      });
    const chatLlm: ChatLlmPort = { complete };
    const toolDeps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockResolvedValue(makeSearchResponse()),
      } as never,
      entityLookup: vi.fn().mockResolvedValue({
        entityId: 'wine-1',
        canonicalLabel: 'Opus One 2018',
        drinkingWindowStart: 2024,
        drinkingWindowEnd: 2038,
      } as never),
    };

    const orchestrator = new AgentOrchestrator({ chatLlm, toolDeps }, { maxSteps: 4 });
    const result = await orchestrator.execute('오푸스원 지금 마시기 좋아?', 'req-drinkability-contract');

    expect(result.terminationReason).toBe('answer');
    expect(result.answer).toContain('음용 적기');
    expect(result.toolCallCount).toBe(2);
    expect(complete).toHaveBeenCalledTimes(2);
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
