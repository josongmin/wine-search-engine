/**
 * Regression: SynthesisRunner.runPrimary distinguishes unmodeled exceptions
 * from `StructuredLlmValidationError`.
 *
 * Finding P-M1 (MEDIUM): the catch ladder used to classify ALL non-modeled
 * errors as `malformed_llm_output`, losing operational distinction between
 * "LLM returned a bad-shape JSON" and "something else exploded inside the
 * structured-LLM adapter". The fix adds a new `degradedReason` enum value
 * `'unexpected_error'` and routes generic Errors to it on BOTH the first
 * attempt and the retry.
 *
 * This regression locks in:
 *   - StructuredLlmValidationError → `malformed_llm_output` (unchanged)
 *   - StructuredLlmRefusalError → `policy_blocked` (unchanged early-return)
 *   - StructuredLlmTimeoutError → `timeout` (unchanged, no retry)
 *   - StructuredLlmCircuitOpenError → `circuit_open` (unchanged, early-return)
 *   - StructuredLlmPartialOutputError → `malformed_llm_output` (unchanged)
 *   - generic `new Error()` → `unexpected_error` (NEW behavior)
 *   - non-Error throw (string) → `unexpected_error` (defensive)
 *   - Schema enums (synthesis-schemas + wine-search-result-schemas + the
 *     HTTP wire schema) all accept `'unexpected_error'`.
 *
 * CLAUDE.md rule 5: covers ASCII, Korean (한글), and accented-Latin queries.
 * CLAUDE.md rule 7: every new branch is exercised with both happy and
 * adversarial inputs (legitimate error class vs. unexpected error class).
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
import type { ToolOutcome } from '../../src/domain/agent/model/tool-outcome.js';
import { SynthesisRunner } from '../../src/application/wine-search/synthesis-runner.js';
import {
  type AnswerResult,
  type SynthesisAnswer,
} from '../../src/application/wine-search/synthesis-schemas.js';
import { WineSearchResultSchema } from '../../src/application/wine-search/wine-search-result-schemas.js';
import { WineSearchDegradedReasonSchema } from '../../src/interface/http/schemas/wine-search.schema.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-regress-pm1';
const PER_STEP_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Helpers
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

function makeSearchOutcome(canonicalLabel: string, producer = 'P', region = 'R'): ToolOutcome {
  return {
    stepId: 'q:0:0',
    tool: 'search_hybrid',
    kind: 'success',
    durationMs: 12,
    result: {
      queryType: 'search',
      results: [{ entity: { canonicalLabel, producer, region } }],
    },
  };
}

function makeStubLlm(
  impl: (req: SynthesizeRequest<z.ZodTypeAny>) => Promise<SynthesizeResult<SynthesisAnswer>>,
): StructuredLlmPort {
  const synthesizeMock = vi.fn(impl);
  return {
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

async function run(
  llm: StructuredLlmPort,
  query: string,
  hangulDominant: boolean,
): Promise<AnswerResult> {
  const runner = new SynthesisRunner({ structuredLlm: llm, logger: makeLogger() });
  return runner.run({
    query,
    requestId: REQUEST_ID,
    analysis: makeAnalysis(query, hangulDominant),
    toolOutcomes: [makeSearchOutcome('Wine X')],
    policyBlocked: false,
    perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SynthesisRunner — P-M1: unmodeled exceptions classified as `unexpected_error`', () => {
  it('generic Error on attempt 1 → degradedReason=unexpected_error (English query)', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('downstream adapter exploded');
    });
    const result = await run(llm, 'recommend a Bordeaux', /* hangulDominant */ false);
    expect(result.layer).toBe('layer2');
    expect(result.degradedReason).toBe('unexpected_error');
    // The retry still runs (we don't short-circuit on unexpected), so attempts === 2.
    expect(result.synthesisAttempts).toBe(2);
  });

  it('generic Error on attempt 1 → degradedReason=unexpected_error (Korean query, hangul fallback layer)', async () => {
    const llm = makeStubLlm(async () => {
      throw new Error('downstream adapter exploded');
    });
    const result = await run(llm, '보르도 와인 추천해주세요', /* hangulDominant */ true);
    expect(result.degradedReason).toBe('unexpected_error');
    expect(result.layer).toBe('layer2');
  });

  it('generic Error with accented-Latin query → degradedReason=unexpected_error', async () => {
    // CLAUDE.md rule 5: accented Latin (é, ñ, Château) must not change the
    // classification path — the synthesis runner's branch decisions are
    // language-agnostic.
    const llm = makeStubLlm(async () => {
      throw new Error('boom');
    });
    const result = await run(llm, 'recommend a Château Pétrus', /* hangulDominant */ false);
    expect(result.degradedReason).toBe('unexpected_error');
  });

  it('thrown non-Error (string) → degradedReason=unexpected_error (defensive)', async () => {
    const llm = makeStubLlm(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'bare string thrown';
    });
    const result = await run(llm, 'recommend a wine', false);
    expect(result.degradedReason).toBe('unexpected_error');
  });
});

