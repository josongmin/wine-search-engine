/**
 * WineAgentLoopRunner — integration tests.
 *
 * Covers:
 *  - Happy path (single search → answer).
 *  - Drinkability follow-up directive.
 *  - Relax-constraints retry.
 *  - Required-tool directive injection.
 *  - Grounded-search-required directive.
 *  - Loop detection (1st rejection retries, 2nd terminates).
 *  - Max steps exhaustion.
 *  - Token budget exhaustion.
 *  - Per-step timeout.
 *  - Caller abort.
 *  - Zombie-loop fix verification (model keeps emitting answers despite
 *    directives — runner terminates at max_steps gracefully).
 *  - Korean directive copy when hangulDominant.
 *  - TokenUsage accumulation across multi-step.
 */

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
  ToolDefinition,
  ToolUseCall,
} from '@domain/ai/port/structured-llm.port.js';
import { StructuredLlmTimeoutError } from '@domain/ai/port/structured-llm.port.js';
import type { SearchResponseV1 } from '@domain/response/model/search-response.js';
import {
  computeNextDirective,
  WineAgentLoopRunner,
} from '../wine-agent-loop.js';
import {
  WINE_AGENT_LOOP_DEFAULT_AGENT_TIMEOUT_MS,
  WINE_AGENT_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
  WINE_AGENT_LOOP_DEFAULT_MAX_STEPS,
  WINE_AGENT_LOOP_DEFAULT_MAX_TOTAL_TOKENS,
  WINE_AGENT_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS,
  WINE_AGENT_LOOP_DEFAULT_PER_TOOL_CAP,
  WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH,
  WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN,
  selectDirectiveCopy,
  type WineAgentLoopInput,
  type WineAgentLoopStep,
  type WineAgentLoopToolPorts,
} from '../wine-agent-loop-schemas.js';
import type {
  SearchUseCasePort,
} from '../execution-runner.js';
import type { DecomposedSearchUseCasePort } from '../../search/port/search-route-usecases.port.js';
import type { DrinkingWindowUseCasePort } from '../../drinking-window/port/drinking-window-usecase.port.js';
import type { EntityDocumentLookupPort } from '../../search/port/search-pipeline-deps.port.js';
import type { WineSearchAnalysis } from '../wine-search-schemas.js';
import type { ComparisonSearchResponse } from '../../../domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '../../../domain/response/model/result-item.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-wine-agent-loop-0001';

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

function makeAnalysis(opts?: {
  hangulDominant?: boolean;
  requiresGroundedWineSearch?: boolean;
  requiredTool?: WineSearchAnalysis['contract']['requiredTool'];
  constraints?: WineSearchAnalysis['normalizedConstraints'];
}): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    normalizedConstraints: opts?.constraints ?? [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: opts?.requiresGroundedWineSearch ?? false,
      hasEntityMetadataSignal: false,
      ...(opts?.requiredTool !== undefined ? { requiredTool: opts.requiredTool } : {}),
    },
    expectedMultiStep: true,
    recommendedBudget: { maxSteps: WINE_AGENT_LOOP_DEFAULT_MAX_STEPS, perToolCap: WINE_AGENT_LOOP_DEFAULT_PER_TOOL_CAP },
    hangulDominant: opts?.hangulDominant ?? false,
    preservedSurface: 'fixture-query',
  };
}

function makeSearchResponse(entityIds: readonly string[]): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results: entityIds.map((id) => ({
      entity: { entityId: id, canonicalLabel: `Wine ${id}` },
    })) as unknown as SearchResponseV1['results'],
    meta: { generatedAt: new Date().toISOString() } as unknown as SearchResponseV1['meta'],
  };
}

function makeSearchPort(
  impl?: (input: unknown, reqId: string) => Promise<SearchResponseV1>,
): SearchUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(impl ?? (() => Promise.resolve(makeSearchResponse(['wine-1', 'wine-2']))));
  return {
    executeMock,
    execute: (input, reqId, _opts) => executeMock(input, reqId),
  };
}

