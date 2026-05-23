/**
 * Tests for `StructuredLlmJudge` — the LLM-as-judge adapter that feeds the
 * bench scorer's `judge` and `faithfulness` dimensions.
 *
 * The `StructuredLlmPort` is mocked so the rubric / clamp / failure-handling
 * logic is testable without a live Anthropic backend.
 */

import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  StructuredLlmJudge,
  JudgeOutputSchema,
  DEFAULT_JUDGE_MODEL,
  type JudgeResult,
} from '../llm-judge.js';
import type {
  StructuredLlmPort,
  SynthesizeRequest,
  SynthesizeResult,
  TokenUsage,
  AnalyzeRequest,
  AnalyzeResult,
  ExecuteRequest,
  ExecuteResult,
} from '@domain/ai/port/structured-llm.port.js';
import {
  StructuredLlmValidationError,
  StructuredLlmTimeoutError,
  StructuredLlmRefusalError,
  StructuredLlmPartialOutputError,
  StructuredLlmCircuitOpenError,
} from '@domain/ai/port/structured-llm.port.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USAGE: TokenUsage = {
  inputTokens: 120,
  outputTokens: 40,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

/**
 * Build a mock `StructuredLlmPort` whose `synthesize` returns the given data
 * (or throws the given error). `analyze` / `execute` are unused by the judge.
 */
function makeStructuredLlm(opts: {
  readonly data?: unknown;
  readonly throws?: Error;
  readonly onSynthesize?: (req: SynthesizeRequest<z.ZodTypeAny>) => void;
}): StructuredLlmPort {
  return {
    analyze: vi.fn(
      async (_req: AnalyzeRequest<z.ZodTypeAny>): Promise<AnalyzeResult<unknown>> => {
        throw new Error('analyze not used by judge');
      },
    ),
    execute: vi.fn(async (_req: ExecuteRequest): Promise<ExecuteResult> => {
      throw new Error('execute not used by judge');
    }),
    synthesize: vi.fn(
      async (
        req: SynthesizeRequest<z.ZodTypeAny>,
      ): Promise<SynthesizeResult<unknown>> => {
        opts.onSynthesize?.(req);
        if (opts.throws !== undefined) throw opts.throws;
        return { data: opts.data, usage: USAGE, durationMs: 12 };
      },
    ),
  };
}

const BASE_INPUT = {
  query: '보르도 레드 와인 추천해줘',
  answer: '샤토 마고 2015를 추천합니다. 풍부한 타닌과 긴 여운이 특징입니다.',
  groundingObservations: ['샤토 마고 2015, 보르도, 레드, ₩850,000'],
  requestId: 'req-1',
} as const;

// ---------------------------------------------------------------------------
// JudgeOutputSchema (parsing)
// ---------------------------------------------------------------------------

