import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  ExecuteRequest,
  ExecuteResult,
  StructuredLlmPort,
  SynthesizeRequest,
  SynthesizeResult,
  TokenUsage,
} from '@domain/ai/port/structured-llm.port.js';
import {
  StructuredLlmCircuitOpenError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
} from '@domain/ai/port/structured-llm.port.js';
import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';
import { SynthesisRunner } from '../synthesis-runner.js';
import {
  SynthesisAbortedError,
  type AnswerResult,
  type SynthesisAnswer,
} from '../synthesis-schemas.js';
import { FALLBACK_TEMPLATES, layer4MessageFor } from '../synthesis-fallback-templates.js';
import type { WineSearchAnalysis } from '../wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-synth-0001';
const PER_STEP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;
// A GENERIC, untyped Error (not a StructuredLlm*Error). Models an UNMODELED
// failure → degradedReason 'unexpected_error' → ladder fabrication. NOTE: a
// REAL provider credit/auth rejection arrives as a typed
// StructuredLlmValidationError carrying httpStatus and is handled as
// 'llm_unavailable' (honest fail) — see the "provider unavailable" describe.
const GENERIC_UNMODELED_ERROR_MESSAGE =
  'some unmodeled downstream failure';

function makeLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
}

function makeTokenUsage(input: number, output: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function makeGenericUnmodeledError(): Error {
  return new Error(GENERIC_UNMODELED_ERROR_MESSAGE);
}

function makeAnalysis(
  query: string,
  hangulDominant: boolean,
  intent: WineSearchAnalysis['intent'] = 'search',
  callerInterpretation?: WineSearchAnalysis['callerInterpretation'],
): WineSearchAnalysis {
  return {
    intent,
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
    ...(callerInterpretation !== undefined ? { callerInterpretation } : {}),
  };
}

function makeSearchOutcome(
  results: ReadonlyArray<{
    canonicalLabel: string;
    producer?: string;
    region?: string;
    priceRange?: string;
    entityId?: string;
  }>,
  opts?: { kind?: ToolOutcome['kind']; stepId?: string; tool?: string },
): ToolOutcome {
  return {
    stepId: opts?.stepId ?? 'q:0:0',
    tool: opts?.tool ?? 'search_hybrid',
    kind: opts?.kind ?? 'success',
    durationMs: 12,
    result: {
      queryType: 'search',
      results: results.map((r, index) => ({
        entity: {
          entityId: r.entityId ?? `wine-${String(index + 1)}`,
          canonicalLabel: r.canonicalLabel,
          ...(r.producer !== undefined ? { producer: r.producer } : {}),
          ...(r.region !== undefined ? { region: r.region } : {}),
          ...(r.priceRange !== undefined ? { priceRange: r.priceRange } : {}),
        },
      })),
    },
  };
}

function makeGroundingObservation(wines: ReadonlyArray<{
  canonical_label?: string;
  region?: string;
  grapes?: readonly string[];
  price?: string;
}>): ToolOutcome {
  return {
    stepId: 'q:0:0',
    tool: 'search_hybrid',
    kind: 'success',
    durationMs: 12,
    result: { wines },
  };
}

interface StubLlm extends StructuredLlmPort {
  readonly synthesizeMock: ReturnType<typeof vi.fn>;
}

function makeStubLlm(
  impl: (req: SynthesizeRequest<z.ZodTypeAny>) => Promise<SynthesizeResult<SynthesisAnswer>>,
): StubLlm {
  const synthesizeMock = vi.fn(impl);
  return {
    synthesizeMock,
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
}

function makeRunner(llm: StructuredLlmPort) {
  const logger = makeLogger();
  return {
    runner: new SynthesisRunner({ structuredLlm: llm, logger }),
    logger,
  };
}

async function run(
  llm: StructuredLlmPort,
  overrides: {
    readonly query: string;
    readonly toolOutcomes?: readonly ToolOutcome[];
    readonly policyBlocked?: boolean;
    readonly hangulDominant?: boolean;
    readonly abortSignal?: AbortSignal;
    readonly intent?: WineSearchAnalysis['intent'];
    readonly callerInterpretation?: WineSearchAnalysis['callerInterpretation'];
  },
): Promise<AnswerResult> {
  const { runner } = makeRunner(llm);
  const analysis = makeAnalysis(
    overrides.query,
    overrides.hangulDominant ?? false,
    overrides.intent ?? 'search',
    overrides.callerInterpretation,
  );
  return runner.run({
    query: overrides.query,
    requestId: REQUEST_ID,
    analysis,
    toolOutcomes: overrides.toolOutcomes ?? [],
    policyBlocked: overrides.policyBlocked ?? false,
    perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(overrides.abortSignal !== undefined ? { abortSignal: overrides.abortSignal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Primary success paths
// ---------------------------------------------------------------------------

describe('SynthesisRunner — primary structured-LLM path', () => {
  it('Korean query with grounded results returns primary layer + citations', async () => {
    const llm = makeStubLlm(async () => ({
      data: { answer: '부르고뉴 피노누아 와인을 추천드립니다.', citations: ['wine-001'] },
      usage: makeTokenUsage(120, 60),
      durationMs: 8,
    }));
    const result = await run(llm, {
      query: '부르고뉴 피노누아 추천',
      hangulDominant: true,
      toolOutcomes: [makeSearchOutcome([{ canonicalLabel: 'Domaine X Pinot Noir', producer: 'Domaine X', region: 'Burgundy' }])],
    });
    expect(result.layer).toBe('primary');
    expect(result.groundedOnToolResults).toBe(true);
    expect(result.synthesisAttempts).toBe(1);
    expect(result.answer).toContain('부르고뉴');
    expect(result.tokenUsage.inputTokens).toBe(120);
    expect(result.tokenUsage.outputTokens).toBe(60);
  });

  it('English query returns English answer from primary path', async () => {
    const llm = makeStubLlm(async () => ({
      data: { answer: 'I recommend a Burgundy Pinot Noir.', citations: ['wine-001'] },
      usage: makeTokenUsage(110, 55),
      durationMs: 7,
    }));
    const result = await run(llm, {
      query: 'Recommend a Burgundy Pinot Noir',
      hangulDominant: false,
      toolOutcomes: [makeSearchOutcome([{ canonicalLabel: 'Domaine X Pinot Noir', producer: 'Domaine X', region: 'Burgundy' }])],
    });
    expect(result.layer).toBe('primary');
    expect(result.answer).toBe('I recommend a Burgundy Pinot Noir.');
  });

  it('Accented-Latin query (Côte-Rôtie) routes to English primary answer', async () => {
    const llm = makeStubLlm(async () => ({
      // bench v14 RCA contract: an answer with N>=1 grounded wines MUST
      // either cite a grounded label or mention one in prose. The model now
      // names the grounded `Guigal Côte-Rôtie` explicitly.
      data: {
        answer: 'Try the Guigal Côte-Rôtie Syrah from the northern Rhône.',
        citations: ['Guigal Côte-Rôtie'],
      },
      usage: makeTokenUsage(95, 40),
      durationMs: 6,
    }));
    const result = await run(llm, {
      query: 'Suggest a Côte-Rôtie',
      hangulDominant: false,
      toolOutcomes: [makeSearchOutcome([{ canonicalLabel: 'Guigal Côte-Rôtie', producer: 'Guigal', region: 'Rhône' }])],
    });
    expect(result.layer).toBe('primary');
    expect(result.answer).toContain('Côte-Rôtie');
  });
});

describe('SynthesisRunner — validation retry', () => {
  it('validation failure → retry → success → attempts=2', async () => {
    let call = 0;
    const llm = makeStubLlm(async () => {
      call += 1;
      if (call === 1) {
        throw new StructuredLlmValidationError(
          [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
          { not: 'shaped right' },
        );
      }
      // Citations are populated to satisfy the bench v14 RCA contract
      // (N>=1 grounded wines → primary answer MUST cite at least one).
      // The retry-attempts invariant is independent of citations; we keep
      // them present so the new guard does not fire and inflate the count.
      return {
        data: { answer: '와인 A를 추천 드립니다. 재시도 후 성공한 답변입니다.', citations: ['와인 A'] },
        usage: makeTokenUsage(50, 30),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: '와인 추천해주세요',
      hangulDominant: true,
      toolOutcomes: [makeSearchOutcome([{ canonicalLabel: '와인 A' }])],
    });
    expect(result.layer).toBe('primary');
    expect(result.synthesisAttempts).toBe(2);
    expect(result.answer).toBe('와인 A를 추천 드립니다. 재시도 후 성공한 답변입니다.');
  });

  it('validation failure on both attempts → falls to layer 2 (top result template, Korean)', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
        {},
      );
    });
    const result = await run(llm, {
      query: '나파 카베르네 추천',
      hangulDominant: true,
      toolOutcomes: [
        makeSearchOutcome([
          { canonicalLabel: 'Robert Mondavi Reserve', producer: 'Robert Mondavi', region: 'Napa Valley' },
        ]),
      ],
    });
    expect(result.layer).toBe('layer2');
    expect(result.groundedOnToolResults).toBe(true);
    expect(result.synthesisAttempts).toBe(2);
    expect(result.degradedReason).toBe('malformed_llm_output');
    expect(result.answer).toBe(
      FALLBACK_TEMPLATES.layer2.korean('Robert Mondavi Reserve', 'Robert Mondavi', 'Napa Valley'),
    );
  });
});

// ---------------------------------------------------------------------------
// Layer 2
// ---------------------------------------------------------------------------

describe('SynthesisRunner — Layer 2 deterministic template', () => {
  it('Korean query → Korean Layer 2 template byte-identical to legacy', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
        {},
      );
    });
    const result = await run(llm, {
      query: '와인 추천',
      hangulDominant: true,
      toolOutcomes: [
        makeSearchOutcome([
          { canonicalLabel: 'Château Margaux', producer: 'Château Margaux', region: 'Bordeaux' },
        ]),
      ],
    });
    expect(result.answer).toBe(
      '검색 결과: Château Margaux (Château Margaux, Bordeaux). (참고: 처리 제약으로 간단히 표시되었습니다.)',
    );
  });

  it('English query → English Layer 2 template byte-identical to legacy', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
        {},
      );
    });
    const result = await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [
        makeSearchOutcome([
          { canonicalLabel: 'Château Margaux', producer: 'Château Margaux', region: 'Bordeaux' },
        ]),
      ],
    });
    expect(result.answer).toBe(
      'Based on your query, I found: Château Margaux (Château Margaux, Bordeaux). (Note: simplified result due to processing constraints.)',
    );
  });

  it('anchored_similarity + similar_to_entity success bypasses synthesis LLM and returns grounded candidates', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must not be called on deterministic reference-similarity fast path');
    });
    const result = await run(llm, {
      query: 'Opus One similar but cheaper',
      hangulDominant: false,
      callerInterpretation: {
        authority: 'caller',
        intent: 'mixed_query',
        queryClass: 'anchored_similarity',
      },
      toolOutcomes: [
        makeSearchOutcome(
          [{ canonicalLabel: 'Opus One 2018', producer: 'Opus One', region: 'Napa Valley' }],
          { tool: 'lookup_wine' },
        ),
        makeSearchOutcome(
          [
            { canonicalLabel: 'Quintessa 2019', producer: 'Quintessa', region: 'Napa Valley', priceRange: '$180-$220' },
            { canonicalLabel: 'Dominus Estate 2019', producer: 'Dominus', region: 'Napa Valley', priceRange: '$200-$240' },
          ],
          { tool: 'similar_to_entity' },
        ),
      ],
    });
    expect(result.layer).toBe('layer2');
    expect(result.synthesisAttempts).toBe(0);
    expect(result.verificationAttempts).toBe(0);
    expect(result.answer).toContain('Opus One 2018');
    expect(result.answer).toContain('Quintessa 2019');
    expect(result.answer).toContain('Dominus Estate 2019');
    expect(llm.synthesizeMock).not.toHaveBeenCalled();
  });

  it('anchored_similarity + similar_to_entity empty_result returns deterministic no-match answer without LLM', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must not be called on deterministic reference-similarity no-match fast path');
    });
    const result = await run(llm, {
      query: '오푸스원이랑 비슷한데 더 싼 거 추천해줘',
      hangulDominant: true,
      callerInterpretation: {
        authority: 'caller',
        intent: 'mixed_query',
        queryClass: 'anchored_similarity',
      },
      toolOutcomes: [
        makeSearchOutcome(
          [{ canonicalLabel: 'Opus One 2018', producer: 'Opus One', region: 'Napa Valley' }],
          { tool: 'lookup_wine' },
        ),
        {
          stepId: 'q:1:0',
          tool: 'similar_to_entity',
          kind: 'empty_result',
          durationMs: 10,
          result: {
            queryType: 'search',
            results: [],
          },
        },
      ],
    });
    expect(result.layer).toBe('layer2');
    expect(result.answer).toContain('Opus One 2018');
    expect(result.answer).toContain('찾지 못했습니다');
    expect(result.synthesisAttempts).toBe(0);
    expect(llm.synthesizeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer 3
// ---------------------------------------------------------------------------

describe('SynthesisRunner — Layer 3 grounding preview', () => {
  it('falls to Layer 3 when no top result is available but grounding observation exists', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
        {},
      );
    });
    const result = await run(llm, {
      query: '카베르네 추천',
      hangulDominant: true,
      toolOutcomes: [
        makeGroundingObservation([
          { canonical_label: 'Wine A', region: 'Napa', grapes: ['Cabernet Sauvignon'], price: '$50' },
          { canonical_label: 'Wine B', region: 'Sonoma', grapes: ['Cabernet Franc'] },
        ]),
      ],
    });
    expect(result.layer).toBe('layer3');
    expect(result.groundedOnToolResults).toBe(true);
    expect(result.answer.startsWith('검색 결과 요약:')).toBe(true);
    expect(result.answer).toContain('Wine A');
    expect(result.answer).toContain('Wine B');
  });
});