function makeComparisonResponse(): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    originalQuery: 'Wine A vs Wine B',
    comparisonIntent: 'compare',
    entities: [
      {
        subQuery: 'Wine A',
        topResult: null,
        resultCount: 1,
        resolutionStatus: 'resolved',
        allResults: [],
      },
      {
        subQuery: 'Wine B',
        topResult: null,
        resultCount: 1,
        resolutionStatus: 'resolved',
        allResults: [],
      },
    ],
    overallStatus: 'resolved',
    requestId: REQUEST_ID,
    executionTimeMs: 10,
  };
}

function makeDecomposedSearchPort(
  impl?: (...args: unknown[]) => Promise<ComparisonSearchResponse>,
): DecomposedSearchUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(impl ?? (() => Promise.resolve(makeComparisonResponse())));
  return {
    executeMock,
    execute: (...args) => executeMock(...args),
  } as unknown as DecomposedSearchUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> };
}

function makeDrinkingWindowBlock(): DrinkingWindowBlock {
  return {
    targetYear: 2026,
    status: 'optimal',
    message: 'Ready to drink',
    confidence: 'high',
    confidenceScore: 0.9,
    prediction: {
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2028,
      peakYear: 2026,
      confidence: 'high',
      confidenceScore: 0.9,
      modelVersion: 'test',
    },
  } as unknown as DrinkingWindowBlock;
}

function makeDrinkingWindowPort(
  impl?: (request: unknown) => Promise<DrinkingWindowBlock>,
): DrinkingWindowUseCasePort & { readonly checkMock: ReturnType<typeof vi.fn> } {
  const checkMock = vi.fn(impl ?? (() => Promise.resolve(makeDrinkingWindowBlock())));
  return {
    checkMock,
    check: (request) => checkMock(request),
  } as unknown as DrinkingWindowUseCasePort & { readonly checkMock: ReturnType<typeof vi.fn> };
}

function makeEntityLookupPort(): EntityDocumentLookupPort & {
  readonly getDrinkingWindowDocumentsMock: ReturnType<typeof vi.fn>;
} {
  const entityId = createCanonicalEntityId('wine-1');
  const getDrinkingWindowDocumentsMock = vi.fn(async () =>
    new Map([
      [entityId, {
        vintageYear: 2018,
        grapePrimaryEnc: 11,
        regionEnc: 22,
        countryEnc: 33,
        tannin: 0.6,
        acidity: 0.5,
        body: 0.7,
      }],
    ]),
  );
  return {
    getDocuments: async () => new Map(),
    getDrinkingWindowDocuments: (entityIds) => getDrinkingWindowDocumentsMock(entityIds),
    getDrinkingWindowDocumentsMock,
  };
}

function makeToolPorts(overrides?: Partial<WineAgentLoopToolPorts>): WineAgentLoopToolPorts {
  return {
    searchUseCase: overrides?.searchUseCase ?? makeSearchPort(),
    ...(overrides?.decomposedSearchUseCase !== undefined
      ? { decomposedSearchUseCase: overrides.decomposedSearchUseCase }
      : {}),
    ...(overrides?.drinkingWindowUseCase !== undefined
      ? { drinkingWindowUseCase: overrides.drinkingWindowUseCase }
      : {}),
    ...(overrides?.entityLookup !== undefined ? { entityLookup: overrides.entityLookup } : {}),
  };
}

interface StubLlm extends StructuredLlmPort {
  readonly executeMock: ReturnType<typeof vi.fn>;
}

