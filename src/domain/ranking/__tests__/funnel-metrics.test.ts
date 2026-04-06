/**
 * T5.6: Unit tests for computeFunnelMetrics.
 *
 * Covers:
 *   - Empty result set
 *   - Single result
 *   - Multiple results (normal case)
 *   - rerankChangedTopK = true (top-5 order changed after rerank)
 *   - rerankChangedTopK = false (top-5 order unchanged after rerank)
 *   - rerankChangedTopK = false when rerank was not executed
 *   - producerDiversity counting (dedup, empty producer, whitespace)
 *   - coarsePrunePassRate with and without prune stage
 *   - scoreGapRank1Rank2 edge cases
 */

import { describe, it, expect } from 'vitest';
import { computeFunnelMetrics } from '../service/funnel-metrics.js';
import type { RankingFunnelTrace } from '../model/ranking-stage.js';
import type { RankedResult } from '../model/ranked-result.js';
import { createEntityId } from '../../shared/types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrace(overrides: Partial<RankingFunnelTrace> = {}): RankingFunnelTrace {
  return {
    stages: [
      { stage: 'coarse_prune', inputCount: 10, outputCount: 8, latencyMs: 0 },
      { stage: 'primary_rank', inputCount: 8, outputCount: 8, latencyMs: 5 },
      { stage: 'precision_rerank', inputCount: 8, outputCount: 8, latencyMs: 0 },
      { stage: 'policy_apply', inputCount: 8, outputCount: 8, latencyMs: 0 },
    ],
    totalLatencyMs: 5,
    precisionRerankExecuted: false,
    policyApplied: false,
    ...overrides,
  };
}