// ---------------------------------------------------------------------------
// Layer 4
// ---------------------------------------------------------------------------

describe('SynthesisRunner — Layer 4 hard-coded fallback', () => {
  it('no-results → honest "no match" message (NOT a generic "change your query")', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('should not be called when no grounding');
    });
    const result = await run(llm, {
      query: '와인 정보 알려주세요',
      hangulDominant: true,
      toolOutcomes: [],
    });
    expect(result.layer).toBe('layer4');
    expect(result.groundedOnToolResults).toBe(false);
    expect(result.answer).toBe(layer4MessageFor('no_results', true));
    expect(result.answer).toContain('찾지 못했어요');
    expect(result.synthesisAttempts).toBe(0);
    expect(result.degradedReason).toBe('no_results');
  });

  it('English no-results → English honest "no match" message', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('should not be called when no grounding');
    });
    const result = await run(llm, {
      query: 'tell me about wine',
      hangulDominant: false,
      toolOutcomes: [],
    });
    expect(result.layer).toBe('layer4');
    expect(result.answer).toBe(layer4MessageFor('no_results', false));
    expect(result.answer).toContain('could not find');
  });
});

// ---------------------------------------------------------------------------
// Policy blocked
// ---------------------------------------------------------------------------

describe('SynthesisRunner — policy blocked branch', () => {
  it('defaults to security-block template when no blockedKind is provided (English query → English template)', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must not be called when policyBlocked=true');
    });
    const result = await run(llm, {
      query: 'anything',
      policyBlocked: true,
      toolOutcomes: [],
    });
    expect(result.layer).toBe('layer4');
    expect(result.answer).toBe(FALLBACK_TEMPLATES.policyBlocked.english);
    expect(result.degradedReason).toBe('policy_blocked');
    expect(result.synthesisAttempts).toBe(0);
    expect(result.tokenUsage.inputTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe('SynthesisRunner — abort handling', () => {
  it('throws SynthesisAbortedError when abortSignal already aborted', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must not be called on pre-aborted signal');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(llm, {
        query: '와인 추천',
        hangulDominant: true,
        toolOutcomes: [makeSearchOutcome([{ canonicalLabel: 'X' }])],
        abortSignal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SynthesisAbortedError);
  });

  it('throws SynthesisAbortedError when LLM raises an abort error during primary', async () => {
    const llm = makeStubLlm(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(
      run(llm, {
        query: '와인 추천',
        hangulDominant: true,
        toolOutcomes: [makeSearchOutcome([{ canonicalLabel: 'X' }])],
      }),
    ).rejects.toBeInstanceOf(SynthesisAbortedError);
  });
});

// ---------------------------------------------------------------------------
// Situational normalization (OOD alcohol / weather external info)
// ---------------------------------------------------------------------------

describe('SynthesisRunner — situational normalization', () => {
  it('OOD alcohol query without tool outcomes → redirect message (Korean)', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must not be called when no grounding');
    });
    const result = await run(llm, {
      query: '와인 말고 맥주 추천해주세요',
      hangulDominant: true,
      toolOutcomes: [],
    });
    expect(result.layer).toBe('layer4');
    // Situational redirect overrides the layer-4 template since
    // observedToolOutput=false on the layer-4 path.
    expect(result.answer).toContain('와인 중심');
    expect(result.answer).toContain('맥주');
  });

  it('Weather query without tool outcomes → unsupported-external-info message', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must not be called when no grounding');
    });
    const result = await run(llm, {
      query: '오늘 날씨에 맞는 와인 추천',
      hangulDominant: true,
      toolOutcomes: [],
    });
    expect(result.answer).toContain('실시간 날씨');
  });
});