function makeStubLlm(
  responses: ReadonlyArray<(req: ExecuteRequest) => Promise<ExecuteResult>>,
): StubLlm {
  let call = 0;
  const executeMock = vi.fn(async (req: ExecuteRequest) => {
    const handler = responses[call] ?? responses[responses.length - 1];
    call += 1;
    if (handler === undefined) throw new Error('no handler');
    return handler(req);
  });
  return {
    executeMock,
    analyze: <TSchema extends z.ZodTypeAny>(
      _req: AnalyzeRequest<TSchema>,
    ): Promise<AnalyzeResult<z.infer<TSchema>>> => {
      throw new Error('analyze should not be called by WineAgentLoopRunner');
    },
    execute: (req: ExecuteRequest) => executeMock(req),
    synthesize: <TSchema extends z.ZodTypeAny>(
      _req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<z.infer<TSchema>>> => {
      throw new Error('synthesize should not be called by WineAgentLoopRunner');
    },
  };
}

function toolUse(name: string, input: Record<string, unknown>, id = 'tu-1'): ToolUseCall {
  return { id, name, input };
}

function asToolUseResult(
  calls: readonly ToolUseCall[],
  usage = makeTokenUsage(120, 60),
): ExecuteResult {
  return {
    kind: 'tool_use',
    calls,
    usage,
    durationMs: 5,
    stopReason: 'tool_use',
  };
}

function asTextResult(text: string, usage = makeTokenUsage(100, 50)): ExecuteResult {
  return {
    kind: 'text',
    text,
    usage,
    durationMs: 5,
    stopReason: 'end_turn',
  };
}

// Minimal tool definition list — the runner only forwards these to the LLM.
// T-IR-05: the active taxonomy is exactly the four retrieval primitives
// (search_hybrid / search_semantic / search_lexical / lookup_wine). The
// removed convenience tools (search_wines / get_food_pairings /
// check_drinking_window / compare_wines) are no longer forwarded.
function makeToolDefs(): readonly ToolDefinition[] {
  const passthrough: ToolDefinition['inputSchema'] = {
    parse: (x: unknown) => x,
    safeParse: (x: unknown) => ({ success: true as const, data: x }),
  } as unknown as ToolDefinition['inputSchema'];
  return [
    { name: 'search_hybrid', description: 'hybrid search', inputSchema: passthrough },
    { name: 'search_semantic', description: 'semantic search', inputSchema: passthrough },
    { name: 'search_lexical', description: 'lexical search', inputSchema: passthrough },
    { name: 'lookup_wine', description: 'lookup', inputSchema: passthrough },
  ];
}

function makeInput(overrides: Partial<WineAgentLoopInput> & { readonly analysis?: WineSearchAnalysis }): WineAgentLoopInput {
  return {
    query: overrides.query ?? 'recommend a Burgundy Pinot Noir',
    analysis: overrides.analysis ?? makeAnalysis(),
    requestId: overrides.requestId ?? REQUEST_ID,
    tools: overrides.tools ?? makeToolDefs(),
    toolPorts: overrides.toolPorts ?? makeToolPorts(),
    perStepTimeoutMs: overrides.perStepTimeoutMs ?? WINE_AGENT_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS,
    agentTimeoutMs: overrides.agentTimeoutMs ?? WINE_AGENT_LOOP_DEFAULT_AGENT_TIMEOUT_MS,
    maxSteps: overrides.maxSteps ?? WINE_AGENT_LOOP_DEFAULT_MAX_STEPS,
    maxTotalTokens: overrides.maxTotalTokens ?? WINE_AGENT_LOOP_DEFAULT_MAX_TOTAL_TOKENS,
    maxOutputTokens: overrides.maxOutputTokens ?? WINE_AGENT_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
    perToolCap: overrides.perToolCap ?? WINE_AGENT_LOOP_DEFAULT_PER_TOOL_CAP,
    ...(overrides.initialDirective !== undefined ? { initialDirective: overrides.initialDirective } : {}),
    ...(overrides.priorHistory !== undefined ? { priorHistory: overrides.priorHistory } : {}),
    ...(overrides.abortSignal !== undefined ? { abortSignal: overrides.abortSignal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WineAgentLoopRunner — happy path', () => {
  it('single search → answer → terminates with reason=answer in 2 steps', async () => {
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'Burgundy Pinot Noir' })]),
      async () => asTextResult('I recommend Burgundy Pinot Noir based on the results.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({}));

    expect(out.terminationReason).toBe('answer');
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0]?.kind).toBe('tool_use');
    expect(out.steps[1]?.kind).toBe('answer');
    expect(out.answer).toBe('I recommend Burgundy Pinot Noir based on the results.');
    expect(out.toolOutcomes).toHaveLength(1);
    expect(out.toolOutcomes[0]?.tool).toBe('search_hybrid');
    expect(out.toolOutcomes[0]?.kind).toBe('success');
  });
});

