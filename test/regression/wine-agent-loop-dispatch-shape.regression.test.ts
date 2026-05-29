/**
 * Regression: wine-agent-loop tool dispatch shape (SOLID H1/H2 follow-up).
 *
 * Three invariants:
 *   1. `lookup_wine` routes through the shared schema — empty / placeholder
 *      query produces an INVALID_INPUT-style observation, no port call.
 *   2. `get_food_pairings` returns the WHOLE FoodPairingResult as
 *      `rawResult` (sibling shape), not the unwrapped results array. The
 *      observation continues to be derived from `.results` so the LLM only
 *      sees per-wine fields.
 *   3. The default "unknown tool" observation reads the tool-name display
 *      string from the SSoT (KNOWN_AGENT_TOOL_NAMES_DISPLAY), so adding a
 *      new tool to the SSoT propagates here without an edit.
 *
 * The runner's `invokeToolPort` is not exported, so we exercise it via the
 * public `WineAgentLoopRunner.run` entrypoint with a fake LLM port that emits the
 * tool_use we want to test.
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
} from '../../src/domain/ai/port/structured-llm.port.js';
import { WineAgentLoopRunner } from '../../src/application/wine-search/wine-agent-loop.js';
import {
  WINE_AGENT_LOOP_DEFAULT_AGENT_TIMEOUT_MS,
  WINE_AGENT_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
  WINE_AGENT_LOOP_DEFAULT_MAX_STEPS,
  WINE_AGENT_LOOP_DEFAULT_MAX_TOTAL_TOKENS,
  WINE_AGENT_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS,
  WINE_AGENT_LOOP_DEFAULT_PER_TOOL_CAP,
  type WineAgentLoopInput,
  type WineAgentLoopToolPorts,
} from '../../src/application/wine-search/wine-agent-loop-schemas.js';
import { KNOWN_AGENT_TOOL_NAMES_DISPLAY } from '../../src/domain/agent/model/agent-tool-attempt-schema.js';
import type {
  SearchUseCasePort,
} from '../../src/application/wine-search/execution-runner.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Fixtures (slim copies of the wine-agent-loop.test.ts shared helpers — keeping
// regression coverage self-contained).
// ---------------------------------------------------------------------------

function makeTokenUsage(input: number, output: number): TokenUsage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0 };
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

function makeAnalysis(): WineSearchAnalysis {
  return {
    intent: 'search',
    anchors: [],
    normalizedConstraints: [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: false,
      hasEntityMetadataSignal: false,
    },
    expectedMultiStep: true,
    recommendedBudget: { maxSteps: WINE_AGENT_LOOP_DEFAULT_MAX_STEPS, perToolCap: WINE_AGENT_LOOP_DEFAULT_PER_TOOL_CAP },
    hangulDominant: false,
    preservedSurface: 'fixture-query',
  };
}

function makeSearchPort(): SearchUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(() => Promise.resolve(makeSearchResponse(['w-1'])));
  return { executeMock, execute: (input, reqId, _opts) => executeMock(input, reqId) };
}

function makeToolPorts(overrides?: Partial<WineAgentLoopToolPorts>): WineAgentLoopToolPorts {
  return {
    searchUseCase: overrides?.searchUseCase ?? makeSearchPort(),
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
    analyze: <TSchema extends z.ZodTypeAny>(_req: AnalyzeRequest<TSchema>):
      Promise<AnalyzeResult<z.infer<TSchema>>> => { throw new Error('not used'); },
    execute: (req: ExecuteRequest) => executeMock(req),
    synthesize: <TSchema extends z.ZodTypeAny>(_req: SynthesizeRequest<TSchema>):
      Promise<SynthesizeResult<z.infer<TSchema>>> => { throw new Error('not used'); },
  };
}

function toolUse(name: string, input: Record<string, unknown>, id = 'tu-1'): ToolUseCall {
  return { id, name, input };
}

function asToolUseResult(calls: readonly ToolUseCall[]): ExecuteResult {
  return {
    kind: 'tool_use',
    calls,
    usage: makeTokenUsage(120, 60),
    durationMs: 5,
    stopReason: 'tool_use',
  };
}

function asTextResult(text: string): ExecuteResult {
  return {
    kind: 'text',
    text,
    usage: makeTokenUsage(100, 50),
    durationMs: 5,
    stopReason: 'end_turn',
  };
}

function makePassthroughToolDef(name: string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: {
      parse: (x: unknown) => x,
      safeParse: (x: unknown) => ({ success: true as const, data: x }),
    } as unknown as ToolDefinition['inputSchema'],
  };
}

function makeInput(overrides: Partial<WineAgentLoopInput>): WineAgentLoopInput {
  return {
    query: 'q',
    analysis: makeAnalysis(),
    requestId: 'req-mldsr-1',
    tools: overrides.tools ?? [
      makePassthroughToolDef('search_wines'),
      makePassthroughToolDef('lookup_wine'),
      makePassthroughToolDef('get_food_pairings'),
      // Intentionally include a name that is NOT in KNOWN_AGENT_TOOL_NAMES so
      // the unknown-tool default branch fires when the LLM emits it.
      makePassthroughToolDef('mystery_tool'),
    ],
    toolPorts: overrides.toolPorts ?? makeToolPorts(),
    perStepTimeoutMs: WINE_AGENT_LOOP_DEFAULT_PER_STEP_TIMEOUT_MS,
    agentTimeoutMs: WINE_AGENT_LOOP_DEFAULT_AGENT_TIMEOUT_MS,
    maxSteps: WINE_AGENT_LOOP_DEFAULT_MAX_STEPS,
    maxTotalTokens: WINE_AGENT_LOOP_DEFAULT_MAX_TOTAL_TOKENS,
    maxOutputTokens: WINE_AGENT_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
    perToolCap: WINE_AGENT_LOOP_DEFAULT_PER_TOOL_CAP,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wine-agent-loop dispatch — lookup_wine uses shared normalizer (H2)', () => {
  it('rejects an empty query with an invalid-input observation; never calls the search port', async () => {
    const searchPort = makeSearchPort();
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('lookup_wine', { query: '' })]),
      async () => asTextResult('Done.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm });
    const out = await runner.run(makeInput({
      toolPorts: makeToolPorts({ searchUseCase: searchPort }),
    }));

    const firstStep = out.steps[0];
    expect(firstStep?.kind).toBe('tool_use');
    expect(firstStep?.observations[0]).toMatch(/invalid input/i);
    // The wine-agent-loop's lookup branch must use the shared normalizer's validation
    // BEFORE invoking the search port.
    expect(searchPort.executeMock).not.toHaveBeenCalled();
  });

  it('rejects a placeholder query (the bug the legacy wine-agent-loop dispatcher missed)', async () => {
    const searchPort = makeSearchPort();
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('lookup_wine', { query: '__TODO__' })]),
      async () => asTextResult('Done.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm });
    const out = await runner.run(makeInput({
      toolPorts: makeToolPorts({ searchUseCase: searchPort }),
    }));

    expect(out.steps[0]?.observations[0]).toMatch(/invalid input/i);
    expect(searchPort.executeMock).not.toHaveBeenCalled();
  });

  it('dispatches a valid lookup with mode=entity + clamped limit', async () => {
    const searchPort = makeSearchPort();
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('lookup_wine', { query: 'Sassicaia', limit: 999 })]),
      async () => asTextResult('Found.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm });
    await runner.run(makeInput({
      toolPorts: makeToolPorts({ searchUseCase: searchPort }),
    }));

    const [searchInput] = searchPort.executeMock.mock.calls[0] ?? [];
    const search = searchInput as { query?: string; mode?: string; limit?: number };
    expect(search?.query).toBe('Sassicaia');
    expect(search?.mode).toBe('entity');
    // Clamp to LOOKUP_WINE_LIMIT_MAX (3) — same clamp as the agent-tools path.
    expect(search?.limit).toBe(3);
  });
});

describe('wine-agent-loop dispatch — unknown tool branch uses SSoT display string', () => {
  it('default-case observation lists all known tools via KNOWN_AGENT_TOOL_NAMES_DISPLAY', async () => {
    const llm = makeStubLlm([
      async () => asToolUseResult([toolUse('mystery_tool', { foo: 'bar' })]),
      async () => asTextResult('Sorry.'),
    ]);
    const runner = new WineAgentLoopRunner({ structuredLlm: llm });
    const out = await runner.run(makeInput({}));

    const obs = out.steps[0]?.observations[0] ?? '';
    expect(obs).toContain('mystery_tool');
    expect(obs).toContain(KNOWN_AGENT_TOOL_NAMES_DISPLAY);
  });
});
