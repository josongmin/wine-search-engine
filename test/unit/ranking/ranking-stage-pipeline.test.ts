import { describe, it, expect, vi } from 'vitest';
import { Ranker } from '../../../src/domain/ranking/service/ranker.js';
import { RankingStagePipeline } from '../../../src/domain/ranking/service/ranking-stage-pipeline.js';
import type { SignalComputer } from '../../../src/domain/ranking/service/signal-computer.js';
import type { ScoreAggregator } from '../../../src/domain/ranking/service/score-aggregator.js';
import type { EvidenceMapper } from '../../../src/domain/ranking/service/evidence-mapper.js';
import type { RerankerPort, RerankCandidate, RerankResult } from '../../../src/domain/ranking/port/reranker.port.js';
import type { RankingInput } from '../../../src/domain/ranking/model/ranking-input.js';
import type { ComponentScores } from '../../../src/domain/ranking/model/ranked-result.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { QueryPlanV1 } from '../../../src/domain/query/model/query-plan.js';
import type { ConstraintBundle, EvidenceItem } from '../../../src/domain/shared/types/index.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import { RANKING_STAGES } from '../../../src/domain/ranking/model/ranking-stage.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeComponentScores(overrides?: Partial<ComponentScores>): ComponentScores {
  return {
    entityIntegrity: 0.8,
    semantic: 0.5,
    hardConstraintPass: true,
    softConstraint: 0.5,
    attributeAlignment: 0.5,
    preferenceAlignment: 0.5,
    popularity: 0.3,
    availability: 1.0,
    uncertaintyPenalty: 0.1,
    ...overrides,
  };
}

function makeCandidate(id: string): HybridCandidate {
  return {
    entityId: createEntityId(id),
    retrievalFusionScore: 0.5,
    matchedConstraints: [],
    unmetHardConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'default',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [],
    },
  } as unknown as HybridCandidate;
}

function makeQueryPlan(): QueryPlanV1 {
  return {
    rawQuery: 'test wine',
    normalizedQuery: 'test wine',
    intent: 'entity_exact',
    route: 'hybrid',
    queryClass: 'semantic_preference',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      fallbackMode: 'hybrid',
      policyReasonCodes: [],
    },
    uncertainty: { overall: 0.1, ambiguityDetected: false, ambiguitySeverity: 'low' },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default-v1',
  } as unknown as QueryPlanV1;
}

function makeConstraints(): ConstraintBundle {
  return { hard: [], soft: [], inferred: [] };
}

function makeInput(candidates: HybridCandidate[], rerankForced?: boolean): RankingInput {
  return {
    queryPlan: makeQueryPlan(),
    candidates,
    constraints: makeConstraints(),
    ...(rerankForced !== undefined ? { rerankForced } : {}),
  };
}

const STUB_EVIDENCE: EvidenceItem = {
  type: 'semantic_relevance',
  source: 'ranking_signal_computer',
  contribution: '+0.50',
  strength: 'medium',
  provenance: 'Stub evidence',
};

function makeSignalComputer(scores: ComponentScores): SignalComputer {
  return {
    computeAll: vi.fn().mockReturnValue(scores),
  } as unknown as SignalComputer;
}

function makeScoreAggregator(finalScore: number): ScoreAggregator {
  return {
    aggregate: vi.fn().mockReturnValue(finalScore),
  } as unknown as ScoreAggregator;
}

function makeScoreAggregatorSequence(scores: number[]): ScoreAggregator {
  const mock = vi.fn();
  scores.forEach((s) => mock.mockReturnValueOnce(s));
  return { aggregate: mock } as unknown as ScoreAggregator;
}

function makeEvidenceMapper(evidenceItems: EvidenceItem[] = [STUB_EVIDENCE]): EvidenceMapper {
  return {
    mapToEvidence: vi.fn().mockReturnValue(evidenceItems),
  } as unknown as EvidenceMapper;
}