describe('WineAgentLoopRunner — relax constraints retry', () => {
  it('empty search → relax directive → second search succeeds → answer', async () => {
    const searchPort = makeSearchPort((_input, _reqId) => {
      const callIdx = searchPort.executeMock.mock.calls.length;
      if (callIdx === 1) return Promise.resolve(makeSearchResponse([]));
      return Promise.resolve(makeSearchResponse(['wine-relaxed']));
    });
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'rare 1947 Mouton under 5만원' })]),
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'rare 1947 Mouton (relaxed)' })]),
      async () => asTextResult('After relaxing price, found wine-relaxed.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({
        constraints: [
          { attribute: 'maxPriceKrw', operator: 'lte', value: 50000, mustHave: false } as unknown as WineSearchAnalysis['normalizedConstraints'][number],
        ],
      }),
      toolPorts: makeToolPorts({ searchUseCase: searchPort }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(searchPort.executeMock).toHaveBeenCalledTimes(2);
    expect(out.answer).toContain('wine-relaxed');
  });
});

describe('WineAgentLoopRunner — required tool directive', () => {
  it('model emits answer first → required_tool directive injected → tool called → answer accepted', async () => {
    const llm = makeStubLlm([
      // Model tries to answer prematurely — must be rejected because
      // requiredTool=search_hybrid hasn't been called.
      async () => asTextResult('Try a Riesling.'),
      // After directive injection, the model calls the required discovery
      // primitive (T-IR-05: pairing capability is composed from search_hybrid).
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'wine pairing for spicy Korean BBQ' })]),
      // Final answer accepted.
      async () => asTextResult('Riesling pairs well with spicy Korean BBQ.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({ requiredTool: 'search_hybrid' }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(out.toolOutcomes.some((o) => o.tool === 'search_hybrid')).toBe(true);
    expect(out.answer).toContain('Riesling pairs well');
  });

  it('dispatches search_hybrid through searchUseCase for a pairing query', async () => {
    const searchPort = makeSearchPort(() => Promise.resolve(makeSearchResponse(['pair-1'])));
    const llm = makeStubLlm([
      async () => asToolUseResult([
        toolUse('search_hybrid', {
          query: 'wine pairing for spicy Korean BBQ',
        }),
      ]),
      async () => asTextResult('Riesling works here.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({ requiredTool: 'search_hybrid' }),
      toolPorts: makeToolPorts({ searchUseCase: searchPort }),
      maxSteps: 4,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(searchPort.executeMock).toHaveBeenCalledTimes(1);
    expect(searchPort.executeMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      query: expect.stringContaining('wine pairing for spicy Korean BBQ'),
      retrievalLane: 'hybrid',
    }));
    expect(searchPort.executeMock.mock.calls[0]?.[0]).not.toHaveProperty('mode');
  });
});

