import { describe, it, expect } from 'vitest';
import { analyzeScenarioRetrieval, summarizeRetrievalAnalysis } from '../retrieval-analysis.js';
import type { AgentBenchmarkScenario } from '../scenario.js';

const stub = (id: number): AgentBenchmarkScenario => ({
  id,
  tier: 'standard',
  query: `q${id}`,
  description: '',
  expectation: { tools: [] },
} as unknown as AgentBenchmarkScenario);

describe('analyzeScenarioRetrieval', () => {
  it('perfect retrieval and ranking → gap=neither', () => {
    const relevant = new Set(['a', 'b', 'c']);
    const analysis = analyzeScenarioRetrieval(
      stub(1),
      ['a', 'b', 'c'],
      ['a', 'b', 'c'],
      relevant,
    );
    expect(analysis.recall_at_20).toBe(1);
    expect(analysis.gap).toBe('neither');
    expect(analysis.actual_ndcg_at_10).toBeCloseTo(analysis.oracle_ndcg_at_10);
  });

  it('all relevant retrieved but ranked at the bottom → ranking_bottleneck', () => {
    const relevant = new Set(['a', 'b']);
    const analysis = analyzeScenarioRetrieval(
      stub(2),
      ['x', 'y', 'a', 'b'],
      ['x', 'y', 'a', 'b'], // relevant pushed to bottom
      relevant,
    );
    expect(analysis.recall_at_20).toBe(1);
    // ranking_efficiency < 0.8 because actual NDCG much lower than oracle
    expect(analysis.gap).toMatch(/ranking_bottleneck|both/);
  });

  it('relevant docs not in retrieval → retrieval_bottleneck', () => {
    const relevant = new Set(['a', 'b', 'c', 'd', 'e']);
    const analysis = analyzeScenarioRetrieval(
      stub(3),
      ['a', 'x', 'y'], // only 1 of 5 relevant
      ['a', 'x', 'y'],
      relevant,
    );
    expect(analysis.recall_at_20).toBeLessThan(0.8);
    expect(analysis.gap).toMatch(/retrieval_bottleneck|both/);
  });

  it('empty inputs → zero metrics', () => {
    const analysis = analyzeScenarioRetrieval(stub(4), [], [], new Set());
    expect(analysis.recall_at_20).toBe(0);
    expect(analysis.actual_ndcg_at_10).toBe(0);
  });
});

describe('summarizeRetrievalAnalysis', () => {
  it('empty list → zero summary', () => {
    const summary = summarizeRetrievalAnalysis([]);
    expect(summary.scenarioCount).toBe(0);
    expect(summary.mean_recall_at_20).toBe(0);
  });

  it('aggregates recall and gap counts', () => {
    const relevant = new Set(['a']);
    const a1 = analyzeScenarioRetrieval(stub(1), ['a'], ['a'], relevant);
    const a2 = analyzeScenarioRetrieval(stub(2), ['x'], ['x'], relevant);
    const summary = summarizeRetrievalAnalysis([a1, a2]);
    expect(summary.scenarioCount).toBe(2);
    expect(summary.mean_recall_at_20).toBeCloseTo(0.5);
    expect(summary.retrieval_bottleneck_count + summary.ranking_bottleneck_count + summary.both_count + summary.neither_count).toBe(2);
  });
});