function makeReranker(results: RerankResult[]): {
  port: RerankerPort;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(results);
  return { port: { rerank: spy }, spy };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RankingStagePipeline (T5.1)', () => {
  describe('funnel trace always has all 4 stages', () => {
    it('returns exactly 4 stages in the correct order', async () => {
      const candidates = Array.from({ length: 3 }, (_, i) => makeCandidate(`wine-0${i}`));
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.7),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates));

      expect(funnelTrace.stages).toHaveLength(4);
      expect(funnelTrace.stages.map((s) => s.stage)).toEqual(RANKING_STAGES);
    });

    it('emits all 4 stages even when no reranker is configured', async () => {
      const candidates = [makeCandidate('wine-001')];
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.9),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates));

      const stageNames = funnelTrace.stages.map((s) => s.stage);
      expect(stageNames).toContain('coarse_prune');
      expect(stageNames).toContain('primary_rank');
      expect(stageNames).toContain('precision_rerank');
      expect(stageNames).toContain('policy_apply');
    });
  });

  describe('stage inputCount/outputCount', () => {
    it('coarse_prune outputCount equals retained count when some are pruned', async () => {
      // 3 candidates: 2 viable (0.9, 0.7), 1 pruned (-Infinity)
      const candidates = Array.from({ length: 3 }, (_, i) => makeCandidate(`wine-0${i}`));
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregatorSequence([0.9, 0.7, -Infinity]),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace, results } = await pipeline.rank(makeInput(candidates));

      const pruneStage = funnelTrace.stages.find((s) => s.stage === 'coarse_prune');
      expect(pruneStage).toBeDefined();
      expect(pruneStage!.inputCount).toBe(3);
      expect(pruneStage!.outputCount).toBe(2);
      expect(results).toHaveLength(2);
    });

    it('primary_rank inputCount equals retained count after prune', async () => {
      const candidates = Array.from({ length: 4 }, (_, i) => makeCandidate(`wine-0${i}`));
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregatorSequence([0.9, 0.8, -Infinity, -Infinity]),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates));

      const primaryStage = funnelTrace.stages.find((s) => s.stage === 'primary_rank');
      expect(primaryStage).toBeDefined();
      expect(primaryStage!.inputCount).toBe(2);
      expect(primaryStage!.outputCount).toBe(2);
    });

    it('all stages have non-negative latencyMs', async () => {
      const candidates = [makeCandidate('wine-001'), makeCandidate('wine-002')];
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.5),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates));

      for (const stage of funnelTrace.stages) {
        expect(stage.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('precisionRerankExecuted flag', () => {
    it('is false when no reranker is configured', async () => {
      const candidates = Array.from({ length: 3 }, (_, i) => makeCandidate(`wine-0${i}`));
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.5),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates));

      expect(funnelTrace.precisionRerankExecuted).toBe(false);
    });

    it('is false when candidate count is at or below the rerank threshold', async () => {
      // rerankThreshold default is 5; 4 candidates should not trigger reranking
      const candidates = Array.from({ length: 4 }, (_, i) => makeCandidate(`wine-0${i}`));
      const { port } = makeReranker([]);
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.5),
        makeEvidenceMapper(),
        { reranker: port },
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates));

      expect(funnelTrace.precisionRerankExecuted).toBe(false);
    });

    it('is true when reranker is configured and rerankForced is set', async () => {
      // T5.4: gate controls reranking; use rerankForced to bypass gate
      const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-0${i}`));
      const rerankResults: RerankResult[] = candidates.map((c, i) => ({
        entityId: c.entityId,
        score: 0.9 - i * 0.05,
        rank: i + 1,
      }));
      const { port } = makeReranker(rerankResults);
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.5),
        makeEvidenceMapper(),
        { reranker: port },
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates, true));

      expect(funnelTrace.precisionRerankExecuted).toBe(true);
    });

    it('is true even when reranking preserves descending score order', async () => {
      // This tests that we do NOT use the flawed score-order heuristic.
      // The reranker returns the same order as input → scores remain descending,
      // but reranking still executed so the flag must be true.
      // T5.4: use rerankForced to bypass gate for this small candidate set.
      const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-0${i}`));
      const aggregatorScores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

      const reranker: RerankerPort = {
        rerank: (_query, rerankCandidates: readonly RerankCandidate[]) =>
          Promise.resolve(
            rerankCandidates.map((c, i) => ({
              entityId: c.entityId,
              score: 1.0 - i * 0.1,
              rank: i + 1,
            })),
          ),
      };

      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregatorSequence(aggregatorScores),
        makeEvidenceMapper(),
        { reranker },
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates, true));

      expect(funnelTrace.precisionRerankExecuted).toBe(true);
    });
  });

  describe('RankingFunnelResult contract', () => {
    it('returns both results and funnelTrace', async () => {
      const candidates = [makeCandidate('wine-001')];
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.9),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const output = await pipeline.rank(makeInput(candidates));

      expect(output.results).toBeDefined();
      expect(output.funnelTrace).toBeDefined();
      expect(Array.isArray(output.results)).toBe(true);
    });

    it('totalLatencyMs is non-negative', async () => {
      const candidates = [makeCandidate('wine-001')];
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.9),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates));

      expect(funnelTrace.totalLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('policyApplied is false (identity seam)', async () => {
      const candidates = [makeCandidate('wine-001')];
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.9),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { funnelTrace } = await pipeline.rank(makeInput(candidates));

      expect(funnelTrace.policyApplied).toBe(false);
    });
  });

  describe('coarsePruneMeta on retained candidates (T5.2)', () => {
    it('every result has coarsePruneMeta set', async () => {
      const candidates = [makeCandidate('wine-001'), makeCandidate('wine-002')];
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.7),
        makeEvidenceMapper(),
      );
      const pipeline = new RankingStagePipeline(ranker);

      const { results } = await pipeline.rank(makeInput(candidates));

      for (const result of results) {
        expect(result.coarsePruneMeta).toBeDefined();
        expect(result.coarsePruneMeta!.hardConstraintPassed).toBe(true);
        expect(result.coarsePruneMeta!.entityIntegrityPassed).toBe(true);
        expect(typeof result.coarsePruneMeta!.preGateScore).toBe('number');
      }
    });
  });
});