describe('WineAgentLoopRunner — removed convenience tools are unsupported (T-IR-05 guard)', () => {
  // T-IR-05 removed compare_wines / check_drinking_window / get_food_pairings
  // from the active loop. These tests are repurposed (NOT deleted — regression
  // tests are append-only) into guards that the dispatcher hits its default
  // branch for a removed tool name: it returns the "not supported" observation
  // and never invokes the corresponding use-case spy.
  const UNSUPPORTED_PREFIX = (name: string) =>
    `Tool "${name}" is not supported in the wine-agent-loop. Use one of:`;

  it('compare_wines hits the unsupported default branch and never calls decomposedSearchUseCase', async () => {
    const comparisonPort = makeDecomposedSearchPort();
    const llm = makeStubLlm([
      async () => asToolUseResult([
        toolUse('compare_wines', { query_a: 'Opus One 2018', query_b: 'Almaviva 2019' }),
      ]),
      async () => asTextResult('Both are strong candidates.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      toolPorts: makeToolPorts({ decomposedSearchUseCase: comparisonPort }),
      maxSteps: 4,
    }));

    expect(out.terminationReason).toBe('answer');
    // Removed tool: the convenience use case MUST NOT be dispatched.
    expect(comparisonPort.executeMock).not.toHaveBeenCalled();
    const compareStep = out.steps.find((s) =>
      s.toolCalls.some((c) => c.tool === 'compare_wines'),
    );
    expect(compareStep?.observations[0]).toMatch(
      new RegExp(`^${UNSUPPORTED_PREFIX('compare_wines').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`),
    );
  });

  it('check_drinking_window hits the unsupported default branch and never calls the drinking-window use case', async () => {
    const drinkingWindowPort = makeDrinkingWindowPort();
    const entityLookup = makeEntityLookupPort();
    const llm = makeStubLlm([
      async () => asToolUseResult([
        toolUse('check_drinking_window', { entity_id: 'wine-1', target_year: 2026 }),
      ]),
      async () => asTextResult('2026 is a good window.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      toolPorts: makeToolPorts({
        drinkingWindowUseCase: drinkingWindowPort,
        entityLookup,
      }),
      maxSteps: 4,
    }));

    expect(out.terminationReason).toBe('answer');
    // Removed tool: neither hydration nor the drinking-window use case fire.
    expect(entityLookup.getDrinkingWindowDocumentsMock).not.toHaveBeenCalled();
    expect(drinkingWindowPort.checkMock).not.toHaveBeenCalled();
    const dwStep = out.steps.find((s) =>
      s.toolCalls.some((c) => c.tool === 'check_drinking_window'),
    );
    expect(dwStep?.observations[0]).toMatch(
      new RegExp(`^${UNSUPPORTED_PREFIX('check_drinking_window').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`),
    );
  });

  it('get_food_pairings hits the unsupported default branch and never calls the search use case', async () => {
    const searchPort = makeSearchPort(() => Promise.resolve(makeSearchResponse(['pair-1'])));
    const llm = makeStubLlm([
      async () => asToolUseResult([
        toolUse('get_food_pairings', { food: 'spicy Korean BBQ', color: 'white' }),
      ]),
      async () => asTextResult('Riesling works here.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      toolPorts: makeToolPorts({ searchUseCase: searchPort }),
      maxSteps: 4,
    }));

    expect(out.terminationReason).toBe('answer');
    // Removed tool: the search use case MUST NOT be dispatched by the default branch.
    expect(searchPort.executeMock).not.toHaveBeenCalled();
    const pairStep = out.steps.find((s) =>
      s.toolCalls.some((c) => c.tool === 'get_food_pairings'),
    );
    expect(pairStep?.observations[0]).toMatch(
      new RegExp(`^${UNSUPPORTED_PREFIX('get_food_pairings').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`),
    );
  });
});

describe('WineAgentLoopRunner — grounded search required', () => {
  it('model emits answer first → grounded_search_required → search → answer', async () => {
    const llm = makeStubLlm([
      async () => asTextResult('Try a Bordeaux.'),
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'Bordeaux' })]),
      async () => asTextResult('Recommend Wine wine-1 from Bordeaux.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({ requiresGroundedWineSearch: true }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(out.toolOutcomes.some((o) => o.tool === 'search_hybrid')).toBe(true);
  });
});

describe('WineAgentLoopRunner — loop detection', () => {
  it('two identical tool calls → loop_detected counter → terminate with loop_detected', async () => {
    // Same input each time — StepBudget will reject as exact-key loop on
    // the 2nd call. The runner gets one retry budget; we exhaust it by
    // having the model keep emitting the same call.
    const sameCall = toolUse('search_hybrid', { query: 'identical' });
    const llm = makeStubLlm([
      async () => asToolUseResult([sameCall]),
      async () => asToolUseResult([sameCall]),
      async () => asToolUseResult([sameCall]),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ maxSteps: 5 }));

    expect(out.terminationReason).toBe('loop_detected');
  });
});

