/**
 * Property-based regression for AgentSemanticContractCompiler.
 *
 * Pushes feature `agent.semantic-contract-compiler` from maturity 4 to 5 by
 * exercising the validation fence + calibrated abstention threshold over a
 * randomized population of LLM outputs (fast-check, numRuns: 100), rather
 * than the small enumerated cases the prior fence regression covered.
 *
 * Properties:
 *  1. Zod validation fence is idempotent — invalid LLM output always yields
 *     `undefined`; repeated calls with the same invalid payload produce the
 *     same sentinel and never partially-pollute the AgentExecutionState
 *     beyond strict, monotonic token accounting.
 *  2. Token accounting precedes validation — for any valid/invalid mix,
 *     state.totalInputTokens is strictly monotonically increasing per
 *     compileIfNeeded call (LLM was actually invoked and budget consumed).
 *  3. Korean query intent stability — Korean queries arrive in NFC and the
 *     preservedSurface returned (when admitted) is exactly the NFC input
 *     verbatim (rule 5, 8 from CLAUDE.md).
 *  4. Surface preservation — when validated, `preservedSurface` MUST equal
 *     the input query exactly, byte-for-byte. RFC-016 admission invariant.
 *  5. Calibrated abstention threshold — outputs whose top-level `confidence`
 *     is below MIN_CONFIDENCE_THRESHOLD are rejected by the fence, even
 *     when otherwise schema-valid. (Selective prediction, Mozannar et al.,
 *     NeurIPS 2020.) The threshold MUST be a named module-scope constant.
 *  6. Empty preference list is valid — `inferredPreferences: []` is an
 *     admissible contract shape and does not cause rejection.
 *
 * Plus specific corner cases:
 *  - Multi-intent capable contract (recommendation + food_pairing context):
 *    the chosen intent enum value is honored verbatim, obligations include
 *    grounded_search_required, and merge produces requiresGroundedWineSearch.
 *  - Empty query — admission rejects before the LLM call (no compile
 *    attempted for ASCII whitespace-only / empty input).
 *  - Mocked LLM returns schema-valid JSON with EXTRA unknown keys at the
 *    top level — Zod `.strict()` rejects, fence returns undefined.
 *
 * Append-only.
 */

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import {
  AgentSemanticContractCompiler,
  AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
  MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD,
  mergeAgentSemanticContract,
} from '../../src/application/agent/agent-semantic-contract.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { AgentQueryExecutionContract } from '../../src/application/agent/agent-query-execution-contract.js';

const KOREAN_QUERY_BASE = 'ㄱㅊ 와인 추천';

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

// Build a Korean query containing at least one Hangul jamo so the
// admission gate (shouldCompileSemanticContract) triggers the LLM path.
const koreanQueryArb = fc
  .string({ minLength: 0, maxLength: 12, unit: 'grapheme' })
  .map((suffix) => `${KOREAN_QUERY_BASE} ${suffix}`.normalize('NFC'));

// Arbitrary malformed payloads: parses but fails Zod, or fails JSON.parse.
const malformedPayloadArb = fc.oneof(
  fc.constant(''), // empty
  fc.constant('not json at all'),
  fc.constant('{'), // truncated
  fc.constant('{"promptVersion":"agent-semantic-contract-v1"'), // truncated mid
  fc.constant('null'), // valid JSON, fails schema
  fc.constant('[]'),
  fc.constant('"a string"'),
  fc.constant('42'),
  // Valid JSON shape but missing required fields:
  fc.constant(JSON.stringify({ promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION })),
  // Unknown intent enum:
  fc.constant(
    JSON.stringify({
      promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
      preservedSurface: KOREAN_QUERY_BASE,
      intent: 'free_chat',
      confidence: 0.9,
      inferredPreferences: [],
      obligations: [],
      forbidden: [],
    }),
  ),
  // Extra unknown top-level key — strict() rejects:
  fc.constant(
    JSON.stringify({
      promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
      preservedSurface: KOREAN_QUERY_BASE,
      intent: 'recommendation',
      confidence: 0.9,
      inferredPreferences: [],
      obligations: [],
      forbidden: [],
      reasoning: 'LLM added an extra key here',
    }),
  ),
);

