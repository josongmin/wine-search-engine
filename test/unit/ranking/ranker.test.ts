import { describe, it, expect, vi } from 'vitest';
import { Ranker } from '../../../src/domain/ranking/service/ranker.js';
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid ComponentScores; all gates pass, all signals neutral. */
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

/** Minimal HybridCandidate. */
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

/** Minimal valid QueryPlanV1. */
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

/** Minimal valid ConstraintBundle. */
function makeConstraints(): ConstraintBundle {
  return { hard: [], soft: [], inferred: [] };
}

/** Minimal RankingInput for N candidates. */
function makeInput(candidates: HybridCandidate[], rerankForced?: boolean): RankingInput {
  return {
    queryPlan: makeQueryPlan(),
    candidates,
    constraints: makeConstraints(),
    ...(rerankForced !== undefined ? { rerankForced } : {}),
  };
}

/** A simple evidence item stub. */
const STUB_EVIDENCE: EvidenceItem = {
  type: 'semantic_relevance',
  source: 'ranking_signal_computer',
  contribution: '+0.50',
  strength: 'medium',
  provenance: 'Stub evidence',
};

// ── Stub factories ────────────────────────────────────────────────────────────

/**
 * Creates a stub SignalComputer whose computeAll() returns the given
 * ComponentScores for every candidate.
 */
function makeSignalComputer(scores: ComponentScores): SignalComputer {
  return {
    computeAll: vi.fn().mockReturnValue(scores),
  } as unknown as SignalComputer;
}

/**
 * Creates a stub ScoreAggregator whose aggregate() always returns the
 * given finalScore (or -Infinity when scores.hardConstraintPass is false).
 */
function makeScoreAggregator(finalScore: number): ScoreAggregator {
  return {
    aggregate: vi.fn().mockReturnValue(finalScore),
  } as unknown as ScoreAggregator;
}

/**
 * Creates a stub ScoreAggregator that returns scores from a provided list
 * in call order.
 */
function makeScoreAggregatorSequence(scores: number[]): ScoreAggregator {
  const mock = vi.fn();
  scores.forEach((s) => mock.mockReturnValueOnce(s));
  return { aggregate: mock } as unknown as ScoreAggregator;
}

/**
 * Creates a stub EvidenceMapper that always returns the given evidenceItems.
 */
function makeEvidenceMapper(evidenceItems: EvidenceItem[] = [STUB_EVIDENCE]): EvidenceMapper {
  return {
    mapToEvidence: vi.fn().mockReturnValue(evidenceItems),
  } as unknown as EvidenceMapper;
}

/**
 * Creates a stub RerankerPort whose rerank() resolves to the given results.
 * Returns both the port and a direct reference to the underlying spy so
 * tests can assert on the spy without triggering unbound-method lint errors.
 */
