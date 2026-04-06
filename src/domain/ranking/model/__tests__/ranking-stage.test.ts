import { describe, it, expect } from 'vitest';
import { RANKING_STAGES } from '../ranking-stage.js';
import type { RankingFunnelTrace, RankingStageTrace } from '../ranking-stage.js';

describe('RankingStage vocabulary (T5.1)', () => {
  it('contains all four stages', () => {
    expect(RANKING_STAGES).toEqual([
      'coarse_prune',
      'primary_rank',
      'precision_rerank',
      'policy_apply',
    ]);
  });

  it('RankingStageTrace is structurally valid', () => {
    const trace: RankingStageTrace = {
      stage: 'primary_rank',
      inputCount: 100,
      outputCount: 85,
      latencyMs: 12,
      notes: { rerankIncluded: false },
    };
    expect(trace.stage).toBe('primary_rank');
    expect(trace.inputCount).toBe(100);
    expect(trace.outputCount).toBe(85);
  });

  it('RankingFunnelTrace correctly models funnel execution', () => {
    const funnel: RankingFunnelTrace = {
      stages: [
        { stage: 'coarse_prune', inputCount: 200, outputCount: 180, latencyMs: 1 },
        { stage: 'primary_rank', inputCount: 180, outputCount: 180, latencyMs: 20 },
        { stage: 'precision_rerank', inputCount: 20, outputCount: 20, latencyMs: 50 },
        { stage: 'policy_apply', inputCount: 180, outputCount: 180, latencyMs: 0 },
      ],
      totalLatencyMs: 71,
      precisionRerankExecuted: true,
      policyApplied: false,
    };
    expect(funnel.stages).toHaveLength(4);
    expect(funnel.precisionRerankExecuted).toBe(true);
    expect(funnel.policyApplied).toBe(false);
    expect(funnel.totalLatencyMs).toBe(71);
  });
});
