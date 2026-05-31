/**
 * Regression: SynthesisRunner surfaces grounded wines to the LLM as a
 * structured `grounded_wines (N):` list — not a raw `JSON.stringify(result)`
 * cut at 6 000 chars.
 *
 * Root cause (bench v14, 2026-05-25):
 *   The previous `serializeToolOutcomesForSynthesis` packed
 *   `JSON.stringify(outcome.result)` straight into the synthesis user message
 *   and capped the entire payload at 6 000 chars. A single SearchResponseV1
 *   row carries a populated `evidenceItems[]`, `constraints` block,
 *   `uncertainty` block, plus debug shapes — one row routinely exceeded the
 *   budget, leaving the LLM to see only `…[grounding truncated]`. The
 *   synthesizer's natural response — "도구 결과가 잘려 있어 추천 불가" /
 *   "(grounding truncated)" — leaked verbatim into ~18 of 19 bottom-tier
 *   bench scenarios.
 *
 * This test locks in the structural fix:
 *   - The compact payload contains a `grounded_wines (N):` section with at
 *     least one parseable label even when the underlying outcomes carry
 *     5+ ResultItems with heavy `evidenceItems[]` / `uncertainty` payloads.
 *   - The compact payload never truncates the FIRST wine record below
 *     2 000 chars, so the LLM always has at least one recommendable
 *     anchor when grounded wines exist.
 *   - When the LLM emits a "no recommendation" answer with empty
 *     `citations` despite N≥1 grounded wines (contract violation), the
 *     SynthesisRunner forces exactly one re-synth round-trip rather than
 *     accepting the contract-violating answer as primary.
 */

import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  type AnalyzeRequest,
  type AnalyzeResult,
  type ExecuteRequest,
  type ExecuteResult,
  type StructuredLlmPort,
  type SynthesizeRequest,
  type SynthesizeResult,
} from '../../src/domain/ai/port/structured-llm.port.js';
import type { ToolOutcome } from '../../src/domain/agent/model/tool-outcome.js';
import { SynthesisRunner } from '../../src/application/wine-search/synthesis-runner.js';
import {
  buildSynthesisGroundingPayload,
  SYNTHESIS_GROUNDING_PAYLOAD_MAX_CHARS,
  SYNTHESIS_MAX_GROUNDING_WINES,
  countGroundedWines,
} from '../../src/application/wine-search/synthesis-grounding-payload.js';
import { type SynthesisAnswer } from '../../src/application/wine-search/synthesis-schemas.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-regress-grounding-trunc';
const PER_STEP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;
const HEAVY_EVIDENCE_ITEMS_PER_RESULT = 12;
const HEAVY_RESULTS = 5;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
}

function makeAnalysis(query: string, hangulDominant: boolean): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    normalizedConstraints: [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: false,
      hasEntityMetadataSignal: false,
    },
    expectedMultiStep: false,
    recommendedBudget: { maxSteps: 4, perToolCap: 3 },
    hangulDominant,
    preservedSurface: query,
  };
}

/**
 * Build a tool outcome whose result mirrors a real SearchResponseV1 row
 * with heavy `evidenceItems[]`, `uncertainty`, and debug shapes. The raw
 * JSON.stringify of this single outcome is well over the legacy 6 000-char
 * cap and would have been replaced by the `…[grounding truncated]` marker.
 */
