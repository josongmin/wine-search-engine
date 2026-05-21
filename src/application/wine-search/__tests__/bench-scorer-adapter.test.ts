/**
 * Tests for the `WineSearchResult → ScenarioExecution` and
 * `AgentResult → ScenarioExecution` projections.
 *
 * Coverage targets the SOTA+++++ self-audit triad (CLAUDE.md):
 *   - happy-path inputs (the shape the function was designed for)
 *   - empty / degenerate inputs (empty arrays, layer-4 degraded results)
 *   - adversarial inputs (Korean text, deeply nested arguments)
 */

import { describe, expect, it } from 'vitest';
import type { AgentResult } from '@domain/agent/model/agent-result.js';
import type { AgentStep } from '@domain/agent/model/agent-step.js';
import {
  agentResultToScenarioExecution,
  mapAgentTerminationToScenario,
  wineSearchResultToScenarioExecution,
} from '../bench-scorer-adapter.js';
import type { WineSearchResult, ExecutionStep } from '../wine-search-result-schemas.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeStep(partial: Partial<ExecutionStep> & Pick<ExecutionStep, 'source' | 'summary' | 'index'>): ExecutionStep {
  return {
    durationMs: 10,
    ...partial,
  };
}

function makeWineSearchResult(partial: Partial<WineSearchResult> = {}): WineSearchResult {
  return {
    answer: 'Recommended: Opus One 2018',
    layer: 'primary',
    groundedOnToolResults: true,
    toolOutcomes: [],
    executionSteps: [
      makeStep({
        index: 0,
        source: 'runner',
        summary: 'search wines',
        toolCalls: [{ name: 'search_wines', arguments: { q: 'opus' } }],
        observations: ['found 3 wines'],
      }),
    ],
    toolCallCount: 1,
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
    },
    totalDurationMs: 800,
    terminationReason: 'answer',
    policyBlocked: false,
    degradedReason: undefined,
    intent: 'search',
    planKind: 'single-search',
    ...partial,
  };
}

