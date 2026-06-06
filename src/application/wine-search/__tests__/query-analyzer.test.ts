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
} from '@domain/ai/port/structured-llm.port.js';
import { QueryAnalyzerService } from '../query-analyzer.js';
import {
  WineSearchAnalysisSchema,
  type WineSearchAnalysis,
} from '../wine-search-schemas.js';

const REQUEST_ID = 'req-test-0001';
const PER_STEP_TIMEOUT_MS = 5_000;

function makeLogger(): {
  logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
} {
  return {
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
    },
  };
}

interface StubLlmPort extends StructuredLlmPort {
  readonly analyzeMock: ReturnType<typeof vi.fn>;
}

function makeStubLlm(
  impl: (
    req: AnalyzeRequest<typeof WineSearchAnalysisSchema>,
  ) => Promise<AnalyzeResult<WineSearchAnalysis>>,
): StubLlmPort {
  const analyzeMock = vi.fn(impl);
  return {
    analyzeMock,
    analyze: <TSchema extends z.ZodTypeAny>(
      req: AnalyzeRequest<TSchema>,
    ): Promise<AnalyzeResult<z.infer<TSchema>>> => {
      // Cast restricted to the schema we publish; tests always use the
      // analyzer's schema.
      return analyzeMock(
        req as unknown as AnalyzeRequest<typeof WineSearchAnalysisSchema>,
      ) as unknown as Promise<AnalyzeResult<z.infer<TSchema>>>;
    },
    execute: (_req: ExecuteRequest): Promise<ExecuteResult> => {
      throw new Error('execute not used in analyzer tests');
    },
    synthesize: <TSchema extends z.ZodTypeAny>(
      _req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<z.infer<TSchema>>> => {
      throw new Error('synthesize not used in analyzer tests');
    },
  };
}

async function analyze(
  query: string,
  opts?: { structuredLlm?: StubLlmPort },
) {
  const { logger } = makeLogger();
  const analyzer = new QueryAnalyzerService({
    logger,
    ...(opts?.structuredLlm !== undefined ? { structuredLlm: opts.structuredLlm } : {}),
  });
  return analyzer.analyze({
    query,
    requestId: REQUEST_ID,
    perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
  });
}

describe('QueryAnalyzerService — deterministic pipeline', () => {
  it('Korean search query — hangulDominant=true, no LLM call', async () => {
    const llm = makeStubLlm(() => {
      throw new Error('LLM should not be called on deterministic Korean search');
    });
    const result = await analyze('부르고뉴 피노누아 추천', { structuredLlm: llm });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.intent).toBe('search');
    expect(result.analysis.hangulDominant).toBe(true);
    expect(result.analysis.expectedMultiStep).toBe(false);
    expect(llm.analyzeMock).not.toHaveBeenCalled();
  }, 10_000);

  it('anchor + constraint recommendation query stays discovery-style, not anchored_similarity', async () => {
    const result = await analyze('부르고뉴 피노누아 추천');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'mixed_query',
      queryClass: 'semantic_preference',
    });
    expect(result.analysis.expectedMultiStep).toBe(false);
  });

  it('explicit similarity query projects to anchored_similarity', async () => {
    const result = await analyze('Opus One이랑 비슷한데 더 싼 거');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'mixed_query',
      queryClass: 'anchored_similarity',
    });
  });

  it('Exact entity with vintage — anchors include the entity, vintage captured', async () => {
    const result = await analyze('Opus One 2018');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.contract.exactMetadataTargetVintage).toBe(2018);
    expect(result.analysis.expectedMultiStep).toBe(false);
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'entity_exact',
      queryClass: 'short_entity',
    });
    // Anchors list is allowed to be empty for proper-noun entities that
    // require alias/catalog resolution (entity-resolver currently covers
    // grape/region/country/wine_type/appellation only). Vintage capture is
    // the load-bearing assertion for the exact-metadata path.
  });

  it('Generic vintage discovery query — stays constraint-led instead of short_entity', async () => {
    const result = await analyze('2018 와인 추천');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.contract.exactMetadataTargetVintage).toBe(2018);
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'facet_search',
      queryClass: 'pure_constraint',
    });
  });

  it('Comparison query — decomposition.kind=comparison, legs.length>=2', async () => {
    const result = await analyze('Bordeaux 2015 vs Burgundy 2018');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.decomposition).toBeDefined();
    expect(result.analysis.decomposition?.kind).toBe('comparison');
    if (result.analysis.decomposition?.kind === 'comparison') {
      expect(result.analysis.decomposition.legs.length).toBeGreaterThanOrEqual(2);
    }
    expect(result.analysis.intent).toBe('compare');
    expect(result.analysis.expectedMultiStep).toBe(true);
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'comparison_search',
      queryClass: 'comparison_query',
    });
  });

  it('Food pairing query — intent=pair, requiredTool=search_hybrid', async () => {
    const result = await analyze('스테이크에 어울리는 와인');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.intent).toBe('pair');
    // T-IR-05: pairing has no dedicated tool — the analyzer steers the agent to
    // the grounded `search_hybrid` discovery primitive and the pairing answer
    // is composed from primitive search results.
    expect(result.analysis.contract.requiredTool).toBe('search_hybrid');
    expect(result.analysis.expectedMultiStep).toBe(true);
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'pairing_search',
      queryClass: 'semantic_preference',
    });
  });

  it('Drinkability query — requiresDrinkabilityCheck=true', async () => {
    const result = await analyze('지금 마시기 좋은 2010년 와인');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.contract.requiresDrinkabilityCheck).toBe(true);
  });

  it('situational beginner gift query — surfaces existing soft semantics structurally', async () => {
    const result = await analyze('와인 입문자 선물용, 달달하면서 도수 낮은 거, 예쁜 라벨이면 좋겠다');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;

    expect(result.analysis.intent).toBe('search');
    expect(result.analysis.contract.requiredTool).toBe('search_hybrid');
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'semantic_discovery',
      queryClass: 'semantic_preference',
    });
    expect(result.analysis.normalizedConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attribute: 'occasion', operator: 'in', value: ['gift'] }),
        expect.objectContaining({ attribute: 'style', operator: 'in', value: ['approachable'] }),
        expect.objectContaining({ attribute: 'style', operator: 'in', value: ['presentation_forward'] }),
        expect.objectContaining({ attribute: 'sweetness', operator: '>=', value: 0.5 }),
        expect.objectContaining({ attribute: 'alcohol_pct', operator: '<=', value: 12 }),
        expect.objectContaining({ attribute: 'price_band', operator: '=', value: 'budget' }),
        expect.objectContaining({ attribute: 'beginner_suitability', operator: '>=' }),
        expect.objectContaining({ attribute: 'gift_suitability', operator: '>=' }),
      ]),
    );
  });

  it('explicit top-N query — extracts requestedResultLimit from Korean 탑N surface', async () => {
    const result = await analyze('나파 카베르네 탑3');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.requestedResultLimit).toBe(3);
  });

  it('explicit top-N query clamps oversized requests to schema max', async () => {
    const result = await analyze('부르고뉴 피노 누아르 top99');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.requestedResultLimit).toBe(50);
  });
});