describe('AgentSemanticContractCompiler property invariants', () => {
  it('Property 1+2: rejection is idempotent and token accounting still records every call (100 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(malformedPayloadArb, async (payload) => {
        const chatLlm = makeChatLlm(payload);
        const compiler = new AgentSemanticContractCompiler(chatLlm);
        const state = createAgentExecutionState();

        // First call
        const r1 = await compiler.compileIfNeeded({
          query: KOREAN_QUERY_BASE,
          requestId: 'prop-1-first',
          deterministicContract: makeDeterministicContract(),
          timeoutMs: 5_000,
          state,
        });
        const inputAfterFirst = state.totalInputTokens;

        // Second call with the same invalid payload — must also be undefined.
        const r2 = await compiler.compileIfNeeded({
          query: KOREAN_QUERY_BASE,
          requestId: 'prop-1-second',
          deterministicContract: makeDeterministicContract(),
          timeoutMs: 5_000,
          state,
        });

        // Invariants:
        //  - both rejections produce exactly `undefined`
        //  - input-token accounting strictly increased (LLM ran twice)
        return (
          r1 === undefined
          && r2 === undefined
          && inputAfterFirst > 0
          && state.totalInputTokens > inputAfterFirst
        );
      }),
      { numRuns: 100, seed: 0xC0FFEE },
    );
  });

  it('Property 3+4: Korean query NFC is preserved verbatim in preservedSurface when admitted (100 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(koreanQueryArb, async (rawQuery) => {
        // The query may end with whitespace; admission only cares about jamo
        // presence. We still want to produce a valid contract for the input.
        const payload = JSON.stringify({
          promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
          preservedSurface: rawQuery,
          intent: 'recommendation',
          confidence: 0.9,
          inferredPreferences: [],
          obligations: ['grounded_search_required'],
          forbidden: [],
        });
        const chatLlm = makeChatLlm(payload);
        const compiler = new AgentSemanticContractCompiler(chatLlm);
        const state = createAgentExecutionState();

        const result = await compiler.compileIfNeeded({
          query: rawQuery,
          requestId: 'prop-surface',
          deterministicContract: makeDeterministicContract(),
          timeoutMs: 5_000,
          state,
        });

        // preservedSurface must equal the input verbatim (NFC stability).
        return (
          result !== undefined
          && result.preservedSurface === rawQuery
          && rawQuery.normalize('NFC') === rawQuery
        );
      }),
      { numRuns: 100, seed: 0xBEEF },
    );
  });

  it('Property 5: confidence below MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD is rejected (100 runs)', async () => {
    // Property: any valid contract shape whose top-level confidence is
    // strictly below the abstention threshold must be rejected (returns
    // undefined). Above-threshold cases admit.
    const lowConfidenceArb = fc.double({
      min: 0,
      max: MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD - Number.EPSILON,
      noNaN: true,
      noDefaultInfinity: true,
    });
    await fc.assert(
      fc.asyncProperty(lowConfidenceArb, async (low) => {
        const payload = JSON.stringify({
          promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
          preservedSurface: KOREAN_QUERY_BASE,
          intent: 'recommendation',
          confidence: low,
          inferredPreferences: [],
          obligations: [],
          forbidden: [],
        });
        const chatLlm = makeChatLlm(payload);
        const compiler = new AgentSemanticContractCompiler(chatLlm);
        const state = createAgentExecutionState();

        const result = await compiler.compileIfNeeded({
          query: KOREAN_QUERY_BASE,
          requestId: 'prop-abstain-low',
          deterministicContract: makeDeterministicContract(),
          timeoutMs: 5_000,
          state,
        });

        return result === undefined && state.totalInputTokens > 0;
      }),
      { numRuns: 100, seed: 0xABC123 },
    );
  });

  it('Property 5 (positive side): confidence at or above threshold is admitted', async () => {
    // Sanity bound: the threshold must be strictly less than 1 so an
    // above-threshold contract is achievable.
    expect(MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD).toBeLessThan(1);

    const payload = JSON.stringify({
      promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
      preservedSurface: KOREAN_QUERY_BASE,
      intent: 'recommendation',
      confidence: MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD,
      inferredPreferences: [],
      obligations: [],
      forbidden: [],
    });
    const chatLlm = makeChatLlm(payload);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: KOREAN_QUERY_BASE,
      requestId: 'prop-abstain-boundary',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBeDefined();
    expect(result?.confidence).toBe(MIN_SEMANTIC_CONTRACT_CONFIDENCE_THRESHOLD);
  });

  it('Property 6: empty inferredPreferences list is a valid contract', async () => {
    const payload = JSON.stringify({
      promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
      preservedSurface: KOREAN_QUERY_BASE,
      intent: 'unknown',
      confidence: 0.9,
      inferredPreferences: [],
      obligations: [],
      forbidden: [],
    });
    const chatLlm = makeChatLlm(payload);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: KOREAN_QUERY_BASE,
      requestId: 'prop-empty-prefs',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBeDefined();
    expect(result?.inferredPreferences).toEqual([]);
  });
});