function makeAgentResult(partial: Partial<AgentResult> = {}): AgentResult {
  return {
    answer: 'Recommended: Opus One 2018',
    steps: [
      {
        index: 0,
        thought: 'search',
        action: { tool: 'search_wines', input: { q: 'opus' } },
        observation: 'found 3 wines',
        durationMs: 10,
        tokenCount: { input: 100, output: 50 },
      },
    ],
    totalDurationMs: 1_000,
    totalTokens: { input: 100, output: 50 },
    toolCallCount: 1,
    fallbackApplied: false,
    terminationReason: 'answer',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// wineSearchResultToScenarioExecution
// ---------------------------------------------------------------------------

describe('wineSearchResultToScenarioExecution', () => {
  it('happy-path: maps every field correctly', () => {
    const result = makeWineSearchResult();
    const exec = wineSearchResultToScenarioExecution(result);
    expect(exec.answer).toBe('Recommended: Opus One 2018');
    expect(exec.stepCount).toBe(1);
    expect(exec.toolCallCount).toBe(1);
    expect(exec.toolsUsed).toEqual([
      { tool: 'search_wines', input: JSON.stringify({ q: 'opus' }) },
    ]);
    expect(exec.observations).toEqual(['found 3 wines']);
    expect(exec.terminationReason).toBe('answer');
    expect(exec.totalDurationMs).toBe(800);
    expect(exec.totalTokens).toEqual({ input: 100, output: 50 });
  });

  it('drops empty tool-call arrays → toolsUsed=[]', () => {
    const result = makeWineSearchResult({
      executionSteps: [
        makeStep({ index: 0, source: 'runner', summary: 'noop' }),
      ],
      toolCallCount: 0,
    });
    const exec = wineSearchResultToScenarioExecution(result);
    expect(exec.toolsUsed).toEqual([]);
    expect(exec.observations).toEqual([]);
    expect(exec.toolCallCount).toBe(0);
  });

  it('multi-step result flattens toolsUsed in order', () => {
    const result = makeWineSearchResult({
      executionSteps: [
        makeStep({
          index: 0,
          source: 'runner',
          summary: 's1',
          toolCalls: [{ name: 'search_wines', arguments: { q: 'a' } }],
          observations: ['o1'],
        }),
        makeStep({
          index: 1,
          source: 'mini_loop',
          summary: 's2',
          toolCalls: [
            { name: 'food_pairing', arguments: { dish: 'steak' } },
            { name: 'drinkability', arguments: { id: 'w-1' } },
          ],
          observations: ['o2', 'o3'],
        }),
      ],
      toolCallCount: 3,
    });
    const exec = wineSearchResultToScenarioExecution(result);
    expect(exec.toolsUsed.map((c) => c.tool)).toEqual([
      'search_wines',
      'food_pairing',
      'drinkability',
    ]);
    expect(exec.observations).toEqual(['o1', 'o2', 'o3']);
    expect(exec.stepCount).toBe(2);
  });

  it('excludes analyzer / router / synthesizer steps from stepCount and toolsUsed', () => {
    const result = makeWineSearchResult({
      executionSteps: [
        makeStep({ index: 0, source: 'analyzer', summary: 'parse' }),
        makeStep({ index: 1, source: 'router', summary: 'route' }),
        makeStep({
          index: 2,
          source: 'runner',
          summary: 'search',
          toolCalls: [{ name: 'search_wines', arguments: {} }],
          observations: ['ok'],
        }),
        makeStep({ index: 3, source: 'synthesizer', summary: 'synth' }),
      ],
      toolCallCount: 1,
    });
    const exec = wineSearchResultToScenarioExecution(result);
    expect(exec.stepCount).toBe(1);
    expect(exec.toolsUsed.map((c) => c.tool)).toEqual(['search_wines']);
    expect(exec.observations).toEqual(['ok']);
  });

  it('preserves Korean answer byte-identical (CLAUDE.md rule 5)', () => {
    const koreanAnswer = '오퍼스 원 2018 빈티지를 추천드립니다. 카베르네 소비뇽 블렌드.';
    const result = makeWineSearchResult({ answer: koreanAnswer });
    const exec = wineSearchResultToScenarioExecution(result);
    expect(exec.answer).toBe(koreanAnswer);
  });

  it('drops cache tokens from totalTokens (scorer only sees raw input/output)', () => {
    const result = makeWineSearchResult({
      tokenUsage: {
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 500,
        cacheCreationTokens: 50,
      },
    });
    const exec = wineSearchResultToScenarioExecution(result);
    expect(exec.totalTokens).toEqual({ input: 200, output: 80 });
    expect(Object.keys(exec.totalTokens).sort()).toEqual(['input', 'output']);
  });

  it('round-trip stability: same input → identical output across calls', () => {
    const result = makeWineSearchResult();
    const a = wineSearchResultToScenarioExecution(result);
    const b = wineSearchResultToScenarioExecution(result);
    expect(a).toStrictEqual(b);
  });

  it('layer-4 degraded result (no tool outcomes) maps to a valid ScenarioExecution', () => {
    const result = makeWineSearchResult({
      layer: 'layer4',
      groundedOnToolResults: false,
      toolOutcomes: [],
      executionSteps: [
        makeStep({ index: 0, source: 'synthesizer', summary: 'layer4 fallback' }),
      ],
      toolCallCount: 0,
      terminationReason: 'fallback',
    });
    const exec = wineSearchResultToScenarioExecution(result);
    expect(exec.toolCallCount).toBe(0);
    expect(exec.stepCount).toBe(0);
    expect(exec.toolsUsed).toEqual([]);
    expect(exec.observations).toEqual([]);
    expect(exec.terminationReason).toBe('fallback');
  });

  it('serializes nested tool-call arguments deterministically as JSON', () => {
    const result = makeWineSearchResult({
      executionSteps: [
        makeStep({
          index: 0,
          source: 'runner',
          summary: 's',
          toolCalls: [{
            name: 'search_wines',
            arguments: { filters: { country: 'France', vintage: 2015 } },
          }],
        }),
      ],
    });
    const exec = wineSearchResultToScenarioExecution(result);
    const parsed = JSON.parse(exec.toolsUsed[0]?.input ?? '{}') as Record<string, unknown>;
    expect(parsed['filters']).toEqual({ country: 'France', vintage: 2015 });
  });
});

// ---------------------------------------------------------------------------
// agentResultToScenarioExecution
// ---------------------------------------------------------------------------

describe('agentResultToScenarioExecution', () => {
  it('matches the legacy bench-runner adapter shape for a single sequential step', () => {
    const result = makeAgentResult();
    const exec = agentResultToScenarioExecution(result);
    expect(exec.answer).toBe('Recommended: Opus One 2018');
    expect(exec.stepCount).toBe(1);
    expect(exec.toolCallCount).toBe(1);
    expect(exec.toolsUsed).toEqual([
      { tool: 'search_wines', input: JSON.stringify({ q: 'opus' }) },
    ]);
    expect(exec.observations).toEqual(['found 3 wines']);
    expect(exec.terminationReason).toBe('answer');
    expect(exec.totalTokens).toEqual({ input: 100, output: 50 });
  });

  it('handles parallel-batch step via actionPairs', () => {
    const result = makeAgentResult({
      steps: [
        {
          index: 0,
          thought: 'parallel',
          actionPairs: [
            { action: { tool: 'search_wines', input: { q: 'a' } }, observation: 'oa' },
            { action: { tool: 'search_wines', input: { q: 'b' } }, observation: 'ob' },
          ],
          durationMs: 10,
          tokenCount: { input: 10, output: 5 },
        } satisfies AgentStep,
      ],
      toolCallCount: 2,
    });
    const exec = agentResultToScenarioExecution(result);
    expect(exec.toolsUsed.map((c) => c.tool)).toEqual(['search_wines', 'search_wines']);
    expect(exec.observations).toEqual(['oa', 'ob']);
  });

  it('round-trip stability: identical input → identical output', () => {
    const result = makeAgentResult();
    const a = agentResultToScenarioExecution(result);
    const b = agentResultToScenarioExecution(result);
    expect(a).toStrictEqual(b);
  });

  it('attaches evidenceFrames + evidenceFrameCount when present', () => {
    const result = makeAgentResult({
      evidenceFrames: [
        {
          tool: 'search_wines',
          observationSnapshot: 'snapshot',
          payload: { ok: true },
        } as unknown as NonNullable<AgentResult['evidenceFrames']>[number],
      ],
    });
    const exec = agentResultToScenarioExecution(result);
    expect(exec.evidenceFrameCount).toBe(1);
    expect(exec.evidenceFrames?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// mapAgentTerminationToScenario (exhaustive)
// ---------------------------------------------------------------------------

describe('mapAgentTerminationToScenario', () => {
  it.each([
    ['answer', 'answer'],
    ['timeout', 'timeout'],
    ['error', 'error'],
    ['blocked', 'blocked'],
    ['max_steps', 'fallback'],
    ['budget', 'fallback'],
    ['loop_detected', 'fallback'],
    ['fallback', 'fallback'],
    ['aborted', 'fallback'],
  ] as const)('%s → %s', (input, expected) => {
    expect(mapAgentTerminationToScenario(input)).toBe(expected);
  });
});