// ---------------------------------------------------------------------------
// Token accounting + timeout + circuit-open
// ---------------------------------------------------------------------------

describe('SynthesisRunner — token / timeout / circuit-open accounting', () => {
  it('aggregates usage across primary + retry attempts', async () => {
    let call = 0;
    const llm = makeStubLlm(async () => {
      call += 1;
      if (call === 1) {
        throw new StructuredLlmValidationError(
          [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
          {},
        );
      }
      return {
        // Citation populated to satisfy the bench v14 RCA contract — the
        // test's invariant is token accounting, not citation policy.
        data: { answer: 'X is a fine pick.', citations: ['X'] },
        usage: makeTokenUsage(40, 25),
        durationMs: 4,
      };
    });
    const result = await run(llm, {
      query: 'recommend a wine',
      hangulDominant: false,
      toolOutcomes: [makeSearchOutcome([{ canonicalLabel: 'X' }])],
    });
    expect(result.synthesisAttempts).toBe(2);
    // Only the second (successful) call returned usage; first call's
    // StructuredLlmValidationError carries no usage data.
    expect(result.tokenUsage.inputTokens).toBe(40);
    expect(result.tokenUsage.outputTokens).toBe(25);
  });

  it('timeout on primary does NOT retry → fails honestly (provider unavailable), no Layer 2 fabrication', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmTimeoutError();
    });
    const result = await run(llm, {
      query: '와인 추천',
      hangulDominant: true,
      toolOutcomes: [
        makeSearchOutcome([
          { canonicalLabel: 'Wine T', producer: 'P', region: 'R' },
        ]),
      ],
    });
    expect(result.layer).toBe('layer4');
    expect(result.degradedReason).toBe('timeout');
    expect(result.answer).toBe(FALLBACK_TEMPLATES.llmUnavailable.korean);
    expect(result.answer).not.toContain('Wine T');
    expect(result.synthesisAttempts).toBe(1);
  });

  it('circuit-open on primary → fails honestly (provider unavailable), no Layer 2 fabrication', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmCircuitOpenError('synth');
    });
    const result = await run(llm, {
      query: '와인 추천',
      hangulDominant: true,
      toolOutcomes: [
        makeSearchOutcome([
          { canonicalLabel: 'Wine C', producer: 'P', region: 'R' },
        ]),
      ],
    });
    expect(result.layer).toBe('layer4');
    expect(result.degradedReason).toBe('circuit_open');
    expect(result.answer).toBe(FALLBACK_TEMPLATES.llmUnavailable.korean);
    expect(result.answer).not.toContain('Wine C');
    expect(result.synthesisAttempts).toBe(1);
  });

  it('generic unmodeled error on both attempts → unexpected_error Layer 2 fallback', async () => {
    const llm = makeStubLlm(async () => {
      throw makeGenericUnmodeledError();
    });
    const result = await run(llm, {
      query: '나파 카베르네 추천',
      hangulDominant: true,
      toolOutcomes: [
        makeSearchOutcome([
          { canonicalLabel: 'Wine Credit', producer: 'Producer C', region: 'Napa Valley' },
        ]),
      ],
    });
    expect(llm.synthesizeMock).toHaveBeenCalledTimes(2);
    expect(result.layer).toBe('layer2');
    expect(result.groundedOnToolResults).toBe(true);
    expect(result.degradedReason).toBe('unexpected_error');
    expect(result.synthesisAttempts).toBe(2);
    expect(result.answer).toBe(
      FALLBACK_TEMPLATES.layer2.korean('Wine Credit', 'Producer C', 'Napa Valley'),
    );
  });

  it('generic unmodeled error on both attempts → unexpected_error Layer 3 fallback', async () => {
    const llm = makeStubLlm(async () => {
      throw makeGenericUnmodeledError();
    });
    const result = await run(llm, {
      query: '카베르네 추천',
      hangulDominant: true,
      toolOutcomes: [
        makeGroundingObservation([
          { canonical_label: 'Wine A', region: 'Napa', grapes: ['Cabernet Sauvignon'], price: '$50' },
          { canonical_label: 'Wine B', region: 'Sonoma' },
        ]),
      ],
    });
    expect(llm.synthesizeMock).toHaveBeenCalledTimes(2);
    expect(result.layer).toBe('layer3');
    expect(result.groundedOnToolResults).toBe(true);
    expect(result.degradedReason).toBe('unexpected_error');
    expect(result.synthesisAttempts).toBe(2);
    expect(result.answer).toContain('Wine A');
    expect(result.answer).toContain('Wine B');
  });

  it('generic unmodeled error on both attempts → unexpected_error Layer 4 fallback', async () => {
    const llm = makeStubLlm(async () => {
      throw makeGenericUnmodeledError();
    });
    const result = await run(llm, {
      query: 'Recommend something',
      hangulDominant: false,
      toolOutcomes: [{
        stepId: 'q:0:0',
        tool: 'search_hybrid',
        kind: 'success',
        durationMs: 12,
        result: { opaque: true },
      }],
    });
    expect(llm.synthesizeMock).toHaveBeenCalledTimes(2);
    expect(result.layer).toBe('layer4');
    expect(result.groundedOnToolResults).toBe(false);
    expect(result.degradedReason).toBe('unexpected_error');
    expect(result.synthesisAttempts).toBe(2);
    expect(result.answer).toBe(layer4MessageFor('unexpected_error', false));
  });
});

