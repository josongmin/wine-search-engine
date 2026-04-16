import { describe, expect, it, vi } from 'vitest';
import {
  AgentAnswerRecoveryPolicy,
  hasToolObservations,
} from '../../../../src/application/agent/agent-answer-recovery-policy.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
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

describe('AgentAnswerRecoveryPolicy', () => {
  it('uses the last search_wines input for layer-2 fallback search and records fallback state', async () => {
    const execute = vi.fn().mockResolvedValue(makeSearchResponse());
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'search first',
      action: { tool: 'search_wines', input: { query: 'opus one 2018' } },
      observation: 'tool crashed before answer',
      durationMs: 3,
      tokenCount: { input: 1, output: 1 },
    });

    const answer = await policy.recoverAnswer('current query', 'req-fallback', state, false);

    expect(execute).toHaveBeenCalledWith(
      { query: 'opus one 2018' },
      'req-fallback-fallback',
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(answer).toContain('Opus One 2018');
    expect(state.fallbackSearchUsed).toBe(true);
    expect(state.fallbackApplied).toBe(true);
    expect(state.fallbackLayer).toBe('layer2');
    expect(state.terminationReason).toBe('fallback');
    expect(state.lastSearchResult?.results[0]?.entity.entityId).toBe('wine-1');
  });

  it('converts the latest tool observation into a final answer when observed output already exists', async () => {
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute: vi.fn() } as never },
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'searched',
      observation: '오퍼스 원 2018은 현재 마시기 좋습니다.',
      durationMs: 3,
      tokenCount: { input: 1, output: 1 },
    });

    const answer = await policy.recoverAnswer('오푸스원 지금 마시기 좋아?', 'req-layer3', state, true);

    expect(hasToolObservations(state)).toBe(true);
    expect(answer).toContain('검색 결과 요약');
    expect(state.fallbackApplied).toBe(true);
    expect(state.fallbackLayer).toBe('layer3');
    expect(state.terminationReason).toBe('answer');
  });

  it('returns the blocked template without running fallback search when policy already blocked the request', async () => {
    const execute = vi.fn();
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = createAgentExecutionState();
    state.policyBlocked = true;

    const answer = await policy.recoverAnswer('blocked query', 'req-blocked', state, false);

    expect(answer).toBe('이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.');
    expect(execute).not.toHaveBeenCalled();
    expect(state.answer).toBe(answer);
    expect(state.fallbackApplied).toBe(false);
  });

  it('falls through to the absolute layer-4 template when fallback search also fails', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('search backend down'));
    const policy = new AgentAnswerRecoveryPolicy({
      toolDeps: { searchUseCase: { execute } as never },
    });
    const state = createAgentExecutionState();

    const answer = await policy.recoverAnswer('query', 'req-layer4', state, false);

    expect(answer).toBe('요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.');
    expect(state.fallbackApplied).toBe(true);
    expect(state.fallbackLayer).toBe('layer4');
    expect(state.terminationReason).toBe('fallback');
  });
});
