/**
 * Regression: ComparisonLlmFallback — one-shot grounded LLM synthesis for
 * stalled comparison_nested queries.
 *
 * Bench v9 found 4 comparison_nested scenarios (#30/#31/#32/#117) that all
 * terminated with `terminationReason: 'max_steps'` because the multi-step
 * compare→rank→drinkability→synthesize plan exhausted the LLM-turn budget.
 * This regression locks in the fallback's contract:
 *
 *   - Successful fallback: mock LLM returns valid JSON →
 *     `kind: 'produced'` carrying chosenSide / reasoning / answer.
 *   - LLM refusal → `kind: 'failed'` with `reason: 'refusal'` (no crash).
 *   - Per-leg minimum violated → `kind: 'declined_no_candidates'`.
 *   - Token usage propagates on every code path.
 *   - Zod schema rejects malformed JSON shape →
 *     `kind: 'failed'` with `reason: 'malformed_llm_output'`.
 *   - Abort signal causes the runner to re-throw (orchestrator owns abort
 *     propagation — CLAUDE.md cooperative-abort discipline).
 *   - `extractCandidateFields` accepts both entity-wrapped and flat shapes.
 *
 * CLAUDE.md rule 5: covers ASCII, Korean (한글), and accented-Latin queries.
 * CLAUDE.md rule 7: every new branch (`produced` / `declined_no_candidates`
 * / `failed`) is exercised with both happy and adversarial inputs.
 */

import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  StructuredLlmCircuitOpenError,
  StructuredLlmPartialOutputError,
  StructuredLlmRefusalError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
  type AnalyzeRequest,
  type AnalyzeResult,
  type ExecuteRequest,
  type ExecuteResult,
  type StructuredLlmPort,
  type SynthesizeRequest,
  type SynthesizeResult,
} from '../../src/domain/ai/port/structured-llm.port.js';
import {
  ComparisonFallbackAnswerSchema,
  extractCandidateFields,
  runComparisonLlmFallback,
  type ComparisonFallbackAnswer,
  type ComparisonLlmFallbackInput,
  type ComparisonLlmFallbackLeg,
} from '../../src/application/wine-search/comparison-llm-fallback.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-regress-comp-fallback';
const PER_STEP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;
const SAMPLE_TOKEN_USAGE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

function makeLeg(
  label: 'A' | 'B',
  legQuery: string,
  count: number,
): ComparisonLlmFallbackLeg {
  const candidates = Array.from({ length: count }, (_, i) => ({
    canonicalLabel: `${label}-Wine-${String(i)}`,
    producer: `${label} Producer`,
    region: `${label} Region`,
    vintage: 2018 + i,
    grapes: ['Nebbiolo'],
    criticScore: 0.85,
    drinkingWindowStart: 2024,
    drinkingWindowEnd: 2035,
  }));
  return { leg: label, legQuery, candidates };
}

function makeInput(overrides: Partial<ComparisonLlmFallbackInput> = {}): ComparisonLlmFallbackInput {
  return {
    query: '바롤로 vs 브루넬로, 둘 중 지금 마시기 좋은 거?',
    requestId: REQUEST_ID,
    originalRetrievalDocs: [makeLeg('A', '바롤로', 3), makeLeg('B', '브루넬로', 3)],
    perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    hangulDominant: true,
    ...overrides,
  };
}

