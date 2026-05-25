/**
 * Regression: ComparisonLlmFallback — leg-minimum is the single source of
 * truth for the decline gate.
 *
 * Before this fix the runner carried two coupled checks:
 *   (1) `totalCandidates < MIN_TOTAL_CANDIDATES_FOR_FALLBACK` where the
 *       constant was named "total" but valued `1`, while the runtime semantics
 *       (everyLegHasMinimum + per-leg ≥1) actually required ≥2 total. The
 *       constant's name and value disagreed, leaving a misleading secondary
 *       metric in the decline branch.
 *   (2) `!everyLegHasMinimum` — the only check that actually mattered.
 *
 * The fix removes `MIN_TOTAL_CANDIDATES_FOR_FALLBACK` and consolidates the
 * decline condition to `!everyLegHasMinimum || legCount < 2`. This regression
 * locks the *behavioural* contract so future refactors can't silently let
 * "leg A has 0, leg B has 5" through into the LLM call (which would
 * fabricate the missing side).
 *
 * CLAUDE.md rule 4: regression test exercising every branch that previously
 * shared the conflated constant.
 * CLAUDE.md rule 25 / 30: a single SSoT for the candidate-budget gate;
 * deleting the duplicated constant prevents drift.
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
import {
  runComparisonLlmFallback,
  type ComparisonFallbackAnswer,
  type ComparisonLlmFallbackInput,
  type ComparisonLlmFallbackLeg,
} from '../../src/application/wine-search/comparison-llm-fallback.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-regress-comp-fallback-leg-min';
const PER_STEP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;
const SAMPLE_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

function makeLeg(label: 'A' | 'B', count: number): ComparisonLlmFallbackLeg {
  const candidates = Array.from({ length: count }, (_, i) => ({
    canonicalLabel: `${label}-Wine-${String(i)}`,
    producer: `${label} Producer`,
    region: `${label} Region`,
    vintage: 2020,
    grapes: ['Nebbiolo'],
    criticScore: 0.8,
  }));
  return { leg: label, legQuery: `leg-${label}-query`, candidates };
}

function makeInput(
  legs: ReadonlyArray<ComparisonLlmFallbackLeg>,
): ComparisonLlmFallbackInput {
  return {
    query: 'Barolo vs Brunello — which is better to drink now?',
    requestId: REQUEST_ID,
    originalRetrievalDocs: legs,
    perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    hangulDominant: false,
  };
}

function makeProducedLlm(): StructuredLlmPort {
  const synth = vi.fn(
    async (
      _req: SynthesizeRequest<z.ZodTypeAny>,
    ): Promise<SynthesizeResult<ComparisonFallbackAnswer>> => ({
      data: {
        chosenSide: 'A',
        reasoning: 'A has stronger drinking-window match.',
        answer: 'A is the better pick for drinking now.',
      },
      usage: SAMPLE_USAGE,
      durationMs: 100,
    }),
  );
  return {
    analyze: <TSchema extends z.ZodTypeAny>(
      _req: AnalyzeRequest<TSchema>,
    ): Promise<AnalyzeResult<z.infer<TSchema>>> => {
      throw new Error('analyze must not be called');
    },
    execute: (_req: ExecuteRequest): Promise<ExecuteResult> => {
      throw new Error('execute must not be called');
    },
    synthesize: <TSchema extends z.ZodTypeAny>(
      req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<z.infer<TSchema>>> =>
      synth(req as unknown as SynthesizeRequest<z.ZodTypeAny>) as unknown as Promise<
        SynthesizeResult<z.infer<TSchema>>
      >,
  };
}

function makeRejectingLlm(message: string): StructuredLlmPort {
  return {
    analyze: <TSchema extends z.ZodTypeAny>(
      _req: AnalyzeRequest<TSchema>,
    ): Promise<AnalyzeResult<z.infer<TSchema>>> => {
      throw new Error('analyze must not be called');
    },
    execute: (_req: ExecuteRequest): Promise<ExecuteResult> => {
      throw new Error('execute must not be called');
    },
    synthesize: <TSchema extends z.ZodTypeAny>(
      _req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<z.infer<TSchema>>> => {
      throw new Error(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Decline-gate matrix
// ---------------------------------------------------------------------------

describe('ComparisonLlmFallback — leg-minimum decline gate (SSoT)', () => {
  it('leg A=0, leg B=5 → declines with totalCandidates=5 (per-leg minimum violated)', async () => {
    const llm = makeRejectingLlm('LLM must NOT be called when one leg is empty');
    const result = await runComparisonLlmFallback(
      makeInput([makeLeg('A', 0), makeLeg('B', 5)]),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('declined_no_candidates');
    if (result.kind !== 'declined_no_candidates') return;
    expect(result.totalCandidates).toBe(5);
  });

  it('leg A=5, leg B=0 → declines with totalCandidates=5 (symmetry — per-leg gate is order-independent)', async () => {
    const llm = makeRejectingLlm('LLM must NOT be called when one leg is empty');
    const result = await runComparisonLlmFallback(
      makeInput([makeLeg('A', 5), makeLeg('B', 0)]),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('declined_no_candidates');
    if (result.kind !== 'declined_no_candidates') return;
    expect(result.totalCandidates).toBe(5);
  });

  it('both legs ≥1 → fallback proceeds (LLM is called)', async () => {
    const llm = makeProducedLlm();
    const result = await runComparisonLlmFallback(
      makeInput([makeLeg('A', 1), makeLeg('B', 1)]),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('produced');
  });

  it('both legs 0 → declines with totalCandidates=0', async () => {
    const llm = makeRejectingLlm('LLM must NOT be called');
    const result = await runComparisonLlmFallback(
      makeInput([makeLeg('A', 0), makeLeg('B', 0)]),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('declined_no_candidates');
    if (result.kind !== 'declined_no_candidates') return;
    expect(result.totalCandidates).toBe(0);
  });

  it('single-leg input → declines (comparison verdict needs two sides)', async () => {
    const llm = makeRejectingLlm('LLM must NOT be called for a single leg');
    const result = await runComparisonLlmFallback(
      makeInput([makeLeg('A', 3)]),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('declined_no_candidates');
  });

  it('zero legs → declines without calling LLM', async () => {
    const llm = makeRejectingLlm('LLM must NOT be called');
    const result = await runComparisonLlmFallback(
      makeInput([]),
      llm,
      { logger: makeLogger() },
    );
    expect(result.kind).toBe('declined_no_candidates');
  });
});