function makeReranker(results: RerankResult[]): {
  port: RerankerPort;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn().mockResolvedValue(results);
  return { port: { rerank: spy }, spy };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Ranker', () => {
  describe('empty and single-candidate cases', () => {
    it('empty candidates → returns []', async () => {
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.9),
        makeEvidenceMapper(),
      );

      const results = await ranker.rank(makeInput([]));

      expect(results).toEqual([]);
    });

    it('single candidate with finalScore=0.9 → rank=1, evidenceItems populated', async () => {
      const candidate = makeCandidate('wine-001');
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.9),
        makeEvidenceMapper([STUB_EVIDENCE]),
      );

      const results = await ranker.rank(makeInput([candidate]));

      expect(results).toHaveLength(1);
      expect(results[0]!.rank).toBe(1);
      expect(results[0]!.finalScore).toBe(0.9);
      expect(results[0]!.evidenceItems).toEqual([STUB_EVIDENCE]);
      expect(results[0]!.matchedConstraints).toEqual([]);
      expect(results[0]!.unmetConstraints).toEqual([]);
      expect(results[0]!.inferredConstraints).toEqual([]);
    });
  });

  describe('sorting', () => {
    it('three candidates with scores 0.9, 0.7, 0.5 → returned in descending order', async () => {
      const candidates = [
        makeCandidate('wine-001'),
        makeCandidate('wine-002'),
        makeCandidate('wine-003'),
      ];

      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregatorSequence([0.9, 0.7, 0.5]),
        makeEvidenceMapper(),
      );

      const results = await ranker.rank(makeInput(candidates));

      expect(results).toHaveLength(3);
      expect(results[0]!.finalScore).toBe(0.9);
      expect(results[1]!.finalScore).toBe(0.7);
      expect(results[2]!.finalScore).toBe(0.5);
    });

    it('rank is 1-indexed: first result has rank=1', async () => {
      const candidates = [makeCandidate('wine-001'), makeCandidate('wine-002')];

      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregatorSequence([0.9, 0.5]),
        makeEvidenceMapper(),
      );

      const results = await ranker.rank(makeInput(candidates));

      expect(results[0]!.rank).toBe(1);
      expect(results[1]!.rank).toBe(2);
    });
  });

  describe('constraint evidence propagation', () => {
    it('carries matched/unmet/inferred constraint state into ranked results', async () => {
      const candidate = {
        ...makeCandidate('wine-001'),
        matchedConstraints: ['country', 'price_band'],
        unmetHardConstraints: ['wine_type'],
      };
      const sharedConstraints: ConstraintBundle = {
        hard: [
          {
            attribute: 'wine_type',
            operator: '=',
            value: 'red',
            source_phrase: 'red',
            confidence: 1,
          },
        ],
        soft: [
          {
            attribute: 'country',
            operator: '=',
            value: 'France',
            source_phrase: 'france',
            confidence: 0.8,
          },
          {
            attribute: 'price_band',
            operator: '=',
            value: 'premium',
            source_phrase: 'premium',
            confidence: 0.7,
          },
        ],
        inferred: [
          {
            attribute: 'appellation',
            operator: '=',
            value: 'Bordeaux',
            source_phrase: 'bordeaux',
            confidence: 0.6,
          },
        ],
      };

      const input: RankingInput = {
        queryPlan: {
          ...makeQueryPlan(),
          constraints: sharedConstraints,
        },
        candidates: [candidate],
        constraints: sharedConstraints,
      };

      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.9),
        makeEvidenceMapper([STUB_EVIDENCE]),
      );

      const [result] = await ranker.rank(input);

      expect(result?.matchedConstraints).toEqual(['country', 'price_band']);
      expect(result?.unmetConstraints).toEqual(['wine_type', 'appellation']);
      expect(result?.inferredConstraints).toEqual(['appellation']);
    });
  });

  describe('-Infinity filtering', () => {
    it('all -Infinity scores → returns []', async () => {
      const candidates = [makeCandidate('wine-001'), makeCandidate('wine-002')];

      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores({ hardConstraintPass: false })),
        makeScoreAggregatorSequence([-Infinity, -Infinity]),
        makeEvidenceMapper(),
      );

      const results = await ranker.rank(makeInput(candidates));

      expect(results).toEqual([]);
    });

    it('mixed: 2 finite (0.9, 0.5) + 1 -Infinity → returns only 2 results', async () => {
      const candidates = [
        makeCandidate('wine-001'),
        makeCandidate('wine-002'),
        makeCandidate('wine-003'),
      ];

      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregatorSequence([0.9, -Infinity, 0.5]),
        makeEvidenceMapper(),
      );

      const results = await ranker.rank(makeInput(candidates));

      expect(results).toHaveLength(2);
      expect(results.every((r) => Number.isFinite(r.finalScore))).toBe(true);
    });
  });

  describe('reranking threshold', () => {
    it('reranker provided + 6 candidates + rerankForced → reranker.rerank() is called', async () => {
      const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-00${i}`));

      // rerankForced bypasses the gate regardless of candidate count
      const rerankResults: RerankResult[] = candidates.map((c, i) => ({
        entityId: c.entityId,
        score: 0.9 - i * 0.05,
        rank: i + 1,
      }));

      const { port, spy } = makeReranker(rerankResults);
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.5),
        makeEvidenceMapper(),
        { reranker: port },
      );

      await ranker.rank(makeInput(candidates, true));

      expect(spy).toHaveBeenCalledOnce();
    });

    it('reranker receives rich passage when candidate has producer/region/searchTextEn/grapePrimary', async () => {
      const rich: HybridCandidate = {
        ...makeCandidate('wine-rich'),
        canonicalLabel: 'Brunello 2013',
        producer: 'Poggio Salvi',
        region: 'Montalcino',
        searchTextEn: 'Structured red with cherry notes.',
        grapePrimary: 'Sangiovese',
      };
      const filler = Array.from({ length: 5 }, (_, i) => makeCandidate(`wine-fill-${i}`));
      const candidates = [rich, ...filler];

      const rerankResults: RerankResult[] = candidates.map((c, i) => ({
        entityId: c.entityId,
        score: 0.9 - i * 0.05,
        rank: i + 1,
      }));

      const { port, spy } = makeReranker(rerankResults);
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.85),
        makeEvidenceMapper(),
        { reranker: port },
      );

      // rerankForced bypasses the gate for this passage-building test
      await ranker.rank(makeInput(candidates, true));

      expect(spy).toHaveBeenCalledOnce();
      const rerankCandidates = spy.mock.calls[0]![1] as readonly RerankCandidate[];
      const topText = rerankCandidates[0]?.text ?? '';
      expect(topText).toContain('Brunello 2013');
      expect(topText).toContain('Poggio Salvi');
      expect(topText).toContain('Montalcino');
      expect(topText).toContain('cherry');
      expect(topText).toContain('Sangiovese');
    });

    it('reranker provided + 4 candidates (≤ RERANK_THRESHOLD) → reranker.rerank() NOT called', async () => {
      const candidates = Array.from({ length: 4 }, (_, i) => makeCandidate(`wine-00${i}`));

      const { port, spy } = makeReranker([]);
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregator(0.5),
        makeEvidenceMapper(),
        { reranker: port },
      );

      await ranker.rank(makeInput(candidates));

      expect(spy).not.toHaveBeenCalled();
    });

    it('no reranker provided + 10 candidates → rerank never called', async () => {
      const candidates = Array.from({ length: 10 }, (_, i) => makeCandidate(`wine-0${i}`));

      // No reranker passed — just verify the pipeline completes without error
      const signalComputer = makeSignalComputer(makeComponentScores());
      const ranker = new Ranker(
        signalComputer,
        makeScoreAggregator(0.5),
        makeEvidenceMapper(),
        // reranker intentionally omitted
      );

      const results = await ranker.rank(makeInput(candidates));

      expect(results).toHaveLength(10);
    });
  });

  describe('score blending', () => {
    it('originalScore=0.8, rerankerScore=0.6 → min-max norm + semantic_preference blend (w=0.18)', async () => {
      // Use rerankForced to trigger reranking regardless of gate conditions
      const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-0${i}`));

      // Give the first candidate originalScore=0.8, others lower so first stays first
      const aggregatorScores = [0.8, 0.6, 0.6, 0.6, 0.6, 0.6];
      const firstEntityId = candidates[0]!.entityId;

      const rerankResults: RerankResult[] = candidates.map((c, i) => ({
        entityId: c.entityId,
        // first candidate gets rerankerScore=0.6, others slightly lower
        score: i === 0 ? 0.6 : 0.1,
        rank: i + 1,
      }));

      const { port } = makeReranker(rerankResults);
      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregatorSequence(aggregatorScores),
        makeEvidenceMapper(),
        { reranker: port },
      );

      const results = await ranker.rank(makeInput(candidates, true));

      // Find result for first candidate
      const firstResult = results.find((r) => r.entityId === firstEntityId);
      expect(firstResult).toBeDefined();
      // Rerank scores [0.6, 0.1, …] → norm(first)=1.0; w=0.18 (default blend scale 1)
      // blended = 0.18 * 1.0 + 0.82 * 0.8 = 0.836
      expect(firstResult!.finalScore).toBeCloseTo(0.836, 10);
    });
  });

  describe('rerankTopK', () => {
    it('rerankTopK=3 with 8 candidates: top-3 sent to reranker, remaining 5 appended', async () => {
      const candidates = Array.from({ length: 8 }, (_, i) => makeCandidate(`wine-0${i}`));

      // All viable, sorted so top-3 by score are candidates 0,1,2
      const aggregatorScores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2];

      // Reranker returns results for the 3 candidates it receives
      const rerankSpy = vi.fn().mockImplementation(
        (_query: string, rerankCandidates: readonly RerankCandidate[]) =>
          Promise.resolve(
            rerankCandidates.map((c, i) => ({
              entityId: c.entityId,
              score: 1.0 - i * 0.1,
              rank: i + 1,
            })),
          ),
      );
      const reranker: RerankerPort = { rerank: rerankSpy };

      const ranker = new Ranker(
        makeSignalComputer(makeComponentScores()),
        makeScoreAggregatorSequence(aggregatorScores),
        makeEvidenceMapper(),
        { reranker, rerankTopK: 3 },
      );

      const results = await ranker.rank(makeInput(candidates, true));

      // Reranker should have been called with exactly 3 candidates
      expect(rerankSpy).toHaveBeenCalledOnce();
      const callArgs = rerankSpy.mock.calls[0] as [string, readonly RerankCandidate[], number];
      expect(callArgs[1]).toHaveLength(3);

      // Total results = 8
      expect(results).toHaveLength(8);
    });

    it('after reranking, results are re-sorted by blended score descending', async () => {
      // Use rerankForced to trigger reranking with a small set
      const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-0${i}`));

      // Original scores (sorted: [0.9, 0.8, 0.7, 0.6, 0.5, 0.4])
      const aggregatorScores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];

      // Reranker inverts the top-K order (candidates 0..5 all in top-K with default=20)
      const reranker: RerankerPort = {
        rerank: (_query, rerankCandidates) =>
          Promise.resolve(
            [...rerankCandidates].reverse().map((c, i) => ({
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

      const results = await ranker.rank(makeInput(candidates, true));

      // Verify results are sorted descending by blended score
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.finalScore).toBeGreaterThanOrEqual(results[i + 1]!.finalScore);
      }
    });
  });
});