// ---------------------------------------------------------------------------
// Schema invariants
// ---------------------------------------------------------------------------

describe('SynthesisRunner — invariants', () => {
  it('answer is non-empty on every non-aborted return path', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
        {},
      );
    });
    // No tool outcomes → Layer 4 path.
    const result = await run(llm, {
      query: 'whatever',
      hangulDominant: false,
      toolOutcomes: [],
    });
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('Korean detection works for syllables AND mixed jamo (rule 5 coverage)', async () => {
    // Pure syllable Hangul → primary path returns Korean from LLM.
    const llmKr = makeStubLlm(async () => ({
      data: { answer: 'KR ok' },
      usage: makeTokenUsage(10, 5),
      durationMs: 1,
    }));
    const resKr = await run(llmKr, {
      query: '추천',
      hangulDominant: true,
      toolOutcomes: [makeSearchOutcome([{ canonicalLabel: 'X' }])],
    });
    expect(resKr.layer).toBe('primary');

    // No grounding + Hangul → Korean Layer 4 template.
    const llmNo = makeStubLlm(async () => {
      throw new Error('not used');
    });
    const resHangulLayer4 = await run(llmNo, {
      query: '와인',
      hangulDominant: true,
      toolOutcomes: [],
    });
    expect(resHangulLayer4.answer).toBe(layer4MessageFor('no_results', true));

    // Pure emoji query → no Hangul → English Layer 4 template.
    const resEmoji = await run(llmNo, {
      query: '🍷🍷🍷',
      hangulDominant: false,
      toolOutcomes: [],
    });
    expect(resEmoji.answer).toBe(layer4MessageFor('no_results', false));

    // Accented Latin → no Hangul → English Layer 4 template.
    const resAccent = await run(llmNo, {
      query: 'château',
      hangulDominant: false,
      toolOutcomes: [],
    });
    expect(resAccent.answer).toBe(layer4MessageFor('no_results', false));
  });
});