describe('SynthesisRunner — P-M1: modeled exceptions keep their existing reason', () => {
  it('StructuredLlmValidationError → malformed_llm_output (unchanged)', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmValidationError(
        [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
        { not: 'shaped' },
      );
    });
    const result = await run(llm, 'recommend a wine', false);
    expect(result.degradedReason).toBe('malformed_llm_output');
  });

  it('StructuredLlmPartialOutputError → malformed_llm_output (unchanged)', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmPartialOutputError({ truncated: true });
    });
    const result = await run(llm, 'recommend a wine', false);
    expect(result.degradedReason).toBe('malformed_llm_output');
  });

  it('StructuredLlmRefusalError → policy_blocked (unchanged, early-return on attempt 1)', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmRefusalError();
    });
    const result = await run(llm, '와인 추천', /* hangulDominant */ true);
    expect(result.degradedReason).toBe('policy_blocked');
    expect(result.synthesisAttempts).toBe(1);
  });

  it('StructuredLlmTimeoutError → timeout (unchanged, no retry)', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmTimeoutError();
    });
    const result = await run(llm, 'wine', false);
    expect(result.degradedReason).toBe('timeout');
    expect(result.synthesisAttempts).toBe(1);
  });

  it('StructuredLlmCircuitOpenError → circuit_open (unchanged, early-return)', async () => {
    const llm = makeStubLlm(async () => {
      throw new StructuredLlmCircuitOpenError('synth');
    });
    const result = await run(llm, 'wine', false);
    expect(result.degradedReason).toBe('circuit_open');
    expect(result.synthesisAttempts).toBe(1);
  });
});

describe('SynthesisRunner — P-M1: retry catch also classifies unmodeled errors', () => {
  it('attempt 1 = validation error, attempt 2 = generic Error → degradedReason=unexpected_error', async () => {
    let call = 0;
    const llm = makeStubLlm(async () => {
      call += 1;
      if (call === 1) {
        throw new StructuredLlmValidationError(
          [{ code: 'custom', message: 'bad', path: [] } as z.ZodIssue],
          { not: 'shaped' },
        );
      }
      throw new Error('retry adapter exploded');
    });
    const result = await run(llm, 'wine', false);
    expect(result.synthesisAttempts).toBe(2);
    expect(result.degradedReason).toBe('unexpected_error');
  });
});

describe('SynthesisRunner — P-M1: schema enums accept the new value', () => {
  it('`unexpected_error` parses through WineSearchDegradedReasonSchema (HTTP wire)', () => {
    const parsed = WineSearchDegradedReasonSchema.safeParse('unexpected_error');
    expect(parsed.success).toBe(true);
  });

  it('`unexpected_error` parses through WineSearchResultSchema.degradedReason (orchestrator)', () => {
    // Build a minimal valid WineSearchResult and verify the degradedReason
    // field accepts the new enum value end-to-end.
    const minimal = {
      answer: 'placeholder answer',
      layer: 'layer4' as const,
      groundedOnToolResults: false,
      toolOutcomes: [],
      executionSteps: [],
      toolCallCount: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      totalDurationMs: 0,
      terminationReason: 'fallback' as const,
      policyBlocked: false,
      degradedReason: 'unexpected_error' as const,
      intent: 'search' as const,
      planKind: 'single-search' as const,
    };
    const parsed = WineSearchResultSchema.safeParse(minimal);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.flatten())).toBe(true);
  });
});