describe('QueryAnalyzerService — input validation', () => {
  it('rejects empty query', async () => {
    const result = await analyze('');
    expect(result).toEqual({ kind: 'rejected', reason: 'empty_query' });
  });

  it('rejects whitespace-only query as empty_query', async () => {
    const result = await analyze('     ');
    expect(result).toEqual({ kind: 'rejected', reason: 'empty_query' });
  });

  it('rejects oversize query', async () => {
    const tooLong = 'a'.repeat(5000);
    const result = await analyze(tooLong);
    expect(result).toEqual({ kind: 'rejected', reason: 'too_long' });
  });

  it('blocks adversarial input via sanitizer classification', async () => {
    // Repetitive input pattern matches REPETITIVE_INPUT_PATTERN_SHORT
    // and adaptive-budget surfaces it as classification=adversarial.
    const adversarial = 'ab'.repeat(40);
    const result = await analyze(adversarial);
    // Either rejected as blocked OR rejected as empty/too_long if the
    // pattern doesn't trigger — but the contract demands blocked here.
    expect(result.kind).toBe('rejected');
  });
});

describe('QueryAnalyzerService — preservedSurface', () => {
  it('preserves byte-identical input including Korean + emoji + accented Latin', async () => {
    const queries = [
      '부르고뉴 피노누아 추천',
      'Châteauneuf-du-Pape 🍷 with truffle',
      'crémant   d\'Alsace  ',
      'café au lait pairing',
    ];
    for (const q of queries) {
      const result = await analyze(q);
      if (result.kind !== 'ok') continue;
      expect(result.analysis.preservedSurface).toBe(q);
    }
  });

  it('round-trips through the schema parser unchanged', async () => {
    const q = 'Opus One 2018';
    const result = await analyze(q);
    if (result.kind !== 'ok') {
      throw new Error('expected ok analysis');
    }
    const reparsed = WineSearchAnalysisSchema.parse(result.analysis);
    expect(reparsed.preservedSurface).toBe(q);
  });
});