// ─── Specific intent / merge cases ────────────────────────────────────────────

describe('AgentSemanticContractCompiler — multi-intent + merge cases', () => {
  it('preserves a recommendation intent with food_pairing-like obligations through merge', async () => {
    // "Multi-intent" here means: the contract intent is `recommendation`
    // but the contextual obligations include food-pairing grounding. The
    // contract must keep the intent enum value verbatim and the merge must
    // surface grounded_search_required as a hard requirement.
    const koreanPairingQuery = '스테이크에 ㄱㅊ 와인';
    const payload = JSON.stringify({
      promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
      preservedSurface: koreanPairingQuery,
      intent: 'recommendation',
      confidence: 0.92,
      inferredPreferences: [
        {
          axis: 'occasion',
          value: 'date_night',
          source: '스테이크',
          confidence: 0.88,
        },
      ],
      obligations: ['grounded_search_required', 'claim_evidence_required'],
      forbidden: ['answer_without_grounding'],
    });
    const chatLlm = makeChatLlm(payload);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: koreanPairingQuery,
      requestId: 'multi-intent',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBeDefined();
    expect(result?.intent).toBe('recommendation');
    expect(result?.obligations).toContain('grounded_search_required');
    expect(result?.obligations).toContain('claim_evidence_required');
    expect(result?.forbidden).toContain('answer_without_grounding');

    const merged = mergeAgentSemanticContract(makeDeterministicContract(), result!);
    expect(merged.requiresGroundedWineSearch).toBe(true);
    expect(merged.semanticContract).toBeDefined();
  });

  it('empty / whitespace-only query is rejected by admission before the LLM call', async () => {
    // Admission gate requires at least one Hangul jamo. Whitespace-only and
    // empty inputs short-circuit before the LLM is contacted.
    const chatLlm = makeChatLlm('irrelevant');
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    for (const query of ['', '   ', '\t\n']) {
      const result = await compiler.compileIfNeeded({
        query,
        requestId: `empty-${query.length}`,
        deterministicContract: makeDeterministicContract(),
        timeoutMs: 5_000,
        state,
      });
      expect(result).toBe(undefined);
    }
    expect(chatLlm.complete).not.toHaveBeenCalled();
    expect(state.totalInputTokens).toBe(0);
    expect(state.totalOutputTokens).toBe(0);
  });

  it('schema-valid JSON with an EXTRA unknown top-level key is rejected by Zod strict()', async () => {
    const payload = JSON.stringify({
      promptVersion: AGENT_SEMANTIC_CONTRACT_PROMPT_VERSION,
      preservedSurface: KOREAN_QUERY_BASE,
      intent: 'recommendation',
      confidence: 0.9,
      inferredPreferences: [],
      obligations: [],
      forbidden: [],
      // Unknown top-level key — LLMs commonly emit `reasoning`, `metadata`,
      // `_thoughts` etc. Our fence MUST reject these, because the
      // AgentSemanticContractSchema is `.strict()`.
      reasoning: 'I think recommendation is the best fit.',
    });
    const chatLlm = makeChatLlm(payload);
    const compiler = new AgentSemanticContractCompiler(chatLlm);
    const state = createAgentExecutionState();

    const result = await compiler.compileIfNeeded({
      query: KOREAN_QUERY_BASE,
      requestId: 'strict-extra-key',
      deterministicContract: makeDeterministicContract(),
      timeoutMs: 5_000,
      state,
    });

    expect(result).toBe(undefined);
    expect(state.totalInputTokens).toBeGreaterThan(0);
  });
});