function makeHeavySearchOutcome(): ToolOutcome {
  const heavyResults = Array.from({ length: HEAVY_RESULTS }, (_unused, i) => ({
    entity: {
      entityId: `wine-${String(i + 1).padStart(4, '0')}`,
      canonicalLabel: `Heavy Wine ${String(i + 1)} 2018`,
      producer: `Producer ${String(i + 1)}`,
      region: 'Bordeaux',
      country: 'France',
      wineType: 'red',
      vintage: 2018,
      grapes: ['Cabernet Sauvignon', 'Merlot'],
      priceRange: '$30-$50',
      body: 4,
      tannin: 4,
      acidity: 3,
      criticScore: 0.88,
      semanticSummary: 'A bold full-bodied red with ripe tannins and a long oaky finish.',
    },
    relevanceScore: 0.92,
    match: {
      anchors: Array.from({ length: 6 }, (_u, j) => ({
        field: `anchor_${String(j)}`,
        value: 'x'.repeat(40),
        confidence: 0.95,
      })),
      retrievalChannels: ['bm25', 'dense', 'sparse', 'cross_encoder'],
    },
    constraints: {
      satisfied: ['region:bordeaux', 'wineType:red', 'vintage:2018'],
      unmet: [],
      score: 1,
    },
    uncertainty: {
      score: 0.15,
      factors: Array.from({ length: 5 }, (_u, j) => ({
        kind: `factor_${String(j)}`,
        weight: 0.2,
        explanation: 'y'.repeat(80),
      })),
    },
    evidenceItems: Array.from({ length: HEAVY_EVIDENCE_ITEMS_PER_RESULT }, (_u, j) => ({
      kind: `evidence_${String(j)}`,
      channel: 'bm25',
      contribution: 0.05,
      explanation: 'z'.repeat(120),
    })),
    drinkingWindow: {
      drinkingWindowStart: 2020,
      drinkingWindowEnd: 2030,
      peakYear: 2025,
      currentlyDrinkable: true,
      confidence: 'high' as const,
    },
  }));
  return {
    stepId: 'q:0:0',
    tool: 'search_hybrid',
    kind: 'success',
    durationMs: 12,
    result: {
      queryType: 'search',
      engineDecision: { kind: 'resolved' },
      results: heavyResults,
      meta: { tookMs: 12 },
    },
  };
}