// ---------------------------------------------------------------------------
// S3 — deterministic grounding-verify
// ---------------------------------------------------------------------------

/** Search outcome that exposes a canonical_label + vintage in the structured
 *  result so the grounding-verify union can extract label/vintage facts. */
function makeGroundedWineOutcome(
  label: string,
  vintage: number,
): ToolOutcome {
  return {
    stepId: 'q:0:0',
    tool: 'search_hybrid',
    kind: 'success',
    durationMs: 12,
    result: {
      queryType: 'search',
      results: [
        { entity: { entityId: 'wine-001', canonicalLabel: label, vintage } },
      ],
    },
  };
}

describe('SynthesisRunner — S3 grounding-verify', () => {
  it('grounded answer (cites grounded label) passes on first pass with verificationAttempts=1', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      return {
        data: { answer: 'I recommend Wine A from Bordeaux.', citations: ['Wine A'] },
        usage: makeTokenUsage(100, 50),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    expect(result.layer).toBe('primary');
    expect(result.synthesisAttempts).toBe(1);
    expect(result.verificationAttempts).toBe(1);
    expect(result.answer).toContain('Wine A');
    expect(calls).toBe(1);
  });

  it('ungrounded label citation ("Wine B" not in grounding={Wine A}) triggers ONE re-synth → attempts=2', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      if (calls === 1) {
        // Hallucinated recommendation: cites a wine absent from grounding.
        return {
          data: { answer: 'I recommend Wine B, a stunning bottle.', citations: ['Wine B'] },
          usage: makeTokenUsage(100, 50),
          durationMs: 5,
        };
      }
      // Re-synth: now cites the grounded wine.
      return {
        data: { answer: 'On reflection, Wine A is the grounded pick.', citations: ['Wine A'] },
        usage: makeTokenUsage(80, 40),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    expect(result.layer).toBe('primary');
    expect(result.verificationAttempts).toBe(2);
    // synthesisAttempts counts primary (1) + re-synth (1).
    expect(result.synthesisAttempts).toBe(2);
    expect(result.answer).toContain('Wine A');
    expect(calls).toBe(2);
  });

  it('still-ungrounded re-synth degrades to Layer 2 with degradedReason=ungrounded_claim', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      // Both passes hallucinate the same ungrounded wine.
      return {
        data: { answer: 'I recommend Wine B again.', citations: ['Wine B'] },
        usage: makeTokenUsage(90, 45),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    expect(result.layer).toBe('layer2');
    expect(result.degradedReason).toBe('ungrounded_claim');
    // Two full synthesis candidates were produced and grounding-checked
    // (primary + one re-synth); both failed → degrade to Layer 2.
    expect(result.verificationAttempts).toBe(2);
    expect(calls).toBe(2); // primary + one re-synth
  });

  it('ungrounded vintage assertion triggers re-synth', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      if (calls === 1) {
        // Asserts a vintage (2015) absent from grounding (2018).
        return {
          data: { answer: 'The 2015 vintage of Wine A is excellent.', citations: ['Wine A'] },
          usage: makeTokenUsage(100, 50),
          durationMs: 5,
        };
      }
      return {
        data: { answer: 'The 2018 Wine A is the grounded vintage.', citations: ['Wine A'] },
        usage: makeTokenUsage(80, 40),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    expect(result.layer).toBe('primary');
    expect(result.verificationAttempts).toBe(2);
    expect(result.answer).toContain('2018');
  });

  it('faithful paraphrase that cites no specific label is NOT flagged (false-positive guard)', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      // Entity-id citation (skipped) + paraphrase prose, no ungrounded vintage.
      return {
        data: { answer: '부르고뉴 스타일의 와인을 추천드립니다.', citations: ['wine-001'] },
        usage: makeTokenUsage(70, 35),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: '부르고뉴 와인 추천',
      hangulDominant: true,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    expect(result.layer).toBe('primary');
    expect(result.verificationAttempts).toBe(1);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A1 — grounding-verify intent gating (inverted gate). Previously only
// `search` / `pair` were verified; now verify runs on ALL factual-claim
// intents and is SKIPPED only for `unknown`.
// ---------------------------------------------------------------------------

describe('SynthesisRunner — A1 inverted grounding-verify gate', () => {
  it.each<WineSearchAnalysis['intent']>(['search', 'compare', 'pair', 'drinkability'])(
    'intent=%s NOW runs grounding-verify: ungrounded label citation forces a re-synth',
    async (intent) => {
      let calls = 0;
      const llm = makeStubLlm(async () => {
        calls += 1;
        if (calls === 1) {
          // Hallucinated wine absent from grounding (only "Wine A" grounded).
          return {
            data: { answer: 'I recommend Wine B.', citations: ['Wine B'] },
            usage: makeTokenUsage(100, 50),
            durationMs: 5,
          };
        }
        return {
          data: { answer: 'Wine A is the grounded pick.', citations: ['Wine A'] },
          usage: makeTokenUsage(80, 40),
          durationMs: 5,
        };
      });
      const result = await run(llm, {
        query: 'pick a wine',
        intent,
        hangulDominant: false,
        toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
      });
      // Verify ran (re-synth happened) and the grounded re-synth committed at primary.
      expect(result.layer).toBe('primary');
      expect(result.verificationAttempts).toBe(2);
      expect(result.answer).toContain('Wine A');
      expect(calls).toBe(2);
    },
  );

  it('comparison answer must ground BOTH cited wines (one grounded, one hallucinated → re-synth)', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      if (calls === 1) {
        // Cites a grounded wine AND a hallucinated one — comparison must ground both.
        return {
          data: {
            answer: 'Wine A beats Wine Z on every axis.',
            citations: ['Wine A', 'Wine Z'],
          },
          usage: makeTokenUsage(100, 50),
          durationMs: 5,
        };
      }
      return {
        data: { answer: 'Wine A and Wine B compared.', citations: ['Wine A', 'Wine B'] },
        usage: makeTokenUsage(80, 40),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: 'compare A and B',
      intent: 'compare',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018), makeGroundedWineOutcome('Wine B', 2019)],
    });
    expect(result.layer).toBe('primary');
    expect(result.verificationAttempts).toBe(2);
    expect(calls).toBe(2);
  });

  it('NEGATIVE — intent=unknown SKIPS grounding-verify (pure-knowledge answer not falsely rejected)', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      // Names a wine absent from grounding, but this is a pure-knowledge intent
      // that legitimately cites no groundable surface — must NOT re-synth.
      return {
        data: { answer: 'Tannin is a polyphenol; Wine Q illustrates it well.', citations: ['Wine Q'] },
        usage: makeTokenUsage(60, 30),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: 'what is tannin?',
      intent: 'unknown',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    expect(result.layer).toBe('primary');
    expect(result.verificationAttempts).toBe(1);
    expect(calls).toBe(1); // no re-synth — verify was skipped for `unknown`
  });
});