function makeResult(
  id: string,
  finalScore: number,
  producer?: string,
): RankedResult {
  return {
    entityId: createEntityId(id),
    canonicalLabel: `Wine ${id}`,
    finalScore,
    rank: 1,
    componentScores: {
      entityIntegrity: 0.8,
      semantic: 0.5,
      hardConstraintPass: true,
      softConstraint: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
      popularity: 0.3,
      availability: 1.0,
      uncertaintyPenalty: 0.1,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    ...(producer !== undefined ? { producer } : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('computeFunnelMetrics (T5.6)', () => {
  describe('empty results', () => {
    it('returns zero/null/false defaults for empty result set', () => {
      const trace = makeTrace();
      const metrics = computeFunnelMetrics(trace, []);

      expect(metrics.coarsePrunePassRate).toBeCloseTo(0.8); // 8/10 from trace
      expect(metrics.rerankChangedTopK).toBe(false);
      expect(metrics.meanFinalScore).toBe(0);
      expect(metrics.scoreGapRank1Rank2).toBeNull();
      expect(metrics.producerDiversity).toBe(0);
    });
  });

  describe('single result', () => {
    it('scoreGapRank1Rank2 is null (only one result)', () => {
      const trace = makeTrace();
      const results = [makeResult('e1', 0.9, 'Domain Leflaive')];
      const metrics = computeFunnelMetrics(trace, results);

      expect(metrics.scoreGapRank1Rank2).toBeNull();
      expect(metrics.meanFinalScore).toBeCloseTo(0.9);
      expect(metrics.producerDiversity).toBe(1);
      expect(metrics.rerankChangedTopK).toBe(false);
    });
  });

  describe('multiple results — normal case', () => {
    it('computes all five metrics correctly', () => {
      const trace = makeTrace({ precisionRerankExecuted: false });
      const results = [
        makeResult('e1', 0.9, 'Chateau Petrus'),
        makeResult('e2', 0.7, 'Opus One'),
        makeResult('e3', 0.5, 'Chateau Petrus'), // duplicate producer
        makeResult('e4', 0.3, 'DRC'),
      ];
      const metrics = computeFunnelMetrics(trace, results);

      expect(metrics.coarsePrunePassRate).toBeCloseTo(0.8); // 8/10
      expect(metrics.meanFinalScore).toBeCloseTo((0.9 + 0.7 + 0.5 + 0.3) / 4);
      expect(metrics.scoreGapRank1Rank2).toBeCloseTo(0.9 - 0.7);
      expect(metrics.producerDiversity).toBe(3); // Petrus, Opus One, DRC (Petrus deduped)
      expect(metrics.rerankChangedTopK).toBe(false); // rerank not executed
    });
  });

  describe('rerankChangedTopK', () => {
    it('is false when rerank was not executed (even with pre-rerank snapshot)', () => {
      const trace = makeTrace({ precisionRerankExecuted: false });
      const results = [
        makeResult('e1', 0.9),
        makeResult('e2', 0.7),
      ];
      const preRerankTop5 = ['e2', 'e1']; // different order
      const metrics = computeFunnelMetrics(trace, results, preRerankTop5);

      // rerank flag is false → should not check the snapshot
      expect(metrics.rerankChangedTopK).toBe(false);
    });

    it('is false when rerank executed and top-5 order is unchanged', () => {
      const trace = makeTrace({ precisionRerankExecuted: true });
      const results = [
        makeResult('e1', 0.9),
        makeResult('e2', 0.7),
        makeResult('e3', 0.5),
      ];
      const preRerankTop5 = ['e1', 'e2', 'e3']; // same order
      const metrics = computeFunnelMetrics(trace, results, preRerankTop5);

      expect(metrics.rerankChangedTopK).toBe(false);
    });

    it('is true when rerank executed and top-5 order changed', () => {
      const trace = makeTrace({ precisionRerankExecuted: true });
      const results = [
        makeResult('e2', 0.9), // was rank-2, now rank-1
        makeResult('e1', 0.85), // was rank-1, now rank-2
        makeResult('e3', 0.5),
      ];
      const preRerankTop5 = ['e1', 'e2', 'e3']; // original order
      const metrics = computeFunnelMetrics(trace, results, preRerankTop5);

      expect(metrics.rerankChangedTopK).toBe(true);
    });

    it('is true when rerank executed and result set size differs from pre-rerank snapshot', () => {
      const trace = makeTrace({ precisionRerankExecuted: true });
      const results = [
        makeResult('e1', 0.9),
        makeResult('e2', 0.7),
        // e3 dropped after rerank
      ];
      const preRerankTop5 = ['e1', 'e2', 'e3'];
      const metrics = computeFunnelMetrics(trace, results, preRerankTop5);

      expect(metrics.rerankChangedTopK).toBe(true);
    });

    it('is false when rerank executed but pre-rerank snapshot is absent', () => {
      const trace = makeTrace({ precisionRerankExecuted: true });
      const results = [makeResult('e1', 0.9), makeResult('e2', 0.7)];
      // no preRerankTop5 argument
      const metrics = computeFunnelMetrics(trace, results);

      expect(metrics.rerankChangedTopK).toBe(false);
    });

    it('is false when rerank executed but pre-rerank snapshot is empty array', () => {
      const trace = makeTrace({ precisionRerankExecuted: true });
      const results = [makeResult('e1', 0.9)];
      const metrics = computeFunnelMetrics(trace, results, []);

      expect(metrics.rerankChangedTopK).toBe(false);
    });
  });

  describe('coarsePrunePassRate', () => {
    it('uses coarse_prune stage outputCount / inputCount', () => {
      const trace = makeTrace({
        stages: [
          { stage: 'coarse_prune', inputCount: 20, outputCount: 15, latencyMs: 0 },
          { stage: 'primary_rank', inputCount: 15, outputCount: 15, latencyMs: 5 },
          { stage: 'precision_rerank', inputCount: 15, outputCount: 15, latencyMs: 0 },
          { stage: 'policy_apply', inputCount: 15, outputCount: 15, latencyMs: 0 },
        ],
      });
      const metrics = computeFunnelMetrics(trace, [makeResult('e1', 0.5)]);
      expect(metrics.coarsePrunePassRate).toBeCloseTo(15 / 20);
    });

    it('returns 1.0 when coarse_prune stage has inputCount = 0', () => {
      const trace = makeTrace({
        stages: [
          { stage: 'coarse_prune', inputCount: 0, outputCount: 0, latencyMs: 0 },
          { stage: 'primary_rank', inputCount: 0, outputCount: 0, latencyMs: 0 },
          { stage: 'precision_rerank', inputCount: 0, outputCount: 0, latencyMs: 0 },
          { stage: 'policy_apply', inputCount: 0, outputCount: 0, latencyMs: 0 },
        ],
      });
      const metrics = computeFunnelMetrics(trace, []);
      expect(metrics.coarsePrunePassRate).toBe(1.0);
    });

    it('returns 1.0 when no coarse_prune stage is present in trace', () => {
      const trace = makeTrace({
        stages: [
          { stage: 'primary_rank', inputCount: 10, outputCount: 10, latencyMs: 5 },
        ],
      });
      const metrics = computeFunnelMetrics(trace, [makeResult('e1', 0.5)]);
      expect(metrics.coarsePrunePassRate).toBe(1.0);
    });
  });

  describe('producerDiversity', () => {
    it('counts unique non-empty producers', () => {
      const trace = makeTrace();
      const results = [
        makeResult('e1', 0.9, 'Petrus'),
        makeResult('e2', 0.8, 'Petrus'), // duplicate
        makeResult('e3', 0.7, 'DRC'),
        makeResult('e4', 0.6, ''),      // empty string — excluded
        makeResult('e5', 0.5),          // no producer — excluded
        makeResult('e6', 0.4, '   '),   // whitespace only — excluded
      ];
      const metrics = computeFunnelMetrics(trace, results);
      expect(metrics.producerDiversity).toBe(2); // Petrus, DRC
    });

    it('returns 0 when no results have producers', () => {
      const trace = makeTrace();
      const results = [makeResult('e1', 0.9), makeResult('e2', 0.7)];
      const metrics = computeFunnelMetrics(trace, results);
      expect(metrics.producerDiversity).toBe(0);
    });
  });

  describe('scoreGapRank1Rank2', () => {
    it('is the difference between rank-1 and rank-2 final scores', () => {
      const trace = makeTrace();
      const results = [makeResult('e1', 0.95), makeResult('e2', 0.60)];
      const metrics = computeFunnelMetrics(trace, results);
      expect(metrics.scoreGapRank1Rank2).toBeCloseTo(0.35);
    });

    it('is null for empty results', () => {
      const metrics = computeFunnelMetrics(makeTrace(), []);
      expect(metrics.scoreGapRank1Rank2).toBeNull();
    });

    it('is null for single result', () => {
      const metrics = computeFunnelMetrics(makeTrace(), [makeResult('e1', 0.9)]);
      expect(metrics.scoreGapRank1Rank2).toBeNull();
    });

    it('is 0 when rank-1 and rank-2 have equal scores', () => {
      const trace = makeTrace();
      const results = [makeResult('e1', 0.7), makeResult('e2', 0.7)];
      const metrics = computeFunnelMetrics(trace, results);
      expect(metrics.scoreGapRank1Rank2).toBeCloseTo(0);
    });
  });
});
