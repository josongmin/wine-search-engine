/**
 * Regression tests — EMPTY_ANSWER fallback guarantee.
 *
 * These tests lock runtime behavior, not source text. The goal is to keep the
 * 4-layer fallback contract stable while allowing refactors of the underlying
 * implementation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentObservationSynthesisRunner } from '../../src/application/agent/agent-observation-synthesis-runner.js';
import {
  AgentAnswerRecoveryPolicy,
  hasToolObservations,
} from '../../src/application/agent/agent-answer-recovery-policy.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import {
  getLastGroundingObservationText,
  hasGroundingToolObservations,
} from '../../src/application/agent/agent-grounding-observation-policy.js';
import { AgentOrchestrator } from '../../src/application/agent/agent-orchestrator.js';
import {
  buildPlannerSystemMessage,
  buildSynthesisSystemMessage,
  buildSystemMessage,
} from '../../src/application/agent/agent-prompt.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

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
        relevanceScore: 0.99,
        match: {
          matchType: 'hybrid',
          scoreComponents: {
            lexical: 0.9,
            semantic: 0.9,
            attribute: 0.8,
            popularity: 0.4,
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
      decisionConfidence: 0.92,
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
      queryTimeMs: 11,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

function makeEmptySearchResponse(): SearchResponseV1 {
  return {
    ...makeSearchResponse(),
    results: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EMPTY_ANSWER fallback regression — synthesis timeout contract', () => {
  it('R-EMPTY-01: synthesis runner must not self-abort before 12 seconds', async () => {
    vi.useFakeTimers();
    let llmAborted = false;
    const complete = vi.fn().mockImplementation(async (request: { readonly abortSignal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => {
        request.abortSignal?.addEventListener('abort', () => {
          llmAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    });
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: { complete: complete as unknown as ChatLlmPort['complete'] },
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'searched',
      action: { tool: 'search_wines', input: { query: 'opus one' } },
      observation: 'Found Opus One 2018',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });
    const callerAbort = new AbortController();

    const runPromise = runner.run(
      'opus one',
      'req-timeout-floor',
      DEFAULT_AGENT_CONFIG,
      state,
      callerAbort.signal,
    );

    await vi.advanceTimersByTimeAsync(11_999);
    expect(llmAborted).toBe(false);

    callerAbort.abort();
    await runPromise;
    expect(state.terminationReason).toBe('aborted');
  });
});

describe('EMPTY_ANSWER fallback regression — layered answer recovery', () => {
  it('R-EMPTY-02: Layer 3 uses typed grounding observation selection', async () => {
    const execute = vi.fn();
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'grounded search',
      observation: '오퍼스 원 2018은 현재 마시기 좋습니다.',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'search_wines',
      kind: 'success',
      result: { queryType: 'search', results: [{ entity: { entityId: 'wine-1', canonicalLabel: 'Opus One 2018' } }] },
      durationMs: 1,
    });
    state.steps.push({
      index: 1,
      thought: 'policy violation',
      observation: 'Tool contract violation: wrong entity id',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });
    state.toolOutcomes.push({
      stepId: 'req:1:0',
      tool: 'check_drinking_window',
      kind: 'policy_violation',
      errorMessage: 'wrong entity id',
      durationMs: 1,
    });

    expect(hasGroundingToolObservations(state)).toBe(true);
    expect(getLastGroundingObservationText(state)).toBe('오퍼스 원 2018은 현재 마시기 좋습니다.');

    const answer = await policy.recoverAnswer('오퍼스 원 지금 마실까?', 'req-layer3-typed', state, true);

    expect(answer).toContain('오퍼스 원 2018은 현재 마시기 좋습니다.');
    expect(answer).not.toContain('Tool contract violation');
  });

  it('R-EMPTY-03: Layer 4 returns a non-empty Korean template', async () => {
    const logger = { error: vi.fn() };
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute: vi.fn().mockRejectedValue(new Error('search backend down')) } as never },
      logger,
    });
    const state = createAgentExecutionState();

    const answer = await policy.recoverAnswer('query', 'req-layer4-korean', state, false);

    expect(answer.length).toBeGreaterThan(10);
    expect(answer).toMatch(/[\uAC00-\uD7A3]/);
    expect(state.fallbackApplied).toBe(true);
    expect(state.fallbackLayer).toBe('layer4');
    expect(logger.error).toHaveBeenCalled();
  });

  it('R-EMPTY-04: layer-2 no-result fallback returns a non-empty guidance answer', async () => {
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute: vi.fn().mockResolvedValue(makeEmptySearchResponse()) } as never },
    });
    const state = createAgentExecutionState();

    const answer = await policy.recoverAnswer('오퍼스 원', 'req-layer2-no-result', state, false);

    expect(answer).toContain('검색 결과를 찾지 못했습니다');
    expect(state.fallbackLayer).toBe('layer2');
    expect(state.terminationReason).toBe('fallback');
  });

  it('R-EMPTY-06: fallback search failures are logged at error level', async () => {
    const logger = { error: vi.fn() };
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute: vi.fn().mockRejectedValue(new Error('fallback failed')) } as never },
      logger,
    });
    const state = createAgentExecutionState();

    await policy.recoverAnswer('query', 'req-fallback-log', state, false);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), requestId: 'req-fallback-log' }),
      'agent fallback search failed',
    );
  });

  it('R-EMPTY-07: Layer 4 guarantees answer is never empty after all fallback layers', async () => {
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute: vi.fn().mockRejectedValue(new Error('still broken')) } as never },
    });
    const state = createAgentExecutionState();

    const answer = await policy.recoverAnswer('query', 'req-non-empty-guarantee', state, false);

    expect(answer).not.toBe('');
    expect(state.answer).toBe(answer);
    expect(state.fallbackApplied).toBe(true);
  });

  it('R-EMPTY-08: Layer 3 slices raw observations to 300 chars', async () => {
    const longObservation = '가'.repeat(450);
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute: vi.fn() } as never },
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'searched',
      observation: longObservation,
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });

    const answer = await policy.recoverAnswer('한글 질의', 'req-layer3-slice', state, true);
    const preview = answer.replace('검색 결과 요약: ', '');

    expect(preview).toHaveLength(300);
    expect(preview).toBe(longObservation.slice(0, 300));
  });

  it('R-EMPTY-09: Layer 2 fallback search is skipped when typed tool observations already exist', async () => {
    const execute = vi.fn();
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'searched',
      observation: '오퍼스 원 2018은 현재 마시기 좋습니다.',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });

    const answer = await policy.recoverAnswer('오퍼스 원', 'req-layer2-skip', state, true);

    expect(answer).toContain('검색 결과 요약');
    expect(execute).not.toHaveBeenCalled();
    expect(hasToolObservations(state)).toBe(true);
  });

  it('R-EMPTY-10: Layer 3 terminates as answer when tool observations exist', async () => {
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute: vi.fn() } as never },
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'searched',
      observation: '오퍼스 원 2018은 현재 마시기 좋습니다.',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });

    await policy.recoverAnswer('오퍼스 원', 'req-layer3-answer', state, true);

    expect(state.fallbackLayer).toBe('layer3');
    expect(state.terminationReason).toBe('answer');
  });

  it('R-EMPTY-11: Layer 4 terminates as answer when tool observations existed but no grounding text remained', async () => {
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute: vi.fn().mockRejectedValue(new Error('fallback failed')) } as never },
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'search timeout',
      observation: '[TIMEOUT] search timed out',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });
    state.toolOutcomes.push({
      stepId: 'req:0:0',
      tool: 'search_wines',
      kind: 'timeout',
      errorMessage: '[TIMEOUT] search timed out',
      durationMs: 1,
    });

    await policy.recoverAnswer('오퍼스 원', 'req-layer4-answer', state, true);

    expect(state.fallbackLayer).toBe('layer4');
    expect(state.terminationReason).toBe('answer');
  });
});

describe('EMPTY_ANSWER fallback regression — logging and prompt seam', () => {
  it('R-EMPTY-05: synthesis failures log at error level, not warn level', async () => {
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('attempt1 failed'))
      .mockRejectedValueOnce(new Error('attempt2 failed'));
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: { complete } as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'searched',
      action: { tool: 'search_wines', input: { query: 'opus one' } },
      observation: 'Found Opus One 2018',
      durationMs: 1,
      tokenCount: { input: 1, output: 1 },
    });

    await runner.run('opus one', 'req-synth-log', DEFAULT_AGENT_CONFIG, state);

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/synthesis retry attempt [12] failed/),
    );
  });

  it('R-EMPTY-12: planner/synthesis/system prompt builders stay distinct at runtime', () => {
    expect(buildPlannerSystemMessage().content).toContain('Cuvee StepPlanner');
    expect(buildSynthesisSystemMessage().content).toContain('Cuvee StepSynthesis');
    expect(buildSystemMessage().content).toBe(buildPlannerSystemMessage().content);
    expect(buildPlannerSystemMessage().content).not.toBe(buildSynthesisSystemMessage().content);
  });

  it('R-EMPTY-13: orchestrator uses planner prompt first and synthesis prompt on fallback synthesis', async () => {
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
    const orchestrator = new AgentOrchestrator(
      {
        chatLlm: { complete } as unknown as ChatLlmPort,
        toolDeps: {
          searchUseCase: {
            execute: vi.fn().mockResolvedValue(makeSearchResponse()),
          } as never,
        },
      },
      { maxSteps: 1 },
    );

    await orchestrator.execute('opus one', 'req-prompt-seam-regression', { maxSteps: 1 });

    const systemMessages = complete.mock.calls.map((call) => call[0].messages[0]?.content);
    expect(systemMessages[0]).toBe(buildPlannerSystemMessage().content);
    expect(systemMessages[1]).toBe(buildSynthesisSystemMessage().content);
    expect(systemMessages[2]).toBe(buildSynthesisSystemMessage().content);
  });
});