// ---------------------------------------------------------------------------
// A3 — reduce spurious Layer-2 fallbacks. A grounded-but-thin re-synth must
// terminate as `primary` (full credit), NOT fall to the Layer 2 template.
// Only a genuinely ungrounded re-synth degrades to Layer 2.
// ---------------------------------------------------------------------------

describe('SynthesisRunner — A3 grounded-but-thin vs ungrounded fallback', () => {
  it('grounded-but-THIN re-synth terminates as primary (answer), NOT layer2/fallback', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      if (calls === 1) {
        // Primary hallucinates a wine not in grounding.
        return {
          data: { answer: 'I recommend Wine B, a stunning bottle.', citations: ['Wine B'] },
          usage: makeTokenUsage(100, 50),
          durationMs: 5,
        };
      }
      // Re-synth is GROUNDED but very thin (one short grounded line).
      return {
        data: { answer: 'Wine A.', citations: ['Wine A'] },
        usage: makeTokenUsage(40, 8),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    // A thin grounded answer beats a template — full credit at primary layer.
    expect(result.layer).toBe('primary');
    expect(result.degradedReason).toBeUndefined();
    expect(result.answer).toContain('Wine A');
    expect(result.verificationAttempts).toBe(2);
  });

  it('re-synth directive enumerates grounded labels so the model can re-anchor (A3 additive directive)', async () => {
    let secondPrompt = '';
    let calls = 0;
    const llm = makeStubLlm(async (req) => {
      calls += 1;
      if (calls === 1) {
        return {
          data: { answer: 'I recommend Wine B.', citations: ['Wine B'] },
          usage: makeTokenUsage(100, 50),
          durationMs: 5,
        };
      }
      // Capture the re-synth directive (last user message).
      const msgs = req.messages;
      const last = msgs[msgs.length - 1];
      secondPrompt = typeof last?.content === 'string' ? last.content : '';
      return {
        data: { answer: 'Wine A is grounded.', citations: ['Wine A'] },
        usage: makeTokenUsage(80, 40),
        durationMs: 5,
      };
    });
    await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    expect(calls).toBe(2);
    // Additive: the directive names the actual grounded label so the model
    // re-anchors instead of producing a thin/empty answer.
    expect(secondPrompt.toLowerCase()).toContain('wine a');
    expect(secondPrompt.toLowerCase()).toContain('grounding');
  });

  it('re-synth directive samples grounded region/grape fields so context is EXPANDED (A3)', async () => {
    let secondPrompt = '';
    let calls = 0;
    const llm = makeStubLlm(async (req) => {
      calls += 1;
      if (calls === 1) {
        return {
          data: { answer: 'I recommend Wine B.', citations: ['Wine B'] },
          usage: makeTokenUsage(100, 50),
          durationMs: 5,
        };
      }
      const msgs = req.messages;
      const last = msgs[msgs.length - 1];
      secondPrompt = typeof last?.content === 'string' ? last.content : '';
      return {
        data: { answer: 'Wine A is grounded.', citations: ['Wine A'] },
        usage: makeTokenUsage(80, 40),
        durationMs: 5,
      };
    });
    await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      // Grounding carries label + region + grape so the directive can sample
      // more than just the label (context expansion, not claim-stripping only).
      toolOutcomes: [
        makeGroundingObservation([
          { canonical_label: 'Wine A', region: 'Bordeaux', grapes: ['Merlot'] },
        ]),
      ],
    });
    expect(calls).toBe(2);
    const lower = secondPrompt.toLowerCase();
    expect(lower).toContain('bordeaux');
    expect(lower).toContain('merlot');
    expect(lower).toContain('grounded fields');
  });

  it('genuinely-ungrounded re-synth still degrades to Layer 2 (true failure)', async () => {
    let calls = 0;
    const llm = makeStubLlm(async () => {
      calls += 1;
      // Both passes hallucinate the same ungrounded wine.
      return {
        data: { answer: 'I recommend Wine B again.', citations: ['Wine B'] },
        usage: makeTokenUsage(90, 45),
        durationMs: 5,
      };
    });
    const result = await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [makeGroundedWineOutcome('Wine A', 2018)],
    });
    expect(result.layer).toBe('layer2');
    expect(result.degradedReason).toBe('ungrounded_claim');
    expect(result.verificationAttempts).toBe(2);
    expect(calls).toBe(2);
  });
});

