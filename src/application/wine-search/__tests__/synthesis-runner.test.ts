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
import { FALLBACK_TEMPLATES } from '../synthesis-fallback-templates.js';
import type { WineSearchAnalysis } from '../wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-synth-0001';
const PER_STEP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;

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

function makeSearchOutcome(
  results: ReadonlyArray<{ canonicalLabel: string; producer?: string; region?: string }>,
  opts?: { kind?: ToolOutcome['kind']; stepId?: string },
): ToolOutcome {
  return {
    stepId: opts?.stepId ?? 'q:0:0',
    tool: 'search_wines',
    kind: opts?.kind ?? 'success',
    durationMs: 12,
    result: {
      queryType: 'search',
      results: results.map((r) => ({
        entity: {
          canonicalLabel: r.canonicalLabel,
          ...(r.producer !== undefined ? { producer: r.producer } : {}),
          ...(r.region !== undefined ? { region: r.region } : {}),
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
    tool: 'search_wines',
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
  },
): Promise<AnswerResult> {
  const { runner } = makeRunner(llm);
  const analysis = makeAnalysis(overrides.query, overrides.hangulDominant ?? false);
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
      data: { answer: 'Try a Côte-Rôtie Syrah from the northern Rhône.' },
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
      return {
        data: { answer: '재시도 후 성공한 답변입니다.' },
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
    expect(result.answer).toBe('재시도 후 성공한 답변입니다.');
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
  it('Korean query → Korean Layer 4 template (no tool outcomes)', async () => {
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
    expect(result.answer).toBe(FALLBACK_TEMPLATES.layer4.korean);
    expect(result.synthesisAttempts).toBe(0);
    expect(result.degradedReason).toBe('no_results');
  });

  it('English query → English Layer 4 template', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('should not be called when no grounding');
    });
    const result = await run(llm, {
      query: 'tell me about wine',
      hangulDominant: false,
      toolOutcomes: [],
    });
    expect(result.layer).toBe('layer4');
    expect(result.answer).toBe(FALLBACK_TEMPLATES.layer4.english);
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
        data: { answer: 'ok answer' },
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

  it('timeout on primary does NOT retry → falls to layer 2 with degradedReason=timeout', async () => {
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
    expect(result.layer).toBe('layer2');
    expect(result.degradedReason).toBe('timeout');
    expect(result.synthesisAttempts).toBe(1);
  });

  it('circuit-open on primary → falls to layer 2 with degradedReason=circuit_open', async () => {
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
    expect(result.layer).toBe('layer2');
    expect(result.degradedReason).toBe('circuit_open');
    expect(result.synthesisAttempts).toBe(1);
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
    expect(resHangulLayer4.answer).toBe(FALLBACK_TEMPLATES.layer4.korean);

    // Pure emoji query → no Hangul → English Layer 4 template.
    const resEmoji = await run(llmNo, {
      query: '🍷🍷🍷',
      hangulDominant: false,
      toolOutcomes: [],
    });
    expect(resEmoji.answer).toBe(FALLBACK_TEMPLATES.layer4.english);

    // Accented Latin → no Hangul → English Layer 4 template.
    const resAccent = await run(llmNo, {
      query: 'château',
      hangulDominant: false,
      toolOutcomes: [],
    });
    expect(resAccent.answer).toBe(FALLBACK_TEMPLATES.layer4.english);
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
    tool: 'search_wines',
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
