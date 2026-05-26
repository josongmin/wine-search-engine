import { describe, it, expect } from 'vitest';
import { scoreScenario } from '../scorer.js';
import { makeScenario, makeExecution, tool } from './__helpers__/scorer-test-helpers.js';

describe('scoreToolAccuracy', () => {
  it('returns 1 when no expected tools', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5 }),
      makeExecution({ toolsUsed: [tool('anything')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('returns 1 when all expected tools called', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_wines' }] }),
      makeExecution({ toolsUsed: [tool('search_wines', '{"query":"x"}')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('penalises missing expected tool', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        tools: [{ tool: 'search_wines' }, { tool: 'search_wines' }],
      }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(0.5);
  });

  it('inputContains: passes when args contain required substring', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        tools: [{ tool: 'search_wines', inputContains: ['Opus'] }],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"Opus One 2018"}')],
      }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('inputContains: fails when args missing required substring', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        tools: [{ tool: 'search_wines', inputContains: ['Opus'] }],
      }),
      makeExecution({
        toolsUsed: [tool('search_wines', '{"query":"Cabernet"}')],
      }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(0);
  });

  it('ordered: penalises out-of-order calls', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        ordered: true,
        tools: [{ tool: 'search_wines' }, { tool: 'search_wines' }],
      }),
      makeExecution({
        toolsUsed: [tool('compare_wines'), tool('search_wines')],
      }),
      undefined,
    );
    // Both matched (1.0) but out of order → ×0.5
    expect(r.scores.toolAccuracy).toBe(0.5);
  });

  it('extra-call penalty: docks 10% per unexpected call', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 5, tools: [{ tool: 'search_wines' }] }),
      makeExecution({
        toolsUsed: [
          tool('search_wines'),
          tool('get_food_pairings'),
          tool('get_food_pairings'),
        ],
      }),
      undefined,
    );
    // 1.0 base × (1 - 0.2) = 0.8
    expect(r.scores.toolAccuracy).toBeCloseTo(0.8, 5);
  });

  it('extra-call penalty: caps at 50%', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 10, tools: [{ tool: 'search_wines' }] }),
      makeExecution({
        toolsUsed: [
          tool('search_wines'),
          tool('a'), tool('b'), tool('c'), tool('d'), tool('e'), tool('f'),
          tool('g'), tool('h'),
        ],
      }),
      undefined,
    );
    // 1.0 × (1 - 0.5) = 0.5
    expect(r.scores.toolAccuracy).toBe(0.5);
  });

  it('mustNotCallTools: hard fail when forbidden tool called', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 5,
        mustNotCallTools: ['search_wines'],
      }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(0);
  });

  it('expectedBlocked: passes when no tools called', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, expectedBlocked: true }),
      makeExecution({ toolsUsed: [], terminationReason: 'blocked', stepCount: 0 }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
  });

  it('expectedBlocked: fails when tools called', () => {
    const r = scoreScenario(
      makeScenario({ maxSteps: 2, expectedBlocked: true }),
      makeExecution({ toolsUsed: [tool('search_wines')] }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Step efficiency
// ─────────────────────────────────────────────────────────────────────


describe('TOOL_DUPLICATE_CALLS — all violations penalized', () => {
  it('multiple tools duplicated → both penalized (no break-early)', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 10,
        tools: [{ tool: 'search_wines' }, { tool: 'search_wines' }],
      }),
      makeExecution({
        stepCount: 6,
        toolCallCount: 6,
        toolsUsed: [
          tool('search_wines'), tool('search_wines'), tool('search_wines'),
          tool('compare_wines'), tool('compare_wines'), tool('compare_wines'),
        ],
      }),
      undefined,
    );
    // Both tools called 3x (expected 1x each), both should be penalized.
    // With 0.7 penalty per tool: 1.0 * 0.7 * 0.7 = 0.49
    expect(r.scores.toolAccuracy).toBeLessThan(0.5);
  });

  it('single tool duplicated → only one penalty applied', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 10,
        tools: [{ tool: 'search_wines' }, { tool: 'search_wines' }],
      }),
      makeExecution({
        stepCount: 4,
        toolCallCount: 4,
        toolsUsed: [
          tool('search_wines'), tool('search_wines'), tool('search_wines'),
          tool('compare_wines'),
        ],
      }),
      undefined,
    );
    // Only search_wines is over-duplicated (3x vs 1x expected). Score = 1.0 * 0.7 = 0.7
    expect(r.scores.toolAccuracy).toBeGreaterThanOrEqual(0.69);
    expect(r.scores.toolAccuracy).toBeLessThan(0.71);
  });

  it('does not penalize slot-disjoint parallel search_wines calls as duplicates', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 10,
        tools: [{ tool: 'search_wines' }],
      }),
      makeExecution({
        stepCount: 3,
        toolCallCount: 2,
        toolsUsed: [
          tool('search_wines', '{"query":"커플용 세트","wine_type":"red","limit":1,"want_diversity":false}'),
          tool('search_wines', '{"query":"커플용 세트","wine_type":"white","limit":1,"want_diversity":false}'),
        ],
      }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBe(1);
    expect(r.diagnostics?.some((d) => d.code === 'TOOL_DUPLICATE_CALLS')).toBe(false);
  });

  it('still penalizes repeated equivalent structured search_wines calls', () => {
    const r = scoreScenario(
      makeScenario({
        maxSteps: 10,
        tools: [{ tool: 'search_wines' }],
      }),
      makeExecution({
        stepCount: 3,
        toolCallCount: 2,
        toolsUsed: [
          tool('search_wines', '{"query":"오퍼스원","wine_type":"red","limit":1}'),
          tool('search_wines', '{"wine_type":"red","limit":1,"query":"오퍼스원"}'),
        ],
      }),
      undefined,
    );
    expect(r.scores.toolAccuracy).toBeGreaterThanOrEqual(0.69);
    expect(r.scores.toolAccuracy).toBeLessThan(0.71);
    expect(r.diagnostics?.some((d) => d.code === 'TOOL_DUPLICATE_CALLS')).toBe(true);
  });
});

