/**
 * Regression: MiniLoopRunner dispatches multi-tool LLM turns in PARALLEL.
 *
 * The legacy implementation (mini-loop.ts:340-354) used a `for...await` loop
 * to call `dispatchTool` once per tool call emitted by the LLM. When a
 * single LLM turn emits 2-3 tool calls (common: compare + two
 * drinking-window checks), serial dispatch tripled per-step latency.
 *
 * This regression pins the parallel contract: when an LLM turn emits N
 * tool calls, all N dispatches start before any of them resolves.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { MiniLoopRunner } from '../../src/application/wine-search/mini-loop.js';
import type { MiniLoopInput } from '../../src/application/wine-search/mini-loop-schemas.js';
import type {
  StructuredLlmPort,
  ExecuteRequest,
  ExecuteResult,
} from '../../src/domain/ai/port/structured-llm.port.js';
import type { WineSearchAnalysis } from '../../src/application/wine-search/wine-search-schemas.js';

function makeLlm(scriptedFirstTurnTools: ReadonlyArray<{ readonly tool: string; readonly input: Record<string, unknown> }>): StructuredLlmPort {
  let turn = 0;
  return {
    analyze: vi.fn(),
    synthesize: vi.fn(),
    execute: vi.fn(async (_req: ExecuteRequest): Promise<ExecuteResult> => {
      turn += 1;
      if (turn === 1) {
        return {
          kind: 'tool_use',
          calls: scriptedFirstTurnTools.map((t, i) => ({ id: `call_${i}`, name: t.tool, input: t.input })),
          usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
          durationMs: 1,
          stopReason: 'tool_use',
        };
      }
      return {
        kind: 'text',
        text: 'done',
        usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        durationMs: 1,
        stopReason: 'end_turn',
      };
    }),
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
    expectedMultiStep: false,
    recommendedBudget: { maxSteps: 4, perToolCap: 3 },
    hangulDominant: false,
    preservedSurface: 'test',
  };
}

describe('mini-loop parallel tool dispatch (F1 regression)', () => {
  it('starts ALL tool dispatches before any of them resolves (Promise.all shape)', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const releaseSignals: Array<() => void> = [];
    const searchExecute = vi.fn(async (_input: unknown, _requestId: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((resolve) => releaseSignals.push(resolve));
      inFlight -= 1;
      return {
        queryType: 'search' as const,
        intent: 'search' as const,
        executionTimeMs: 1,
        candidateCount: 0,
        results: [],
        metadata: {},
      } as never;
    });

    const llm = makeLlm([
      { tool: 'search_wines', input: { query: 'a' } },
      { tool: 'search_wines', input: { query: 'b' } },
      { tool: 'search_wines', input: { query: 'c' } },
    ]);

    const runner = new MiniLoopRunner({
      structuredLlm: llm,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });

    const minimalTool = {
      name: 'search_wines',
      description: 'search',
      inputSchema: z.object({ query: z.string() }),
    } as const;

    const input: MiniLoopInput = {
      query: 'test',
      analysis: makeAnalysis(),
      requestId: 'req-parallel',
      tools: [minimalTool],
      toolPorts: {
        searchUseCase: { execute: searchExecute },
        comparisonUseCase: { execute: vi.fn() },
        foodPairingUseCase: { execute: vi.fn() },
        drinkabilityUseCase: { probe: vi.fn() },
      } as never,
      perStepTimeoutMs: 2000,
      agentTimeoutMs: 5000,
      maxSteps: 3,
      maxTotalTokens: 100_000,
      maxOutputTokens: 1024,
      perToolCap: 3,
    };

    // Release all gated tool calls after a short tick — by then all three
    // dispatches must have started if (and only if) dispatch is parallel.
    const releaseAfterTick = (): Promise<void> => new Promise((resolve) => {
      setTimeout(() => {
        while (releaseSignals.length > 0) releaseSignals.shift()?.();
        resolve();
      }, 30);
    });

    const [outcome] = await Promise.all([runner.run(input), releaseAfterTick()]);

    expect(searchExecute).toHaveBeenCalledTimes(3);
    expect(peakInFlight).toBe(3);
    expect(outcome.steps[0]?.toolOutcomes.length).toBe(3);
  });
});