function makeStubLlm(
  impl: (req: SynthesizeRequest<z.ZodTypeAny>) => Promise<SynthesizeResult<SynthesisAnswer>>,
): { port: StructuredLlmPort; calls: Array<SynthesizeRequest<z.ZodTypeAny>> } {
  const calls: Array<SynthesizeRequest<z.ZodTypeAny>> = [];
  const synthesizeMock = vi.fn(async (req: SynthesizeRequest<z.ZodTypeAny>) => {
    calls.push(req);
    return impl(req);
  });
  const port: StructuredLlmPort = {
    analyze: <TSchema extends z.ZodTypeAny>(
      _req: AnalyzeRequest<TSchema>,
    ): Promise<AnalyzeResult<z.infer<TSchema>>> => {
      throw new Error('analyze should not be called by SynthesisRunner');
    },
    execute: (_req: ExecuteRequest): Promise<ExecuteResult> => {
      throw new Error('execute should not be called by SynthesisRunner');
    },
    synthesize: <TSchema extends z.ZodTypeAny>(
      req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<z.infer<TSchema>>> => {
      return synthesizeMock(
        req as unknown as SynthesizeRequest<z.ZodTypeAny>,
      ) as unknown as Promise<SynthesizeResult<z.infer<TSchema>>>;
    },
  };
  return { port, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildSynthesisGroundingPayload — bench v14 truncation RCA', () => {
  it('surfaces N grounded wines as a structured list even with heavy SearchResponseV1 evidenceItems', () => {
    const outcome = makeHeavySearchOutcome();
    const payload = buildSynthesisGroundingPayload([outcome]);

    expect(payload).toMatch(/^grounded_wines \(5\):/u);
    // Every heavy wine label appears in the payload.
    for (let i = 0; i < HEAVY_RESULTS; i += 1) {
      expect(payload).toContain(`Heavy Wine ${String(i + 1)} 2018`);
    }
    // No truncation marker for this workload — heavy evidence does not bleed
    // into the payload (legacy bug: it consumed the entire budget).
    expect(payload).not.toContain('[grounding truncated]');
    // Producer / region / vintage / grapes / price / body fields are surfaced.
    expect(payload).toContain('producer="Producer 1"');
    expect(payload).toContain('region="Bordeaux"');
    expect(payload).toContain('vintage=2018');
    expect(payload).toContain('grapes=["Cabernet Sauvignon","Merlot"]');
    expect(payload).toContain('price="$30-$50"');
  });

  it('total payload stays under the hard char ceiling', () => {
    const outcome = makeHeavySearchOutcome();
    const payload = buildSynthesisGroundingPayload([outcome]);
    expect(payload.length).toBeLessThanOrEqual(SYNTHESIS_GROUNDING_PAYLOAD_MAX_CHARS);
  });

  it('caps at SYNTHESIS_MAX_GROUNDING_WINES when overwhelmed with results', () => {
    // Build an outcome with N>cap results — the payload must surface
    // exactly `cap` records (not zero, never ALL of them).
    const big = makeHeavySearchOutcome();
    const giantResults = Array.from({ length: SYNTHESIS_MAX_GROUNDING_WINES + 10 }, (_u, i) => ({
      entity: { canonicalLabel: `BulkWine ${String(i + 1)}`, producer: 'P', region: 'R' },
    }));
    const outcome: ToolOutcome = {
      ...big,
      result: { queryType: 'search', results: giantResults },
    };
    const payload = buildSynthesisGroundingPayload([outcome]);
    expect(payload).toMatch(new RegExp(`^grounded_wines \\(${String(SYNTHESIS_MAX_GROUNDING_WINES)}\\):`, 'u'));
    expect(payload).toContain('BulkWine 1');
    expect(payload).toContain(`BulkWine ${String(SYNTHESIS_MAX_GROUNDING_WINES)}`);
    // Wines beyond the cap should NOT appear.
    expect(payload).not.toContain(`BulkWine ${String(SYNTHESIS_MAX_GROUNDING_WINES + 1)}`);
  });

  it('emits grounded_wines (0) and tool_outcomes (M) header even with no usable results', () => {
    const outcome: ToolOutcome = {
      stepId: 'q:0:0',
      tool: 'search_hybrid',
      kind: 'tool_error',
      durationMs: 12,
      errorMessage: 'Vespa unreachable',
    };
    const payload = buildSynthesisGroundingPayload([outcome]);
    expect(payload).toContain('grounded_wines (0):');
    expect(payload).toContain('tool_outcomes (1):');
    expect(payload).toContain('kind=tool_error');
    expect(payload).toContain('errorMessage="Vespa unreachable"');
  });

  it('countGroundedWines mirrors the verifier wine count', () => {
    const outcome = makeHeavySearchOutcome();
    expect(countGroundedWines([outcome])).toBe(HEAVY_RESULTS);
    expect(countGroundedWines([])).toBe(0);
  });

  // CLAUDE.md rule 5: regex/normalisation paths exercised on ASCII, Korean,
  // accented-Latin, and emoji-bearing inputs.
  it('preserves Korean canonical labels intact (CLAUDE.md rule 5)', () => {
    const outcome: ToolOutcome = {
      stepId: 'q:0:0',
      tool: 'search_hybrid',
      kind: 'success',
      durationMs: 12,
      result: {
        queryType: 'search',
        results: [{ entity: { canonicalLabel: '오푸스 원 2018', producer: '오버추어', region: '나파' } }],
      },
    };
    const payload = buildSynthesisGroundingPayload([outcome]);
    expect(payload).toContain('label="오푸스 원 2018"');
    expect(payload).toContain('producer="오버추어"');
    expect(payload).toContain('region="나파"');
  });

  it('preserves accented-Latin labels (CLAUDE.md rule 5)', () => {
    const outcome: ToolOutcome = {
      stepId: 'q:0:0',
      tool: 'search_hybrid',
      kind: 'success',
      durationMs: 12,
      result: {
        queryType: 'search',
        results: [
          {
            entity: {
              canonicalLabel: 'Château Pétrus 2010',
              producer: 'Château Pétrus',
              region: 'Pomerol',
            },
          },
        ],
      },
    };
    const payload = buildSynthesisGroundingPayload([outcome]);
    expect(payload).toContain('label="Château Pétrus 2010"');
    expect(payload).toContain('region="Pomerol"');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: SynthesisRunner uses the new payload + enforces the
// "must cite a wine when N>=1" contract.
// ---------------------------------------------------------------------------

describe('SynthesisRunner — bench v14 RCA: contract violation guard', () => {
  it('LLM emits truncation prose + empty citations → forces re-synth (does not accept primary)', async () => {
    // The model would have copied the legacy "결과가 잘려" / "(grounding
    // truncated)" prose verbatim, with no citations. With N>=1 grounded
    // wines this is a contract violation; the runner must force exactly one
    // re-synth round-trip rather than accept the answer at the primary layer.
    let attempt = 0;
    const { port, calls } = makeStubLlm(async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          data: {
            answer:
              '죄송합니다. 도구 결과가 잘려 있어 (grounding truncated) 특정 와인 추천을 드릴 수 없습니다.',
            citations: [],
          },
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
        };
      }
      // Re-synth pass: model recovers and recommends a wine from the list.
      return {
        data: {
          answer:
            '풀바디 레드 와인으로 Heavy Wine 1 2018을 추천 드립니다. 보르도 카베르네 블렌드로 잘 어울립니다.',
          citations: ['Heavy Wine 1 2018'],
        },
        usage: { inputTokens: 110, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    });

    const runner = new SynthesisRunner({ structuredLlm: port, logger: makeLogger() });
    const result = await runner.run({
      query: '풀바디 레드 와인 추천',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('풀바디 레드 와인 추천', true),
      toolOutcomes: [makeHeavySearchOutcome()],
      policyBlocked: false,
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    expect(calls.length).toBe(2);
    expect(result.layer).toBe('primary');
    expect(result.synthesisAttempts).toBe(2);
    expect(result.verificationAttempts).toBe(2);
    expect(result.answer).toContain('Heavy Wine 1 2018');
  });

  it('LLM cites a grounded wine on the first attempt → no re-synth (happy path)', async () => {
    let attempt = 0;
    const { port, calls } = makeStubLlm(async () => {
      attempt += 1;
      return {
        data: {
          answer: 'Heavy Wine 2 2018은 풀바디 레드로 잘 어울립니다.',
          citations: ['Heavy Wine 2 2018'],
        },
        usage: { inputTokens: 90, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    });

    const runner = new SynthesisRunner({ structuredLlm: port, logger: makeLogger() });
    const result = await runner.run({
      query: '풀바디 레드 와인 추천',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('풀바디 레드 와인 추천', true),
      toolOutcomes: [makeHeavySearchOutcome()],
      policyBlocked: false,
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });

    void attempt;
    expect(calls.length).toBe(1);
    expect(result.layer).toBe('primary');
    expect(result.synthesisAttempts).toBe(1);
    expect(result.answer).toContain('Heavy Wine 2 2018');
  });

  it('payload visible to the synthesizer LLM is a structured grounded_wines list — not a JSON dump', async () => {
    const { port, calls } = makeStubLlm(async () => ({
      data: {
        answer: 'Recommending Heavy Wine 1 2018.',
        citations: ['Heavy Wine 1 2018'],
      },
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }));
    const runner = new SynthesisRunner({ structuredLlm: port, logger: makeLogger() });
    await runner.run({
      query: 'full-bodied red',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('full-bodied red', false),
      toolOutcomes: [makeHeavySearchOutcome()],
      policyBlocked: false,
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    expect(calls.length).toBe(1);
    const firstCall = calls[0]!;
    const userMessages = firstCall.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    expect(userMessages).toContain('grounded_wines (5):');
    expect(userMessages).toContain('label="Heavy Wine 1 2018"');
    // The legacy raw stringify of `evidenceItems` MUST NOT leak into the prompt.
    expect(userMessages).not.toContain('"evidenceItems"');
    expect(userMessages).not.toContain('"uncertainty"');
  });

  it('zero grounded wines + LLM emits "no results" prose → not flagged as contract violation', async () => {
    // When `grounded_wines (0)` legitimately holds, an empty-citations
    // answer is faithful — the runner must NOT force a re-synth.
    const { port, calls } = makeStubLlm(async () => ({
      data: {
        answer: 'No wines matched the criteria. Try broadening the query.',
        citations: [],
      },
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }));
    const noMatchOutcome: ToolOutcome = {
      stepId: 'q:0:0',
      tool: 'search_hybrid',
      kind: 'success',
      durationMs: 12,
      result: { queryType: 'search', results: [] },
    };
    const runner = new SynthesisRunner({ structuredLlm: port, logger: makeLogger() });
    const result = await runner.run({
      query: 'recommend a wine',
      requestId: REQUEST_ID,
      analysis: makeAnalysis('recommend a wine', false),
      toolOutcomes: [noMatchOutcome],
      policyBlocked: false,
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    expect(calls.length).toBe(1);
    // No grounding → primary path NOT taken. Layer ladder falls to layer4
    // (no top result, no grounding observation). The important invariant is
    // that no second LLM call happens.
    expect(result.synthesisAttempts).toBeLessThanOrEqual(1);
  });
});
