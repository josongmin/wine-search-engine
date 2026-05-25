/**
 * MiniLoopRunner — integration tests.
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
import type { ComparisonSearchResponse } from '@domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '@domain/response/model/result-item.js';
import type { SearchResponseV1 } from '@domain/response/model/search-response.js';
import {
  computeNextDirective,
  MiniLoopRunner,
} from '../mini-loop.js';
import {
  MINI_LOOP_DEFAULT_AGENT_TIMEOUT_MS,
  MINI_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
  MINI_LOOP_DEFAULT_MAX_STEPS,
  MINI_LOOP_DEFAULT_MAX_TOTAL_TOKENS,
  MINI_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS,
  MINI_LOOP_DEFAULT_PER_TOOL_CAP,
  MINI_LOOP_DIRECTIVE_COPY_ENGLISH,
  MINI_LOOP_DIRECTIVE_COPY_KOREAN,
  selectDirectiveCopy,
  type MiniLoopInput,
  type MiniLoopStep,
  type MiniLoopToolPorts,
} from '../mini-loop-schemas.js';
import type {
  ComparisonUseCasePort,
  DrinkabilityProbe,
  DrinkabilityUseCasePort,
  SearchUseCasePort,
} from '../execution-runner.js';
import type { WineSearchAnalysis } from '../wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REQUEST_ID = 'req-mini-loop-0001';

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
  requiresDrinkabilityCheck?: boolean;
  requiresGroundedWineSearch?: boolean;
  requiredTool?: WineSearchAnalysis['contract']['requiredTool'];
  constraints?: WineSearchAnalysis['normalizedConstraints'];
}): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    normalizedConstraints: opts?.constraints ?? [],
    contract: {
      requiresDrinkabilityCheck: opts?.requiresDrinkabilityCheck ?? false,
      requiresGroundedWineSearch: opts?.requiresGroundedWineSearch ?? false,
      hasEntityMetadataSignal: false,
      ...(opts?.requiredTool !== undefined ? { requiredTool: opts.requiredTool } : {}),
    },
    expectedMultiStep: true,
    recommendedBudget: { maxSteps: MINI_LOOP_DEFAULT_MAX_STEPS, perToolCap: MINI_LOOP_DEFAULT_PER_TOOL_CAP },
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

function makeComparisonResponse(): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    meta: { generatedAt: new Date().toISOString() } as unknown as ComparisonSearchResponse['meta'],
  } as unknown as ComparisonSearchResponse;
}

function makeDrinkabilityProbe(entityId: string, year: number): DrinkabilityProbe {
  return {
    entityId,
    targetYear: year,
    window: {
      drinkingWindowStart: year,
      drinkingWindowEnd: year + 10,
      peakYear: year + 3,
      currentlyDrinkable: true,
      confidence: 0.8,
      evidenceLevel: 'predicted',
      blockingEligible: false,
      modelVersion: 'test-v1',
    } as unknown as DrinkingWindowBlock,
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

function makeComparisonPort(
  impl?: (input: unknown, reqId: string) => Promise<ComparisonSearchResponse>,
): ComparisonUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(impl ?? (() => Promise.resolve(makeComparisonResponse())));
  return {
    executeMock,
    execute: (input, reqId, _opts) => executeMock(input, reqId),
  };
}

function makeDrinkabilityPort(
  impl?: (entityId: string, targetYear: number) => Promise<DrinkabilityProbe | undefined>,
): DrinkabilityUseCasePort & { readonly probeMock: ReturnType<typeof vi.fn> } {
  const probeMock = vi.fn(
    impl
    ?? ((entityId: string, targetYear: number) => Promise.resolve(makeDrinkabilityProbe(entityId, targetYear))),
  );
  return {
    probeMock,
    probe: (entityId, targetYear, reqId, _opts) => probeMock(entityId, targetYear, reqId),
  };
}

function makeToolPorts(overrides?: Partial<MiniLoopToolPorts>): MiniLoopToolPorts {
  return {
    searchUseCase: overrides?.searchUseCase ?? makeSearchPort(),
    comparisonUseCase: overrides?.comparisonUseCase ?? makeComparisonPort(),
    drinkabilityUseCase: overrides?.drinkabilityUseCase ?? makeDrinkabilityPort(),
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
      throw new Error('analyze should not be called by MiniLoopRunner');
    },
    execute: (req: ExecuteRequest) => executeMock(req),
    synthesize: <TSchema extends z.ZodTypeAny>(
      _req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<z.infer<TSchema>>> => {
      throw new Error('synthesize should not be called by MiniLoopRunner');
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
function makeToolDefs(): readonly ToolDefinition[] {
  const passthrough: ToolDefinition['inputSchema'] = {
    parse: (x: unknown) => x,
    safeParse: (x: unknown) => ({ success: true as const, data: x }),
  } as unknown as ToolDefinition['inputSchema'];
  return [
    { name: 'search_wines', description: 'search', inputSchema: passthrough },
    { name: 'check_drinking_window', description: 'check drinkability', inputSchema: passthrough },
    { name: 'get_food_pairings', description: 'food pairing', inputSchema: passthrough },
    { name: 'compare_wines', description: 'compare', inputSchema: passthrough },
  ];
}

function makeInput(overrides: Partial<MiniLoopInput> & { readonly analysis?: WineSearchAnalysis }): MiniLoopInput {
  return {
    query: overrides.query ?? 'recommend a Burgundy Pinot Noir',
    analysis: overrides.analysis ?? makeAnalysis(),
    requestId: overrides.requestId ?? REQUEST_ID,
    tools: overrides.tools ?? makeToolDefs(),
    toolPorts: overrides.toolPorts ?? makeToolPorts(),
    perStepTimeoutMs: overrides.perStepTimeoutMs ?? MINI_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS,
    agentTimeoutMs: overrides.agentTimeoutMs ?? MINI_LOOP_DEFAULT_AGENT_TIMEOUT_MS,
    maxSteps: overrides.maxSteps ?? MINI_LOOP_DEFAULT_MAX_STEPS,
    maxTotalTokens: overrides.maxTotalTokens ?? MINI_LOOP_DEFAULT_MAX_TOTAL_TOKENS,
    maxOutputTokens: overrides.maxOutputTokens ?? MINI_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
    perToolCap: overrides.perToolCap ?? MINI_LOOP_DEFAULT_PER_TOOL_CAP,
    ...(overrides.initialDirective !== undefined ? { initialDirective: overrides.initialDirective } : {}),
    ...(overrides.abortSignal !== undefined ? { abortSignal: overrides.abortSignal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MiniLoopRunner — happy path', () => {
  it('single search → answer → terminates with reason=answer in 2 steps', async () => {
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_wines', { query: 'Burgundy Pinot Noir' })]),
      async () => asTextResult('I recommend Burgundy Pinot Noir based on the results.'),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({}));

    expect(out.terminationReason).toBe('answer');
    expect(out.steps).toHaveLength(2);
    expect(out.steps[0]?.kind).toBe('tool_use');
    expect(out.steps[1]?.kind).toBe('answer');
    expect(out.answer).toBe('I recommend Burgundy Pinot Noir based on the results.');
    expect(out.toolOutcomes).toHaveLength(1);
    expect(out.toolOutcomes[0]?.tool).toBe('search_wines');
    expect(out.toolOutcomes[0]?.kind).toBe('success');
  });
});

describe('MiniLoopRunner — pending drinkability directive', () => {
  it('search → drinkability check (driven by contract) → answer', async () => {
    const drinkabilityPort = makeDrinkabilityPort();
    // Single-entity search response so the directive resolves after one
    // drinkability call.
    const searchPort = makeSearchPort(() => Promise.resolve(makeSearchResponse(['wine-1'])));
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_wines', { query: '2015 Bordeaux 지금 마실만한 것' })]),
      async () => asToolUseResult([toolUse('check_drinking_window', { entity_id: 'wine-1', target_year: 2025 })]),
      async () => asTextResult('wine-1 is in its drinking window.'),
    ]);
    const runner = new MiniLoopRunner({
      structuredLlm: llm,
      logger: makeLogger(),
    });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({ requiresDrinkabilityCheck: true }),
      toolPorts: makeToolPorts({
        drinkabilityUseCase: drinkabilityPort,
        searchUseCase: searchPort,
      }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(drinkabilityPort.probeMock).toHaveBeenCalled();
    const drinkabilityOutcomes = out.toolOutcomes.filter((o) => o.tool === 'check_drinking_window');
    expect(drinkabilityOutcomes.length).toBeGreaterThanOrEqual(1);
  });
});

describe('MiniLoopRunner — relax constraints retry', () => {
  it('empty search → relax directive → second search succeeds → answer', async () => {
    const searchPort = makeSearchPort((_input, _reqId) => {
      const callIdx = searchPort.executeMock.mock.calls.length;
      if (callIdx === 1) return Promise.resolve(makeSearchResponse([]));
      return Promise.resolve(makeSearchResponse(['wine-relaxed']));
    });
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_wines', { query: 'rare 1947 Mouton under 5만원' })]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'rare 1947 Mouton (relaxed)' })]),
      async () => asTextResult('After relaxing price, found wine-relaxed.'),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
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

describe('MiniLoopRunner — required tool directive', () => {
  it('model emits answer first → required_tool directive injected → tool called → answer accepted', async () => {
    const llm = makeStubLlm([
      // Model tries to answer prematurely — must be rejected because
      // requiredTool=get_food_pairings hasn't been called.
      async () => asTextResult('Try a Riesling.'),
      // After directive injection, the model calls get_food_pairings.
      async () => asToolUseResult([toolUse('get_food_pairings', { food: 'spicy Korean BBQ' })]),
      // Final answer accepted.
      async () => asTextResult('Riesling pairs well with spicy Korean BBQ.'),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({ requiredTool: 'get_food_pairings' }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(out.toolOutcomes.some((o) => o.tool === 'get_food_pairings')).toBe(true);
    expect(out.answer).toContain('Riesling pairs well');
  });
});

describe('MiniLoopRunner — grounded search required', () => {
  it('model emits answer first → grounded_search_required → search → answer', async () => {
    const llm = makeStubLlm([
      async () => asTextResult('Try a Bordeaux.'),
      async () => asToolUseResult([toolUse('search_wines', { query: 'Bordeaux' })]),
      async () => asTextResult('Recommend Wine wine-1 from Bordeaux.'),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({ requiresGroundedWineSearch: true }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(out.toolOutcomes.some((o) => o.tool === 'search_wines')).toBe(true);
  });
});

describe('MiniLoopRunner — loop detection', () => {
  it('two identical tool calls → loop_detected counter → terminate with loop_detected', async () => {
    // Same input each time — StepBudget will reject as exact-key loop on
    // the 2nd call. The runner gets one retry budget; we exhaust it by
    // having the model keep emitting the same call.
    const sameCall = toolUse('search_wines', { query: 'identical' });
    const llm = makeStubLlm([
      async () => asToolUseResult([sameCall]),
      async () => asToolUseResult([sameCall]),
      async () => asToolUseResult([sameCall]),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ maxSteps: 5 }));

    expect(out.terminationReason).toBe('loop_detected');
  });
});

describe('MiniLoopRunner — max steps', () => {
  it('model keeps calling tools → step budget exhausts → max_steps termination', async () => {
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_wines', { query: 'q1' }, 'tu-1')]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'q2 distinct' }, 'tu-2')]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'q3 also distinct' }, 'tu-3')]),
      async () => asToolUseResult([toolUse('search_wines', { query: 'q4' }, 'tu-4')]),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ maxSteps: 2 }));

    // After exhausting maxSteps, the loop terminates without an answer.
    expect(['max_steps', 'loop_detected']).toContain(out.terminationReason);
  });
});

describe('MiniLoopRunner — token budget', () => {
  it('large LLM responses accumulate to maxTotalTokens → terminate with budget', async () => {
    const heavyUsage = makeTokenUsage(20_000, 5_000);
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_wines', { query: 'big' })], heavyUsage),
      // Should not reach here because token budget terminates first.
      async () => asTextResult('answer', heavyUsage),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ maxTotalTokens: 10_000, maxSteps: 5 }));

    expect(out.terminationReason).toBe('budget');
  });
});

describe('MiniLoopRunner — per-step timeout', () => {
  it('LLM call exceeds perStepTimeoutMs → terminate with timeout', async () => {
    const llm = makeStubLlm([
      // Throw a synthetic timeout-like error matching withTimeout's shape.
      async () => {
        throw new StructuredLlmTimeoutError('synthetic step timeout');
      },
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ perStepTimeoutMs: 10 }));

    expect(out.terminationReason).toBe('timeout');
    expect(out.steps[0]?.kind).toBe('error');
  });
});

describe('MiniLoopRunner — abort', () => {
  it('caller aborts before first step → terminate with aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('search_wines', { query: 'x' })]),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({ abortSignal: controller.signal }));

    expect(out.terminationReason).toBe('aborted');
    expect(llm.executeMock).not.toHaveBeenCalled();
  });
});

describe('MiniLoopRunner — zombie loop fix', () => {
  it('model keeps emitting answers despite directives → loop terminates gracefully', async () => {
    // Contract requires get_food_pairings, but the model just keeps
    // answering. Without functional directive recomputation this would
    // loop forever; with it, the budget burns down and we terminate.
    const llm = makeStubLlm([
      async () => asTextResult('answer 1'),
      async () => asTextResult('answer 2'),
      async () => asTextResult('answer 3'),
      async () => asTextResult('answer 4'),
      async () => asTextResult('answer 5'),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      analysis: makeAnalysis({ requiredTool: 'get_food_pairings' }),
      maxSteps: MINI_LOOP_DEFAULT_MAX_STEPS,
    }));

    // Loop must terminate (no infinite recursion). With the directive
    // ignored kill switch, two consecutive premature answers terminate at
    // max_steps; budget would only fire if termination is delayed.
    expect(['max_steps', 'error', 'budget']).toContain(out.terminationReason);
    expect(out.steps.length).toBeLessThanOrEqual(MINI_LOOP_DEFAULT_MAX_STEPS + 1);
  });
});

describe('MiniLoopRunner — Korean directive copy', () => {
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
        return asToolUseResult([toolUse('search_wines', { query: '와인' })]);
      },
      async () => asTextResult('wine-1 추천합니다.'),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      query: '와인 추천해주세요',
      analysis: makeAnalysis({ hangulDominant: true, requiresGroundedWineSearch: true }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(observedDirectiveMessage).toContain('search_wines');
    expect(observedDirectiveMessage).toMatch(/[가-힣]/u);  // contains Hangul
    expect(observedDirectiveMessage).toBe(`[directive] ${MINI_LOOP_DIRECTIVE_COPY_KOREAN.groundedSearch}`);
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
        return asToolUseResult([toolUse('search_wines', { query: 'wine' })]);
      },
      async () => asTextResult('Recommend wine-1.'),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
    const out = await runner.run(makeInput({
      query: 'recommend a wine',
      analysis: makeAnalysis({ hangulDominant: false, requiresGroundedWineSearch: true }),
      maxSteps: 5,
    }));

    expect(out.terminationReason).toBe('answer');
    expect(observedDirectiveMessage).toBe(`[directive] ${MINI_LOOP_DIRECTIVE_COPY_ENGLISH.groundedSearch}`);
  });
});

describe('MiniLoopRunner — token accumulation', () => {
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
      async () => asToolUseResult([toolUse('search_wines', { query: 'q' })], usage1),
      async () => asTextResult('answer', usage2),
    ]);
    const runner = new MiniLoopRunner({ structuredLlm: llm, logger: makeLogger() });
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
      steps: [] as MiniLoopStep[],
    };
  }

  it('returns grounded_search_required when contract requires it and no search yet (English)', () => {
    const input = makeInput({
      analysis: makeAnalysis({ requiresGroundedWineSearch: true, hangulDominant: false }),
    });
    const out = computeNextDirective(input, makeStateView([]), selectDirectiveCopy(false));
    expect(out?.kind).toBe('grounded_search_required');
    if (out?.kind === 'grounded_search_required') {
      expect(out.instruction).toBe(MINI_LOOP_DIRECTIVE_COPY_ENGLISH.groundedSearch);
    }
  });

  it('returns required_tool when contract requires get_food_pairings (Korean copy)', () => {
    const input = makeInput({
      analysis: makeAnalysis({ requiredTool: 'get_food_pairings', hangulDominant: true }),
    });
    const out = computeNextDirective(input, makeStateView([]), selectDirectiveCopy(true));
    expect(out?.kind).toBe('required_tool');
    if (out?.kind === 'required_tool') {
      expect(out.tool).toBe('get_food_pairings');
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
        { tool: 'search_wines', kind: 'success', result: makeSearchResponse(['wine-1']) },
      ]),
      selectDirectiveCopy(false),
    );
    expect(out).toBeUndefined();
  });

  it('returns pending_drinkability_check when drinkability contract not yet satisfied', () => {
    const input = makeInput({
      analysis: makeAnalysis({ requiresDrinkabilityCheck: true }),
    });
    const out = computeNextDirective(
      input,
      makeStateView([
        { tool: 'search_wines', kind: 'success', result: makeSearchResponse(['wine-1', 'wine-2']) },
      ]),
      selectDirectiveCopy(false),
    );
    expect(out?.kind).toBe('pending_drinkability_check');
    if (out?.kind === 'pending_drinkability_check') {
      expect(out.entityIds).toContain('wine-1');
      expect(out.entityIds).toContain('wine-2');
    }
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
      makeStateView([{ tool: 'search_wines', kind: 'empty_result' }]),
      selectDirectiveCopy(false),
    );
    expect(first?.kind).toBe('relax_constraints_retry');

    // After a 2nd search call (even if empty), no further relax retries.
    const second = computeNextDirective(
      input,
      makeStateView([
        { tool: 'search_wines', kind: 'empty_result' },
        { tool: 'search_wines', kind: 'empty_result' },
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
      makeStateView([{ tool: 'search_wines', kind: 'empty_result' }]),
      selectDirectiveCopy(false),
    );
    expect(out).toBeUndefined();
  });
});
