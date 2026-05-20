/**
 * Regression: AgentSemanticContractCompiler.compileIfNeeded must accumulate
 * its LLM call's input and output tokens into the shared AgentExecutionState
 * counters. Otherwise the run-loop's `maxTotalTokens` guard
 * (agent-run-loop.ts:58-65) is inconsistent — the semantic-contract LLM call
 * can spend tokens that never count against the budget, so a `maxTotalTokens`
 * of 50K is silently exceeded by the contract preamble.
 *
 * Invariant under test:
 *   After `compileIfNeeded(...)` returns (whether the contract parsed OK or
 *   not, as long as an LLM call actually ran), state.totalInputTokens and
 *   state.totalOutputTokens are strictly greater than they were before.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentSemanticContractCompiler } from '../../src/application/agent/agent-semantic-contract.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { AgentQueryExecutionContract } from '../../src/application/agent/agent-query-execution-contract.js';

function makeDeterministicContract(): AgentQueryExecutionContract {
  return {
    requiresDrinkabilityCheck: false,
    hasEntityMetadataSignal: false,
  };
}

function makeChatLlm(responseText: string): ChatLlmPort {
  const complete = vi.fn().mockResolvedValue({
    text: responseText,
    model: 'test-model',
    finishReason: 'stop',
  });
  return { complete } as unknown as ChatLlmPort;
}

describe('AgentSemanticContractCompiler token accounting', () => {
  it('adds input and output tokens to state.totalInputTokens / totalOutputTokens after a real LLM call', async () => {
    // A Korean query forces shouldCompileSemanticContract to return true so
    // the LLM call actually runs. The response need not parse — token
    // accounting must still be performed for any LLM call that consumed
    // budget.
    const responseText = JSON.stringify({
      promptVersion: 'agent-semantic-contract-v1',
      preservedSurface: 'ㄱㅊ 와인 추천',
      intent: 'recommendation',
      confidence: 0.9,
      inferredPreferences: [],
      obligations: [],
      forbidden: [],
    });
    const chatLlm = makeChatLlm(responseText);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);

    const result = await compiler.compileIfNeeded({
      query: 'ㄱㅊ 와인 추천',
      requestId: 'req-token-1',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBeDefined();
    expect(chatLlm.complete).toHaveBeenCalledTimes(1);
    expect(state.totalInputTokens).toBeGreaterThan(0);
    expect(state.totalOutputTokens).toBeGreaterThan(0);
    // The output-token count must reflect the actual response text length.
    // Estimator is `ceil(len/4)`. For our response, ceil(len/4) > 10.
    expect(state.totalOutputTokens).toBeGreaterThanOrEqual(Math.ceil(responseText.length / 4));
  });

  it('still records tokens when the contract response fails to validate', async () => {
    // Even when the response cannot be parsed (and compileIfNeeded returns
    // undefined), the LLM call already consumed budget — accounting MUST
    // still happen.
    const chatLlm = makeChatLlm('this is not JSON');
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: 'ㅈㄴ 매운 ㅋㅋ',
      requestId: 'req-token-2',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBeUndefined();
    expect(chatLlm.complete).toHaveBeenCalledTimes(1);
    expect(state.totalInputTokens).toBeGreaterThan(0);
    expect(state.totalOutputTokens).toBeGreaterThan(0);
  });

  it('does not touch token counters when the query bypasses semantic contract compilation', async () => {
    // Boundary: ASCII-only queries skip compilation entirely
    // (shouldCompileSemanticContract returns false). No LLM call → no
    // tokens added.
    const chatLlm = makeChatLlm('irrelevant');
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: 'just english',
      requestId: 'req-token-3',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBeUndefined();
    expect(chatLlm.complete).not.toHaveBeenCalled();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
  });
});