describe('WineAgentLoopRunner — max steps', () => {
  it('model keeps calling tools → step budget exhausts → max_steps termination', async () => {
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'q1' }, 'tu-1')]),
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'q2 distinct' }, 'tu-2')]),
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'q3 also distinct' }, 'tu-3')]),
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'q4' }, 'tu-4')]),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ maxSteps: 2 }));

    // After exhausting maxSteps, the loop terminates without an answer.
    expect(['max_steps', 'loop_detected']).toContain(out.terminationReason);
  });
});

describe('WineAgentLoopRunner — token budget', () => {
  it('large LLM responses accumulate to maxTotalTokens → terminate with budget', async () => {
    const heavyUsage = makeTokenUsage(20_000, 5_000);
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'big' })], heavyUsage),
      // Should not reach here because token budget terminates first.
      async () => asTextResult('answer', heavyUsage),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ maxTotalTokens: 10_000, maxSteps: 5 }));

    expect(out.terminationReason).toBe('budget');
  });
});

describe('WineAgentLoopRunner — per-step timeout', () => {
  it('LLM call exceeds perStepTimeoutMs → terminate with timeout', async () => {
    const llm = makeStubLlm([
      // Throw a synthetic timeout-like error matching withTimeout's shape.
      async () => {
        throw new StructuredLlmTimeoutError('synthetic step timeout');
      },
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ perStepTimeoutMs: 10 }));

    expect(out.terminationReason).toBe('timeout');
    expect(out.steps[0]?.kind).toBe('error');
  });
});

describe('WineAgentLoopRunner — abort', () => {
  it('caller aborts before first step → terminate with aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'x' })]),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ abortSignal: controller.signal }));

    expect(out.terminationReason).toBe('aborted');
    expect(llm.executeMock).not.toHaveBeenCalled();
  });
});

describe('WineAgentLoopRunner — zombie loop fix', () => {
  it('model keeps emitting answers despite directives → loop terminates gracefully', async () => {
    // Contract requires search_hybrid, but the model just keeps
    // answering. Without functional directive recomputation this would
    // loop forever; with it, the budget burns down and we terminate.
    const llm = makeStubLlm([
      async () => asTextResult('answer 1'),
      async () => asTextResult('answer 2'),
      async () => asTextResult('answer 3'),
      async () => asTextResult('answer 4'),
      async () => asTextResult('answer 5'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({ requiredTool: 'search_hybrid' }),
      maxSteps: WINE_AGENT_LOOP_DEFAULT_MAX_STEPS,
    }));

    // Loop must terminate (no infinite recursion). With the directive
    // ignored kill switch, two consecutive premature answers terminate at
    // max_steps; budget would only fire if termination is delayed.
    expect(['max_steps', 'error', 'budget']).toContain(out.terminationReason);
    expect(out.steps.length).toBeLessThanOrEqual(WINE_AGENT_LOOP_DEFAULT_MAX_STEPS + 1);
  });
});