function makeStubLlm(
  impl: (req: SynthesizeRequest<z.ZodTypeAny>) => Promise<SynthesizeResult<ComparisonFallbackAnswer>>,
): StructuredLlmPort {
  const synthesizeMock = vi.fn(impl);
  return {
    analyze: <TSchema extends z.ZodTypeAny>(
      _req: AnalyzeRequest<TSchema>,
    ): Promise<AnalyzeResult<z.infer<TSchema>>> => {
      throw new Error('analyze should not be called by ComparisonLlmFallback');
    },
    execute: (_req: ExecuteRequest): Promise<ExecuteResult> => {
      throw new Error('execute should not be called by ComparisonLlmFallback');
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

// ---------------------------------------------------------------------------
// Tests — produced path (Korean / English / accented Latin)
// ---------------------------------------------------------------------------

describe('ComparisonLlmFallback — successful verdict path', () => {
  it('Korean query: returns produced verdict with chosenSide/reasoning/answer', async () => {
    const llm = makeStubLlm(async (req) => {
      // The prompt should reference both legs.
      const body = req.messages.map((m) => m.content).join('\n');
      expect(body).toContain('Leg A');
      expect(body).toContain('Leg B');
      expect(body).toContain('바롤로');
      return {
        data: {
          chosenSide: 'A',
          reasoning: 'A-Wine-0 has earlier drinking_window_start (2024) and matches the user intent of "지금 마시기 좋은 거"',
          answer: '지금 마시기에는 바롤로(A-Wine-0)가 더 적합합니다. 드링킹 윈도우가 2024년에 시작하여 현재 음용 가능합니다.',
        },
        usage: SAMPLE_TOKEN_USAGE,
        durationMs: 250,
      };
    });
    const result = await runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() });
    expect(result.kind).toBe('produced');
    if (result.kind !== 'produced') return;
    expect(result.output.chosenSide).toBe('A');
    expect(result.output.answer.length).toBeGreaterThan(0);
    expect(result.output.reasoning.length).toBeGreaterThan(0);
    expect(result.output.tokenUsage.inputTokens).toBe(100);
    expect(result.output.tokenUsage.outputTokens).toBe(50);
  });

  it('English query: returns produced verdict with chosenSide=B', async () => {
    const llm = makeStubLlm(async () => ({
      data: {
        chosenSide: 'B',
        reasoning: 'B has a higher critic_score and broader drinking window.',
        answer: 'For drinking now, Brunello (B-Wine-0) is the better choice. Its critic score is comparable while its drinking window extends further.',
      } satisfies ComparisonFallbackAnswer,
      usage: SAMPLE_TOKEN_USAGE,
      durationMs: 200,
    }));
    const result = await runComparisonLlmFallback(
      makeInput({
        query: 'Barolo vs Brunello, which is better to drink now?',
        hangulDominant: false,
      }),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('produced');
    if (result.kind !== 'produced') return;
    expect(result.output.chosenSide).toBe('B');
    expect(result.output.answer).toContain('Brunello');
  });

  it('Accented-Latin query: classifier remains language-agnostic', async () => {
    // CLAUDE.md rule 5: accented Latin (é, ñ, Château) must not change the
    // branch decision — the fallback's classification is structure-based.
    const llm = makeStubLlm(async () => ({
      data: {
        chosenSide: 'tie',
        reasoning: 'Both legs carry similar critic_score and drinking_window data.',
        answer: 'Château A and Château B are indistinguishable for current drinking.',
      } satisfies ComparisonFallbackAnswer,
      usage: SAMPLE_TOKEN_USAGE,
      durationMs: 180,
    }));
    const result = await runComparisonLlmFallback(
      makeInput({
        query: 'Château Pétrus vs Château Margaux — quelle est la meilleure ?',
        hangulDominant: false,
      }),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('produced');
    if (result.kind !== 'produced') return;
    expect(result.output.chosenSide).toBe('tie');
  });
});

// ---------------------------------------------------------------------------
// Tests — declined path (insufficient candidates)
// ---------------------------------------------------------------------------

describe('ComparisonLlmFallback — declined_no_candidates path', () => {
  it('empty leg A: declines with totalCandidates count', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must NOT be called when candidates are insufficient');
    });
    const result = await runComparisonLlmFallback(
      makeInput({
        originalRetrievalDocs: [makeLeg('A', 'q', 0), makeLeg('B', 'q', 3)],
      }),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('declined_no_candidates');
    if (result.kind !== 'declined_no_candidates') return;
    expect(result.totalCandidates).toBe(3);
  });

  it('both legs empty: declines without calling LLM', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must NOT be called');
    });
    const result = await runComparisonLlmFallback(
      makeInput({
        originalRetrievalDocs: [makeLeg('A', 'q', 0), makeLeg('B', 'q', 0)],
      }),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('declined_no_candidates');
  });

  it('zero legs: declines without calling LLM', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('LLM must NOT be called');
    });
    const result = await runComparisonLlmFallback(
      makeInput({ originalRetrievalDocs: [] }),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('declined_no_candidates');
  });
});

// ---------------------------------------------------------------------------
// Tests — failed path (LLM errors)
// ---------------------------------------------------------------------------

describe('ComparisonLlmFallback — failed path classifies LLM errors', () => {
  it('StructuredLlmRefusalError → failed with reason=refusal', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmRefusalError();
    });
    const result = await runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('refusal');
    // Token usage is still tracked (zero in this case) so the orchestrator
    // can aggregate without conditional branches.
    expect(result.tokenUsage.inputTokens).toBe(0);
  });

  it('StructuredLlmTimeoutError → failed with reason=timeout', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmTimeoutError();
    });
    const result = await runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('timeout');
  });

  it('StructuredLlmCircuitOpenError → failed with reason=circuit_open', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmCircuitOpenError('comparison-fallback');
    });
    const result = await runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('circuit_open');
  });

  it('StructuredLlmValidationError → failed with reason=malformed_llm_output', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
        { not: 'shaped' },
      );
    });
    const result = await runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('malformed_llm_output');
  });

  it('StructuredLlmPartialOutputError → failed with reason=partial_output', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmPartialOutputError({ truncated: true });
    });
    const result = await runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('partial_output');
  });

  it('generic Error → failed with reason=unexpected_error', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('downstream adapter exploded');
    });
    const result = await runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('unexpected_error');
  });

  it('LLM returns shape that fails Zod parse → failed with reason=malformed_llm_output', async () => {
    // The LLM "succeeded" at the adapter level but returned a payload the
    // schema cannot accept. We surface this as `malformed_llm_output`
    // (same classification as StructuredLlmValidationError, but the
    // mechanism here is the safeParse on the typed `data` field).
    const llm = makeStubLlm(async () => ({
      data: {
        // Missing `reasoning`, missing `answer`, invalid chosenSide.
        chosenSide: 'INVALID' as 'A',
      } as ComparisonFallbackAnswer,
      usage: SAMPLE_TOKEN_USAGE,
      durationMs: 100,
    }));
    const result = await runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.reason).toBe('malformed_llm_output');
    // Token usage still tracked — the LLM call did happen.
    expect(result.tokenUsage.inputTokens).toBe(SAMPLE_TOKEN_USAGE.inputTokens);
  });
});

