/**
 * Regression: AgentSemanticContractCompiler.compileIfNeeded must enforce a
 * deterministic validation fence — malformed or schema-invalid LLM output must
 * never propagate as a usable `AgentSemanticContract`. The compiler returns
 * `undefined` in these cases so the deterministic contract is preserved.
 *
 * Why this matters (RFC-016 admission invariant): the planner downstream
 * trusts the typed `AgentSemanticContract` shape. If we leaked an
 * `as DomainType` cast result with `undefined` enum fields, the merge logic
 * (mergeAgentSemanticContract) would synthesize a contract whose
 * `obligations`/`forbidden`/`preservedSurface` fields are silently wrong,
 * corrupting tool selection and obligation enforcement.
 *
 * Invariant under test:
 *   Whenever the LLM emits content that does not satisfy
 *   AgentSemanticContractSchema (or mutates preservedSurface), the compiler
 *   returns exactly `undefined`. Token accounting still happens (so the
 *   budget is honored), and the failure is observable to callers as the
 *   sentinel `undefined` value — NOT a partially populated object.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentSemanticContractCompiler } from '../../src/application/agent/agent-semantic-contract.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { AgentQueryExecutionContract } from '../../src/application/agent/agent-query-execution-contract.js';

const KOREAN_QUERY = 'ㄱㅊ 와인 추천';
const ASCII_QUERY = 'just english';

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

describe('AgentSemanticContractCompiler validation fence', () => {
  it('returns undefined (not a partial object) when LLM emits truncated/malformed JSON', async () => {
    // Truncated JSON: parser can't even finish. The fence must catch this.
    const truncated = '{"promptVersion":"agent-semantic-contract-v1","intent":"recommendation","preferences":';
    const chatLlm = makeChatLlm(truncated);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: KOREAN_QUERY,
      requestId: 'req-fence-malformed-json',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBe(undefined);
    // Tokens still accounted for: LLM was called, budget was spent.
    expect(state.totalInputTokens).toBeGreaterThan(0);
    expect(state.totalOutputTokens).toBeGreaterThan(0);
  });

  it('returns undefined when JSON parses but intent enum is unknown', async () => {
    // Parseable JSON, all required fields present, but `intent` is not in the
    // SEMANTIC_CONTRACT_INTENTS enum. Zod must reject; the fence must return
    // undefined — NOT an object with `intent: undefined` or `intent: <bogus>`.
    const payload = JSON.stringify({
      promptVersion: 'agent-semantic-contract-v1',
      preservedSurface: KOREAN_QUERY,
      intent: 'free_chat', // not in the enum
      confidence: 0.9,
      inferredPreferences: [],
      obligations: [],
      forbidden: [],
    });
    const chatLlm = makeChatLlm(payload);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: KOREAN_QUERY,
      requestId: 'req-fence-bad-intent',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBe(undefined);
    expect(state.totalInputTokens).toBeGreaterThan(0);
    expect(state.totalOutputTokens).toBeGreaterThan(0);
  });

  it('returns undefined when preservedSurface mutates the user query', async () => {
    // Valid schema but the LLM rewrote the surface — RFC-016 requires the
    // surface be preserved verbatim. The fence in compileIfNeeded compares
    // parsed.preservedSurface !== input.query and must reject.
    const payload = JSON.stringify({
      promptVersion: 'agent-semantic-contract-v1',
      preservedSurface: 'rewritten korean query', // mutated
      intent: 'recommendation',
      confidence: 0.9,
      inferredPreferences: [],
      obligations: [],
      forbidden: [],
    });
    const chatLlm = makeChatLlm(payload);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: KOREAN_QUERY,
      requestId: 'req-fence-surface-mutation',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBe(undefined);
    expect(state.totalInputTokens).toBeGreaterThan(0);
    expect(state.totalOutputTokens).toBeGreaterThan(0);
  });

  it('returns undefined for empty LLM response without throwing', async () => {
    // Edge: empty string. JSON.parse throws, fence catches it.
    const chatLlm = makeChatLlm('');
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: KOREAN_QUERY,
      requestId: 'req-fence-empty',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBe(undefined);
    // We still ran the LLM and consumed input tokens; output tokens may be 0
    // because the response is empty and the estimator is ceil(len/4) = 0.
    expect(state.totalInputTokens).toBeGreaterThan(0);
    expect(state.totalOutputTokens).toBe(0);
  });

  it('skips LLM entirely for ASCII-only queries — fence is irrelevant, no compilation attempted', async () => {
    // RFC-016 admission: ASCII-only queries bypass semantic-contract
    // compilation (shouldCompileSemanticContract checks for Korean jamo).
    // The validation fence is effectively N/A here; the compiler returns
    // undefined without invoking the LLM at all.
    const chatLlm = makeChatLlm('irrelevant');
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: ASCII_QUERY,
      requestId: 'req-fence-ascii-skip',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBe(undefined);
    expect(chatLlm.complete).not.toHaveBeenCalled();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
  });

  it('admits a fully valid Korean contract response (positive control for the fence)', async () => {
    // Positive control: when the LLM emits a schema-valid contract whose
    // preservedSurface matches the input query exactly, the fence must let
    // it through. Without this control, a fence that always returned
    // undefined would also satisfy every negative test above.
    const payload = JSON.stringify({
      promptVersion: 'agent-semantic-contract-v1',
      preservedSurface: KOREAN_QUERY,
      intent: 'recommendation',
      confidence: 0.88,
      inferredPreferences: [],
      obligations: ['grounded_search_required'],
      forbidden: [],
    });
    const chatLlm = makeChatLlm(payload);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: KOREAN_QUERY,
      requestId: 'req-fence-positive',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBeDefined();
    expect(result?.intent).toBe('recommendation');
    expect(result?.preservedSurface).toBe(KOREAN_QUERY);
    expect(result?.obligations).toEqual(['grounded_search_required']);
    expect(state.totalInputTokens).toBeGreaterThan(0);
    expect(state.totalOutputTokens).toBeGreaterThan(0);
  });
});
