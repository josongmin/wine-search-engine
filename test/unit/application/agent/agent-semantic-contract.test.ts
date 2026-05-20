import { describe, expect, it, vi } from 'vitest';
import type { ChatLlmPort } from '../../../../src/domain/ai/port/chat-llm.port.js';
import { buildAgentQueryExecutionContract } from '../../../../src/application/agent/agent-query-execution-contract.js';
import {
  AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
  AgentSemanticContractCompiler,
  mergeAgentSemanticContract,
} from '../../../../src/application/agent/agent-semantic-contract.js';
import { AgentToolExecutionPolicy } from '../../../../src/application/agent/agent-tool-execution-policy.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';

function semanticContractJson(query: string): string {
  return JSON.stringify({
    promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
    preservedSurface: query,
    intent: 'recommendation',
    confidence: 0.91,
    inferredPreferences: [
      { axis: 'style', value: 'crowd_pleasing', source: 'ㄱㅊ', confidence: 0.86 },
      { axis: 'popularity_min', value: 0.5, source: 'ㄱㅊ', confidence: 0.82 },
    ],
    obligations: ['grounded_search_required', 'claim_evidence_required', 'recommend_exactly_one'],
    forbidden: ['surface_rewrite', 'answer_without_grounding'],
    resultLimit: 1,
  });
}

describe('AgentSemanticContractCompiler', () => {
  it('compiles chat slang into typed semantic preferences without rewriting the query surface', async () => {
    const query = '와인 ㄱㅊ은거 하나만';
    const complete = vi.fn().mockResolvedValue({
      text: semanticContractJson(query),
      model: 'test-model',
      finishReason: 'stop',
    });
    const compiler = new AgentSemanticContractCompiler({ complete } as unknown as ChatLlmPort);

    const semanticContract = await compiler.compileIfNeeded({
      query,
      requestId: 'req-semantic-contract',
      deterministicContract: buildAgentQueryExecutionContract(query),
      timeoutMs: 1_000,
      state: createAgentExecutionState(),
    });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(semanticContract).toMatchObject({
      preservedSurface: query,
      inferredPreferences: [
        { axis: 'style', value: 'crowd_pleasing', source: 'ㄱㅊ' },
        { axis: 'popularity_min', value: 0.5, source: 'ㄱㅊ' },
      ],
      resultLimit: 1,
    });
  });

  it('skips the LLM compiler for non-risky plain entity surfaces', async () => {
    const complete = vi.fn();
    const compiler = new AgentSemanticContractCompiler({ complete } as unknown as ChatLlmPort);

    const semanticContract = await compiler.compileIfNeeded({
      query: 'opus one',
      requestId: 'req-semantic-skip',
      deterministicContract: buildAgentQueryExecutionContract('opus one'),
      timeoutMs: 1_000,
      state: createAgentExecutionState(),
    });

    expect(semanticContract).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('merges semantic preferences into execution defaults and enforces them at tool execution', async () => {
    const query = '와인 ㄱㅊ은거 하나만';
    const compiler = new AgentSemanticContractCompiler({
      complete: vi.fn().mockResolvedValue({
        text: semanticContractJson(query),
        model: 'test-model',
        finishReason: 'stop',
      }),
    } as unknown as ChatLlmPort);
    const deterministicContract = buildAgentQueryExecutionContract(query);
    const semanticContract = await compiler.compileIfNeeded({
      query,
      requestId: 'req-semantic-merge',
      deterministicContract,
      timeoutMs: 1_000,
      state: createAgentExecutionState(),
    });
    if (semanticContract === undefined) {
      throw new Error('expected semantic contract');
    }

    const mergedContract = mergeAgentSemanticContract(deterministicContract, semanticContract);
    expect(mergedContract).toMatchObject({
      requiresGroundedWineSearch: true,
      resultLimit: 1,
      searchDefaults: {
        styles: ['crowd_pleasing'],
        popularity_min: 0.5,
      },
    });

    const policy = new AgentToolExecutionPolicy();
    const resolved = policy.resolveSingleTool({
      tool: 'search_wines',
      input: { query },
      queryExecutionContract: mergedContract,
    });

    expect(resolved).toMatchObject({
      query,
      styles: ['crowd_pleasing'],
      popularity_min: 0.5,
      limit: 1,
    });
  });
});