// ---------------------------------------------------------------------------
// Tests — abort propagation
// ---------------------------------------------------------------------------

describe('ComparisonLlmFallback — abort propagation', () => {
  it('AbortError is re-thrown (orchestrator owns abort semantics)', async () => {
    const llm = makeStubLlm(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    await expect(
      runComparisonLlmFallback(makeInput(), llm, { logger: makeLogger() }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — Zod schema
// ---------------------------------------------------------------------------

describe('ComparisonLlmFallback — Zod schema discipline', () => {
  it('accepts a valid payload', () => {
    const parsed = ComparisonFallbackAnswerSchema.safeParse({
      chosenSide: 'A',
      reasoning: 'r',
      answer: 'a',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects invalid chosenSide', () => {
    const parsed = ComparisonFallbackAnswerSchema.safeParse({
      chosenSide: 'C',
      reasoning: 'r',
      answer: 'a',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty answer', () => {
    const parsed = ComparisonFallbackAnswerSchema.safeParse({
      chosenSide: 'A',
      reasoning: 'r',
      answer: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('NOT strict: tolerates extra LLM-emitted fields (CLAUDE.md rule 10 exception)', () => {
    // LLMs routinely emit extra keys (reasoning_trace, confidence). The
    // schema MUST tolerate them — `.strict()` would fail the entire parse
    // on a single extra key, defeating the fallback.
    const parsed = ComparisonFallbackAnswerSchema.safeParse({
      chosenSide: 'B',
      reasoning: 'r',
      answer: 'a',
      reasoning_trace: 'extra field the LLM added',
      confidence: 0.92,
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — extractCandidateFields structural narrowing
// ---------------------------------------------------------------------------

describe('extractCandidateFields — structural narrowing', () => {
  it('accepts the entity-wrapped SearchResponseV1 shape', () => {
    const raw = {
      entity: {
        canonicalLabel: 'Opus One 2018',
        producer: 'Opus One',
        region: 'Napa Valley',
        vintage: 2018,
        grapes: ['Cabernet Sauvignon'],
      },
      drinkingWindow: {
        drinkingWindowStart: 2024,
        drinkingWindowEnd: 2040,
      },
    };
    const out = extractCandidateFields(raw);
    expect(out.canonicalLabel).toBe('Opus One 2018');
    expect(out.producer).toBe('Opus One');
    expect(out.vintage).toBe(2018);
    expect(out.drinkingWindowStart).toBe(2024);
    expect(out.drinkingWindowEnd).toBe(2040);
  });

  it('accepts the flat-entity shape', () => {
    const raw = {
      canonicalLabel: 'Sassicaia 2019',
      region: 'Bolgheri',
    };
    const out = extractCandidateFields(raw);
    expect(out.canonicalLabel).toBe('Sassicaia 2019');
    expect(out.region).toBe('Bolgheri');
  });

  it('OMITS fields that are non-finite or empty (does not set to null/0)', () => {
    const raw = {
      entity: {
        canonicalLabel: '',         // empty string → omitted (trim check)
        producer: '   ',            // whitespace-only → omitted
        vintage: Number.NaN,        // NaN → omitted
        criticScore: Number.POSITIVE_INFINITY, // not finite → omitted
        grapes: ['', '  '],         // all empty → omitted
      },
    };
    const out = extractCandidateFields(raw);
    expect(out.canonicalLabel).toBeUndefined();
    expect(out.producer).toBeUndefined();
    expect(out.vintage).toBeUndefined();
    expect(out.criticScore).toBeUndefined();
    expect(out.grapes).toBeUndefined();
  });

  it('handles null / non-object input defensively (returns empty object)', () => {
    expect(extractCandidateFields(null)).toEqual({});
    expect(extractCandidateFields(undefined)).toEqual({});
    expect(extractCandidateFields('string')).toEqual({});
    expect(extractCandidateFields(42)).toEqual({});
  });

  it('Korean canonicalLabel passes through unchanged', () => {
    // CLAUDE.md rule 5: Korean (한글) must not be lost in the narrowing.
    const out = extractCandidateFields({ canonicalLabel: '사씨카이아 2019' });
    expect(out.canonicalLabel).toBe('사씨카이아 2019');
  });
});