describe('JudgeOutputSchema', () => {
  it('parses numeric score + faithfulness', () => {
    const parsed = JudgeOutputSchema.parse({ score: 0.8, faithfulness: 0.9, reasoning: 'ok' });
    expect(parsed.score).toBe(0.8);
    expect(parsed.faithfulness).toBe(0.9);
  });

  it('parses string score (LLM-numeric convention)', () => {
    const parsed = JudgeOutputSchema.parse({ score: '0.8', faithfulness: '0.5', reasoning: 'ok' });
    expect(parsed.score).toBe(0.8);
    expect(parsed.faithfulness).toBe(0.5);
  });

  it('rejects NaN-equivalent string', () => {
    const r = JudgeOutputSchema.safeParse({ score: 'not-a-number', faithfulness: 0.5, reasoning: 'x' });
    expect(r.success).toBe(false);
  });

  it('accepts extra keys (NOT strict — rule 10)', () => {
    const parsed = JudgeOutputSchema.parse({
      score: 0.7,
      faithfulness: 0.7,
      reasoning: 'ok',
      confidence: 0.9,
      criteria: { relevance: 1 },
    });
    expect(parsed.score).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// StructuredLlmJudge.evaluate
// ---------------------------------------------------------------------------

describe('StructuredLlmJudge.evaluate', () => {
  it('happy path: returns score, faithfulness, reasoning, tokenUsage', async () => {
    const llm = makeStructuredLlm({
      data: { score: 0.85, faithfulness: 0.9, reasoning: 'grounded and relevant' },
    });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const result = await judge.evaluate({ ...BASE_INPUT });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.score).toBe(0.85);
    expect(result.faithfulness).toBe(0.9);
    expect(result.reasoning).toBe('grounded and relevant');
    expect(result.tokenUsage).toEqual(USAGE);
  });

  it('clamps out-of-range score (1.5 → 1) and faithfulness (-0.2 → 0)', async () => {
    const warn = vi.fn();
    const llm = makeStructuredLlm({
      data: { score: 1.5, faithfulness: -0.2, reasoning: 'over' },
    });
    const judge = new StructuredLlmJudge({ structuredLlm: llm, logger: { warn } });
    const result = await judge.evaluate({ ...BASE_INPUT });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.score).toBe(1);
    expect(result.faithfulness).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('parses string score ("0.8" → 0.8)', async () => {
    const llm = makeStructuredLlm({
      data: { score: '0.8', faithfulness: '0.6', reasoning: 'str' },
    });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const result = await judge.evaluate({ ...BASE_INPUT });
    if (!result.available) throw new Error('expected available');
    expect(result.score).toBe(0.8);
    expect(result.faithfulness).toBe(0.6);
  });

  it('validation failure → unavailable sentinel (NOT a fabricated 0)', async () => {
    const llm = makeStructuredLlm({
      throws: new StructuredLlmValidationError([], { bad: true }, 'invalid'),
    });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const result = await judge.evaluate({ ...BASE_INPUT });
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toBe('validation');
    // Crucially NOT a 0 — the dim must stay null downstream.
    expect('score' in result).toBe(false);
  });

  it('post-port shape mismatch → unavailable (no cast leaks bad data)', async () => {
    // Port returned a value that does not satisfy the schema (defensive
    // re-validation path). Adapter must report unavailable, not throw.
    const llm = makeStructuredLlm({ data: { score: null, reasoning: 5 } });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const result = await judge.evaluate({ ...BASE_INPUT });
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toBe('validation');
  });

  it.each([
    [new StructuredLlmTimeoutError(), 'timeout'],
    [new StructuredLlmRefusalError(), 'refusal'],
    [new StructuredLlmPartialOutputError({}, 'p'), 'partial'],
    [new StructuredLlmCircuitOpenError('judge'), 'circuit_open'],
  ] as const)('classifies %s → unavailable reason', async (err, reason) => {
    const llm = makeStructuredLlm({ throws: err });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const result = await judge.evaluate({ ...BASE_INPUT });
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toBe(reason);
  });

  it('unknown error → unavailable with reason "unexpected"', async () => {
    const llm = makeStructuredLlm({ throws: new Error('boom') });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const result = await judge.evaluate({ ...BASE_INPUT });
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toBe('unexpected');
  });

  it('abort error propagates (does not become a sentinel)', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const llm = makeStructuredLlm({ throws: abortErr });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    await expect(judge.evaluate({ ...BASE_INPUT })).rejects.toThrow('aborted');
  });

  it('Korean answer judged correctly — rubric handles Korean text', async () => {
    let capturedReq: SynthesizeRequest<z.ZodTypeAny> | undefined;
    const llm = makeStructuredLlm({
      data: { score: 0.95, faithfulness: 0.95, reasoning: '한국어 답변이 질의와 일치' },
      onSynthesize: (req) => {
        capturedReq = req;
      },
    });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const result = await judge.evaluate({ ...BASE_INPUT });
    if (!result.available) throw new Error('expected available');
    expect(result.score).toBe(0.95);
    // The Korean answer must reach the judge prompt verbatim.
    const answerTurn = capturedReq?.messages.find((m) => m.content.includes('샤토 마고'));
    expect(answerTurn).toBeDefined();
  });

  it('enables prompt cache, uses default model, forwards rubric + abort', async () => {
    let capturedReq: SynthesizeRequest<z.ZodTypeAny> | undefined;
    const llm = makeStructuredLlm({
      data: { score: 0.5, faithfulness: 0.5, reasoning: 'r' },
      onSynthesize: (req) => {
        capturedReq = req;
      },
    });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const ctrl = new AbortController();
    await judge.evaluate({ ...BASE_INPUT, rubric: 'Must name a specific vintage.', abortSignal: ctrl.signal });
    expect(capturedReq?.enablePromptCache).toBe(true);
    expect(capturedReq?.model).toBe(DEFAULT_JUDGE_MODEL);
    // Prefix-cache hardening: rubric moved from the systemPrompt into a USER
    // message so the system slot remains byte-identical across judge calls.
    // The total content the LLM sees is unchanged.
    expect(capturedReq?.systemPrompt).not.toContain('Must name a specific vintage.');
    const rubricTurn = capturedReq?.messages.find((m) =>
      m.content.includes('Must name a specific vintage.'),
    );
    expect(rubricTurn).toBeDefined();
    expect(rubricTurn?.role).toBe('user');
    expect(capturedReq?.abortSignal).toBe(ctrl.signal);
  });

  it('empty observations: judge still runs (faithfulness anchored by rubric)', async () => {
    let capturedReq: SynthesizeRequest<z.ZodTypeAny> | undefined;
    const llm = makeStructuredLlm({
      data: { score: 0.6, faithfulness: 1, reasoning: 'honest no-result reply' },
      onSynthesize: (req) => {
        capturedReq = req;
      },
    });
    const judge = new StructuredLlmJudge({ structuredLlm: llm });
    const result: JudgeResult = await judge.evaluate({
      ...BASE_INPUT,
      groundingObservations: [],
    });
    if (!result.available) throw new Error('expected available');
    expect(result.faithfulness).toBe(1);
    const groundingTurn = capturedReq?.messages.find((m) => m.content.startsWith('GROUNDING:'));
    expect(groundingTurn?.content).toContain('no tool observations');
  });
});