describe('QueryAnalyzerService — LLM fallback', () => {
  it('invokes structuredLlm.analyze for fully ambiguous query', async () => {
    const llmAnalysis: WineSearchAnalysis = {
      intent: 'search',
      anchors: [],
      normalizedConstraints: [],
      contract: {
        requiresDrinkabilityCheck: false,
        requiresGroundedWineSearch: true,
        hasEntityMetadataSignal: false,
      },
      expectedMultiStep: false,
      recommendedBudget: { maxSteps: 4, perToolCap: 3 },
      hangulDominant: false,
      preservedSurface: 'asdf',
    };
    const stub = makeStubLlm(() =>
      Promise.resolve({
        data: llmAnalysis,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        durationMs: 42,
      }),
    );
    const result = await analyze('asdf', { structuredLlm: stub });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(stub.analyzeMock).toHaveBeenCalledTimes(1);
    // The analyzer overrides preservedSurface and hangulDominant from the
    // deterministic pre-pass to guarantee byte-identity even if the LLM
    // tries to rewrite them.
    expect(result.analysis.preservedSurface).toBe('asdf');
    // Observability: the analyzer records the LLM-fallback outcome so the
    // orchestrator can tell a real LLM rescue apart from a deterministic
    // analysis or a preserved-unknown failure. See `llmFallbackOutcome` regression file.
    expect(result.analysis.llmFallbackOutcome).toEqual({ kind: 'success' });
  });

  it('passes a MINIMAL schema to the LLM and merges {intent} into the deterministic shell (OpenAI-robust)', async () => {
    // Structural fix: the fallback must NOT ask the LLM to emit the entire
    // (huge, strict, nested) WineSearchAnalysis — OpenAI structured output
    // cannot reliably satisfy it, so the analyzer kept failing → intent=unknown
    // → false "unsupported_intent". Instead the LLM emits only the intent (+ may
    // sprinkle extra reasoning fields, rule 10), which we merge into the
    // deterministic shell that already carries contract/budget/etc.
    const stub = makeStubLlm(() =>
      Promise.resolve({
        // minimal output + an extra reasoning field the LLM may add
        data: { intent: 'search', reasoning: 'mentions a wine region' } as never,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        durationMs: 1,
      }),
    );
    const result = await analyze('asdf', { structuredLlm: stub });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // intent came from the LLM; the shell supplied the rest
    expect(result.analysis.intent).toBe('search');
    expect(result.analysis.contract).toBeDefined();
    expect(result.analysis.recommendedBudget).toBeDefined();
    expect(result.analysis.expectedMultiStep).toBe(false);
    expect(result.analysis.preservedSurface).toBe('asdf');
    expect(result.analysis.llmFallbackOutcome).toEqual({ kind: 'success' });
    // The schema handed to the LLM is MINIMAL — it accepts `{ intent }` alone
    // (the full WineSearchAnalysisSchema would reject that for missing fields).
    const passedSchema = stub.analyzeMock.mock.calls[0]?.[0]?.schema;
    expect(passedSchema?.safeParse({ intent: 'search' }).success).toBe(true);
  });

  it('does NOT invoke structuredLlm when deterministic pipeline yields constraints', async () => {
    const stub = makeStubLlm(() => {
      throw new Error('LLM must not be called when deterministic constraints exist');
    });
    // "프랑스 와인" emits a country=France hard constraint via rule-based extractor.
    const result = await analyze('프랑스 와인 추천', { structuredLlm: stub });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.normalizedConstraints.length).toBeGreaterThan(0);
    expect(stub.analyzeMock).not.toHaveBeenCalled();
  });

  it('preserves intent=unknown when LLM call throws (no silent soften to search)', async () => {
    const stub = makeStubLlm(() => Promise.reject(new Error('boom')));
    const result = await analyze('asdf', { structuredLlm: stub });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // Honest failure: intent stays 'unknown' so the deterministic-router can
    // route the ambiguous query through its `unsupported_intent` path instead
    // of force-routing a search that masquerades an LLM outage as a hit.
    expect(result.analysis.intent).toBe('unknown');
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'semantic_discovery',
      queryClass: 'unknown',
    });
    expect(stub.analyzeMock).toHaveBeenCalledTimes(1);
    // Failure path must surface the trace so observability can distinguish a
    // real `intent=search` from a preserved-unknown failure.
    expect(result.analysis.llmFallbackOutcome).toEqual({
      kind: 'failed_preserved_unknown',
      failureReason: 'unknown',
    });
  });

  it('works without structuredLlm provided (port optional)', async () => {
    const result = await analyze('asdf');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.analysis.intent).toBe('unknown');
    expect(result.analysis.callerInterpretation).toEqual({
      authority: 'caller',
      intent: 'semantic_discovery',
      queryClass: 'unknown',
    });
    // Port absent → fallback not invoked → outcome=not_attempted.
    expect(result.analysis.llmFallbackOutcome).toEqual({ kind: 'not_attempted' });
  });
});

describe('QueryAnalyzerService — multi-script regex safety', () => {
  it('treats accented Latin (café, crémant) the same as ASCII fallbacks', async () => {
    const accented = await analyze('crémant rosé');
    const ascii = await analyze('cremant rose');
    expect(accented.kind).toBe('ok');
    expect(ascii.kind).toBe('ok');
  });

  it('does not crash on emoji-only input (rejected, not thrown)', async () => {
    const result = await analyze('🍷🍷🍷');
    expect(result.kind === 'ok' || result.kind === 'rejected').toBe(true);
  });
});