describe('WineAgentLoopRunner — Korean directive copy', () => {
  it('hangulDominant=true → Korean directive surfaced to model', async () => {
    let observedDirectiveMessage = '';
    const llm = makeStubLlm([
      async () => asTextResult('성급한 답변입니다.'),
      async (req) => {
        // Capture the most recent injected directive (last user message).
        for (let i = req.messages.length - 1; i >= 0; i--) {
          const m = req.messages[i];
          if (m?.role === 'user' && m.content.startsWith('[directive]')) {
            observedDirectiveMessage = m.content;
            break;
          }
        }
        return asToolUseResult([toolUse('search_hybrid', { query: '와인' })]);
      },
      async () => asTextResult('wine-1 추천합니다.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      query: '와인 추천해주세요',
      analysis: makeAnalysis({ hangulDominant: true, requiresGroundedWineSearch: true }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(observedDirectiveMessage).toContain('search_hybrid');
    expect(observedDirectiveMessage).toMatch(/[가-힣]/u);  // contains Hangul
    expect(observedDirectiveMessage).toBe(`[directive] ${WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN.groundedSearch}`);
  });

  it('hangulDominant=false → English directive surfaced to model', async () => {
    let observedDirectiveMessage = '';
    const llm = makeStubLlm([
      async () => asTextResult('premature answer'),
      async (req) => {
        for (let i = req.messages.length - 1; i >= 0; i--) {
          const m = req.messages[i];
          if (m?.role === 'user' && m.content.startsWith('[directive]')) {
            observedDirectiveMessage = m.content;
            break;
          }
        }
        return asToolUseResult([toolUse('search_hybrid', { query: 'wine' })]);
      },
      async () => asTextResult('Recommend wine-1.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      query: 'recommend a wine',
      analysis: makeAnalysis({ hangulDominant: false, requiresGroundedWineSearch: true }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(observedDirectiveMessage).toBe(`[directive] ${WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH.groundedSearch}`);
  });
});

describe('WineAgentLoopRunner — token accumulation', () => {
  it('aggregates inputTokens / outputTokens / cacheRead / cacheCreation across steps', async () => {
    const usage1: TokenUsage = {
      inputTokens: 100, outputTokens: 50,
      cacheReadTokens: 200, cacheCreationTokens: 30,
    };
    const usage2: TokenUsage = {
      inputTokens: 150, outputTokens: 70,
      cacheReadTokens: 250, cacheCreationTokens: 0,
    };
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'q' })], usage1),
      async () => asTextResult('answer', usage2),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({}));

    expect(out.terminationReason).toBe('answer');
    expect(out.tokenUsage.inputTokens).toBe(250);
    expect(out.tokenUsage.outputTokens).toBe(120);
    expect(out.tokenUsage.cacheReadTokens).toBe(450);
    expect(out.tokenUsage.cacheCreationTokens).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Pure-function tests on `computeNextDirective` — ensure the central
// observation-driven recomputation behaves correctly for ASCII, Korean,
// and accented-Latin inputs.
// ---------------------------------------------------------------------------

describe('computeNextDirective (pure function)', () => {
  function makeStateView(toolOutcomes: readonly { tool: string; kind: string; result?: unknown }[]) {
    return {
      toolOutcomes: toolOutcomes.map((o, i) => ({
        stepId: `s-${i}`,
        tool: o.tool,
        kind: o.kind as 'success' | 'empty_result' | 'partial_result' | 'tool_error' | 'timeout' | 'policy_violation',
        durationMs: 1,
        result: o.result,
      })),
      steps: [] as WineAgentLoopStep[],
    };
  }

  it('returns grounded_search_required when contract requires it and no search yet (English)', () => {
    const input = makeInput({
      analysis: makeAnalysis({ requiresGroundedWineSearch: true, hangulDominant: false }),
    });
    const out = computeNextDirective(input, makeStateView([]), selectDirectiveCopy(false));
    expect(out?.kind).toBe('grounded_search_required');
    if (out?.kind === 'grounded_search_required') {
      expect(out.instruction).toBe(WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH.groundedSearch);
    }
  });

  it('returns required_tool when contract requires search_hybrid (Korean copy)', () => {
    const input = makeInput({
      analysis: makeAnalysis({ requiredTool: 'search_hybrid', hangulDominant: true }),
    });
    const out = computeNextDirective(input, makeStateView([]), selectDirectiveCopy(true));
    expect(out?.kind).toBe('required_tool');
    if (out?.kind === 'required_tool') {
      expect(out.tool).toBe('search_hybrid');
      expect(out.instruction).toMatch(/[가-힣]/u);
    }
  });

  it('returns undefined when contract is satisfied (Côte-Rôtie / accented Latin path)', () => {
    const input = makeInput({
      query: 'Suggest a Côte-Rôtie',
      analysis: makeAnalysis({ requiresGroundedWineSearch: true, hangulDominant: false }),
    });
    const out = computeNextDirective(
      input,
      makeStateView([
        { tool: 'search_hybrid', kind: 'success', result: makeSearchResponse(['wine-1']) },
      ]),
      selectDirectiveCopy(false),
    );
    expect(out).toBeUndefined();
  });

  it('returns relax_constraints_retry only when not yet retried', () => {
    const input = makeInput({
      analysis: makeAnalysis({
        constraints: [
          { attribute: 'maxPriceKrw', operator: 'lte', value: 10000, mustHave: false } as unknown as WineSearchAnalysis['normalizedConstraints'][number],
        ],
      }),
    });

    // First empty search → relax directive surfaces.
    const first = computeNextDirective(
      input,
      makeStateView([{ tool: 'search_hybrid', kind: 'empty_result' }]),
      selectDirectiveCopy(false),
    );
    expect(first?.kind).toBe('relax_constraints_retry');

    // After a 2nd search call (even if empty), no further relax retries.
    const second = computeNextDirective(
      input,
      makeStateView([
        { tool: 'search_hybrid', kind: 'empty_result' },
        { tool: 'search_hybrid', kind: 'empty_result' },
      ]),
      selectDirectiveCopy(false),
    );
    expect(second).toBeUndefined();
  });

  it('does not return relax when all constraints are must-have', () => {
    const input = makeInput({
      analysis: makeAnalysis({
        constraints: [
          { attribute: 'wineType', operator: 'eq', value: 'red', mustHave: true } as unknown as WineSearchAnalysis['normalizedConstraints'][number],
        ],
      }),
    });
    const out = computeNextDirective(
      input,
      makeStateView([{ tool: 'search_hybrid', kind: 'empty_result' }]),
      selectDirectiveCopy(false),
    );
    expect(out).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T-MTA-01 — prior conversation history is seeded into the planner
// ---------------------------------------------------------------------------

describe('WineAgentLoopRunner — multi-turn priorHistory (T-MTA-01)', () => {
  it('seeds priorHistory BEFORE the anchor query in the first LLM call', async () => {
    const llm = makeStubLlm([
      async () => asTextResult('Grounded answer from full context.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    await runner.run(
      makeInput({
        query: 'Something under $50 instead',
        priorHistory: [
          { role: 'user', content: 'Recommend a Burgundy Pinot Noir' },
          { role: 'assistant', content: 'How about a Gevrey-Chambertin?' },
        ],
      }),
    );

    const firstCall = llm.executeMock.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] };
    // The planner sees the real conversation: prior turns first, then anchor.
    expect(firstCall.messages.map((m) => m.content)).toEqual([
      'Recommend a Burgundy Pinot Noir',
      'How about a Gevrey-Chambertin?',
      'Something under $50 instead',
    ]);
    expect(firstCall.messages[firstCall.messages.length - 1]).toEqual({
      role: 'user',
      content: 'Something under $50 instead',
    });
  });

  it('a fresh single-turn run (no priorHistory) seeds only the anchor', async () => {
    const llm = makeStubLlm([async () => asTextResult('Answer.')]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    await runner.run(makeInput({ query: 'recommend a Napa Cabernet' }));
    const firstCall = llm.executeMock.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] };
    expect(firstCall.messages).toEqual([{ role: 'user', content: 'recommend a Napa Cabernet' }]);
  });
});

// ---------------------------------------------------------------------------
// T-MTA-07 fix — history trim must never evict the anchor (current query)
// ---------------------------------------------------------------------------

describe('WineAgentLoopRunner — trim preserves the anchor under overflow (T-MTA-07)', () => {
  it('keeps the anchor user query in the LLM history even when a huge prior message pins the head', async () => {
    // priorHistory[0] is huge (> WINE_AGENT_LOOP_MAX_HISTORY_CHARS) and is the
    // pinned head; a naive "drop from index 1 to end" trim would walk past the
    // anchor and evict it. The fix retains the anchor explicitly.
    const huge = 'X'.repeat(13_000);
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_hybrid', { query: 'q' })]),
      async () => asTextResult('final answer based on the anchor.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    await runner.run(
      makeInput({
        query: 'ANCHOR-QUERY-UNIQUE',
        priorHistory: [
          { role: 'user', content: huge },
          { role: 'assistant', content: 'older context' },
        ],
      }),
    );

    // The SECOND LLM call happens AFTER trimHistoryInPlace ran (post step 0).
    const secondCall = llm.executeMock.mock.calls[1]?.[0] as { messages: { content: string }[] };
    const contents = secondCall.messages.map((m) => m.content);
    expect(contents).toContain('ANCHOR-QUERY-UNIQUE');
  });
});