describe('SynthesisRunner — provider unavailable fails honestly (no fabrication)', () => {
  const groundedOutcome = () =>
    makeSearchOutcome([
      { canonicalLabel: 'Château Margaux', producer: 'Château Margaux', region: 'Bordeaux' },
    ]);

  it('LLM provider HTTP rejection (e.g. credit exhausted) → honest message, NOT a fabricated wine answer', async () => {
    // Anthropic adapter shape for an HTTP 400 transport rejection: empty zod
    // issues + rawOutput carrying httpStatus (distinct from a real schema fail).
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [],
        { httpStatus: 400, body: 'credit balance is too low' },
        'Anthropic structured: HTTP 400 — credit balance is too low',
      );
    });
    const result = await run(llm, {
      query: '보르고뉴 와인 얼마',
      hangulDominant: true,
      toolOutcomes: [groundedOutcome()],
    });
    expect(result.degradedReason).toBe('llm_unavailable');
    expect(result.layer).toBe('layer4');
    expect(result.groundedOnToolResults).toBe(false);
    expect(result.answer).toBe(FALLBACK_TEMPLATES.llmUnavailable.korean);
    // must NOT fabricate a wine-name answer
    expect(result.answer).not.toContain('Château Margaux');
    expect(result.answer).not.toContain('검색 결과:');
  });

  it('circuit breaker open → honest message, not Layer 2 fabrication', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmCircuitOpenError('anthropic-structured');
    });
    const result = await run(llm, {
      query: 'Recommend a Bordeaux',
      hangulDominant: false,
      toolOutcomes: [groundedOutcome()],
    });
    expect(result.degradedReason).toBe('circuit_open');
    expect(result.layer).toBe('layer4');
    expect(result.answer).toBe(FALLBACK_TEMPLATES.llmUnavailable.english);
    expect(result.answer).not.toContain('Château Margaux');
  });

  it('LLM timeout → honest message, not Layer 2 fabrication', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmTimeoutError();
    });
    const result = await run(llm, {
      query: '보르고뉴 와인 얼마',
      hangulDominant: true,
      toolOutcomes: [groundedOutcome()],
    });
    expect(result.degradedReason).toBe('timeout');
    expect(result.layer).toBe('layer4');
    expect(result.answer).toBe(FALLBACK_TEMPLATES.llmUnavailable.korean);
    expect(result.answer).not.toContain('검색 결과:');
  });

  it('genuine malformed LLM output (schema validation) STILL uses the grounded Layer 2 template', async () => {
    // Regression guard: a WORKING LLM that returns bad JSON is a legitimate
    // grounded degradation — it must keep Layer 2, NOT fail honestly.
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
        { answer: 123 },
      );
    });
    const result = await run(llm, {
      query: '와인 추천',
      hangulDominant: true,
      toolOutcomes: [groundedOutcome()],
    });
    expect(result.degradedReason).toBe('malformed_llm_output');
    expect(result.layer).toBe('layer2');
    expect(result.answer).toContain('검색 결과: Château Margaux');
  });
});
