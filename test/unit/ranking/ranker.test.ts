import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Ranker } from '../../../src/domain/ranking/service/ranker.js';
import type { SignalComputer } from '../../../src/domain/ranking/service/signal-computer.js';
import type { ScoreAggregator } from '../../../src/domain/ranking/service/score-aggregator.js';
import type { EvidenceMapper } from '../../../src/domain/ranking/service/evidence-mapper.js';
import type { RerankerPort, RerankCandidate, RerankResult } from '../../../src/domain/ranking/port/reranker.port.js';
import type { RankingInput } from '../../../src/domain/ranking/model/ranking-input.js';
import type { ComponentScores } from '../../../src/domain/ranking/model/ranked-result.js';
import type { HybridCandidate } from '../../../src/domain/retrieval/model/hybrid-candidate.js';
import type { QueryPlanV1 } from '../../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../../src/domain/query/model/compiled-wine-query.js';
import type { ConstraintBundle, EvidenceItem, NormalizedConstraint } from '../../../src/domain/shared/types/index.js';
import {
  LAMBDAMART_FEATURE_DIMENSION,
  LAMBDAMART_FEATURE_NAMES,
  LTR_FEATURE_SCHEMA_HASH,
  type QueryClassWeights,
} from '../../../src/domain/ranking/service/lambdamart-ranker.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import {
  resolveChannelAwareWeights,
  resolveWeights,
  applySituationIntentWeightOverlay,
} from '../../../src/domain/ranking/model/scoring-weights.js';
import { applyModeWeightOverlay, getModeWeights } from '../../../src/domain/ranking/model/mode-weights.js';
import { globalSilentSkipCounter } from '../../../src/domain/observability/silent-skip-counters.js';
import { createStageTimer } from '../../../src/domain/shared/stage-timer.js';
import { makeHybridCandidate } from '../../support/hybrid-candidate-test-factory.js';

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
  return makeHybridCandidate({
    entityId: createEntityId(id),
    fusionRrfTotal: 0.5,
    unmetHardConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'default',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [],
    },
  });
}

function makeCandidateWithOverrides(
  id: string,
  overrides: Partial<HybridCandidate> = {},
): HybridCandidate {
  return {
    ...makeCandidate(id),
    ...overrides,
  };
}

function makeCandidates(count: number, prefix = 'wine'): HybridCandidate[] {
  return Array.from({ length: count }, (_, i) => makeCandidate(`${prefix}-${i}`));
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
      requireClarification: false, clarificationBias: 0,
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

function makeConstraint(
  attribute: string,
  value: NormalizedConstraint['value'],
): NormalizedConstraint {
  return {
    attribute,
    operator: Array.isArray(value) ? 'in' : '=',
    value,
    source_phrase: `${attribute}:${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
    confidence: 1,
  };
}

function makeConstraintsWithSoftEntries(entries: readonly NormalizedConstraint[]): ConstraintBundle {
  return { hard: [], soft: [...entries], inferred: [] };
}

/** Minimal CompiledWineQuery for test helpers. */
function makeCompiled(plan?: QueryPlanV1): CompiledWineQuery {
  const p = plan ?? makeQueryPlan();
  return {
    query: {
      rawQuery: p.rawQuery,
      normalizedQuery: p.normalizedQuery,
      intent: p.intent,
      queryClass: p.queryClass,
      anchors: p.anchors,
      constraints: p.constraints,
      expansions: { lexical: [], semantic: [] },
      uncertainty: p.uncertainty,
      plannerVersion: p.plannerVersion,
      policyRuleVersion: p.policyRuleVersion,
      thresholdProfileId: p.thresholdProfileId,
      retrievalPlan: { hardFilterTokens: [], softBoosts: [], inferredBoosts: [], sensoryPriors: [], planVersion: 'retrieval-plan-v1.0' },
    },
    execution: {
      effectiveRoute: p.route,
      effectiveRetrievalMode: p.retrievalMode,
      routeSource: 'planner',
      budget: { maxCandidates: 20, rerankLimit: 20, enablePrecisionRerank: true },
      provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
    },
  };
}

/** Minimal RankingInput for N candidates. */
function makeInput(candidates: HybridCandidate[], rerankForced?: boolean): RankingInput {
  const plan = makeQueryPlan();
  return {
    queryPlan: plan,
    candidates,
    constraints: makeConstraints(),
    compiled: makeCompiled(plan),
    ...(rerankForced !== undefined ? { rerankForced } : {}),
  };
}

function makeInputWithOverrides(
  candidates: HybridCandidate[],
  overrides: Partial<RankingInput> & { queryPlan?: Partial<QueryPlanV1> } = {},
): RankingInput {
  const plan = {
    ...makeQueryPlan(),
    ...overrides.queryPlan,
  } as QueryPlanV1;
  return {
    queryPlan: plan,
    candidates,
    constraints: overrides.constraints ?? makeConstraints(),
    compiled: overrides.compiled ?? makeCompiled(plan),
    ...(overrides.anchorProfile !== undefined ? { anchorProfile: overrides.anchorProfile } : {}),
    ...(overrides.rerankForced !== undefined ? { rerankForced: overrides.rerankForced } : {}),
    ...(overrides.requestContext !== undefined ? { requestContext: overrides.requestContext } : {}),
  };
}

function resolveExpectedRankerWeights(input: RankingInput, channels: readonly string[]) {
  const baseWeights = resolveWeights(input.queryPlan.queryClass);
  const modeProfile = getModeWeights(input.queryPlan.retrievalMode);
  const overlaid = applyModeWeightOverlay(baseWeights, modeProfile, input.queryPlan.retrievalMode);
  const nonPenaltyKeys = [
    'entityIntegrity', 'anchorSimilarity', 'semantic', 'softConstraint',
    'attributeAlignment', 'preferenceAlignment', 'popularity', 'availability',
    'producerPrestige', 'recency', 'criticScore', 'multilingualScore',
    'giftSuitability', 'beginnerSuitability',
  ] as const;
  const baseSum = nonPenaltyKeys.reduce((s, k) => s + (baseWeights[k] ?? 0), 0);
  const overlaidSum = nonPenaltyKeys.reduce((s, k) => s + (overlaid[k] ?? 0), 0);
  const normFactor = overlaidSum > 0 && overlaidSum !== baseSum ? baseSum / overlaidSum : 1;
  const modeAdjusted = normFactor === 1 ? overlaid : {
    ...overlaid,
    entityIntegrity: overlaid.entityIntegrity * normFactor,
    anchorSimilarity: overlaid.anchorSimilarity * normFactor,
    semantic: overlaid.semantic * normFactor,
    softConstraint: overlaid.softConstraint * normFactor,
    attributeAlignment: overlaid.attributeAlignment * normFactor,
    preferenceAlignment: overlaid.preferenceAlignment * normFactor,
    popularity: overlaid.popularity * normFactor,
    availability: overlaid.availability * normFactor,
    producerPrestige: overlaid.producerPrestige * normFactor,
    recency: overlaid.recency * normFactor,
    criticScore: overlaid.criticScore * normFactor,
    multilingualScore: overlaid.multilingualScore * normFactor,
  };
  const situationAdjusted = applySituationIntentWeightOverlay(
    modeAdjusted,
    input.constraints,
    input.compiled.query.retrievalObjective,
  );
  return resolveChannelAwareWeights(channels, situationAdjusted);
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
    computeEntityPosterior: vi.fn((candidate: HybridCandidate) =>
      candidate.lanePresence === 'general_only' ? undefined : candidate.entityPosteriorScore,
    ),
    computeIdentityExactnessTier: vi.fn((candidate: HybridCandidate) =>
      candidate.lanePresence === 'general_only' ? 'none' : (candidate.identityExactnessTier ?? 'none'),
    ),
    computeLanePresence: vi.fn((candidate: HybridCandidate) => candidate.lanePresence),
  } as unknown as SignalComputer;
}

function makeSignalComputerByEntity(scoresByEntityId: Readonly<Record<string, ComponentScores>>): SignalComputer {
  return {
    computeAll: vi.fn((candidate: HybridCandidate) => {
      return scoresByEntityId[String(candidate.entityId)] ?? makeComponentScores();
    }),
    computeEntityPosterior: vi.fn((candidate: HybridCandidate) =>
      candidate.lanePresence === 'general_only' ? undefined : candidate.entityPosteriorScore,
    ),
    computeIdentityExactnessTier: vi.fn((candidate: HybridCandidate) =>
      candidate.lanePresence === 'general_only' ? 'none' : (candidate.identityExactnessTier ?? 'none'),
    ),
    computeLanePresence: vi.fn((candidate: HybridCandidate) => candidate.lanePresence),
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

function makeRanker(
  aggregator: ScoreAggregator,
  options: {
    signalScores?: ComponentScores;
    evidenceItems?: EvidenceItem[];
    reranker?: RerankerPort;
    rerankTopK?: number;
    ltrModels?: Map<string, QueryClassWeights>;
  } = {},
) {
  return new Ranker(
    makeSignalComputer(options.signalScores ?? makeComponentScores()),
    aggregator,
    makeEvidenceMapper(options.evidenceItems),
    options.reranker || options.rerankTopK !== undefined || options.ltrModels
      ? {
          ...(options.reranker ? { reranker: options.reranker } : {}),
          ...(options.rerankTopK !== undefined ? { rerankTopK: options.rerankTopK } : {}),
          ...(options.ltrModels ? { ltrModels: options.ltrModels } : {}),
        }
      : undefined,
  );
}

function makeLtrModel(
  weights: number[],
  overrides: Partial<QueryClassWeights> = {},
): QueryClassWeights {
  return {
    queryClass: 'semantic_preference',
    featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
    weights,
    bias: 0.5,
    trainingExampleCount: 10,
    ndcg5ValidationScore: 0.8,
    trainedAt: new Date(),
    ...overrides,
  };
}

function makeDescendingRerankResults(candidates: readonly HybridCandidate[]): RerankResult[] {
  return candidates.map((candidate, index) => ({
    entityId: candidate.entityId,
    score: 0.9 - index * 0.05,
    rank: index + 1,
  }));
}

function makeRichCandidate(id = 'wine-rich'): HybridCandidate {
  return {
    ...makeCandidate(id),
    canonicalLabel: 'Brunello 2013',
    producer: 'Poggio Salvi',
    region: 'Montalcino',
    searchTextEn: 'Structured red with cherry notes.',
    grapePrimary: 'Sangiovese',
  };
}

function makeUniformSemanticPreferenceLtrModel(): QueryClassWeights {
  return makeLtrModel(
    Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, () => 1 / LAMBDAMART_FEATURE_DIMENSION),
  );
}

function makeBm25DominantLtrModel(): QueryClassWeights {
  return makeLtrModel(
    Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, (_, index) => (index === 0 ? 1.0 : 0.0)),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Ranker', () => {
  beforeEach(() => {
    globalSilentSkipCounter.reset();
  });

  describe('empty and single-candidate cases', () => {
    it('empty candidates → returns []', async () => {
      const ranker = makeRanker(makeScoreAggregator(0.9));

      const { results } = await ranker.rank(makeInput([]));

      expect(results).toEqual([]);
    });

    it('single candidate with finalScore=0.9 → rank=1, evidenceItems populated', async () => {
      const candidate = makeCandidate('wine-001');
      const ranker = makeRanker(makeScoreAggregator(0.9), { evidenceItems: [STUB_EVIDENCE] });

      const { results } = await ranker.rank(makeInput([candidate]));

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
    it.each([
      [
        'three candidates with scores 0.9, 0.7, 0.5 → returned in descending order',
        [0.9, 0.7, 0.5],
        [0.9, 0.7, 0.5],
      ],
      [
        'rank is 1-indexed: first result has rank=1',
        [0.9, 0.5],
        [0.9, 0.5],
      ],
    ])('%s', async (_label, scores, expectedScores) => {
      const candidates = makeCandidates(scores.length, 'wine-00');
      const ranker = makeRanker(makeScoreAggregatorSequence(scores));

      const { results } = await ranker.rank(makeInput(candidates));

      expect(results).toHaveLength(expectedScores.length);
      expect(results.map((result) => result.finalScore)).toEqual(expectedScores);
      expect(results.map((result) => result.rank)).toEqual(
        Array.from({ length: expectedScores.length }, (_, index) => index + 1),
      );
    });

    it('tie results are stable across insertion order when all tie-break inputs match', async () => {
      const ranker = makeRanker(makeScoreAggregator(0.5));
      const candidatesA = [makeCandidate('wine-c'), makeCandidate('wine-a'), makeCandidate('wine-b')];
      const candidatesB = [makeCandidate('wine-b'), makeCandidate('wine-c'), makeCandidate('wine-a')];

      const { results: resultsA } = await ranker.rank(makeInput(candidatesA));
      const { results: resultsB } = await ranker.rank(makeInput(candidatesB));

      const expectedOrder = ['wine-a', 'wine-b', 'wine-c'];
      expect(resultsA.map((result) => String(result.entityId))).toEqual(expectedOrder);
      expect(resultsB.map((result) => String(result.entityId))).toEqual(expectedOrder);
    });

    it('prefers exact-known-item evidence over generic candidates when finalScore ties', async () => {
      const exact = makeCandidateWithOverrides('wine-exact', {
        retrievalProvenance: {
          channels: ['anchor_similarity'],
          channelScores: [],
          queryViewMatches: [{ viewName: 'strict', matchedText: 'opus one', channel: 'anchor_similarity' }],
          anchorConditioned: true,
          matchedFilterConstraints: [],
          protectedInclusionReason: 'exact_alias_match',
          fusionProfile: 'test',
          fusionScore: 0.1,
        },
        anchorRank: 2,
      });
      const generic = makeCandidateWithOverrides('wine-generic', {
        retrievalProvenance: {
          channels: ['dense_semantic'],
          channelScores: [],
          queryViewMatches: [],
          anchorConditioned: false,
          matchedFilterConstraints: [],
          fusionProfile: 'test',
          fusionScore: 0.1,
        },
        denseRank: 1,
      });
      const ranker = makeRanker(makeScoreAggregator(0.5));

      const { results } = await ranker.rank(makeInput([generic, exact]));

      expect(results.map((result) => String(result.entityId))).toEqual([
        'wine-exact',
        'wine-generic',
      ]);
    });

    it('orders lexical tiers as strict/compact > transliterated/phonetic_compact > vintage > none', async () => {
      const strict = makeCandidateWithOverrides('wine-strict', {
        retrievalProvenance: {
          channels: ['sparse_bm25'],
          channelScores: [],
          queryViewMatches: [{ viewName: 'compact', matchedText: 'opusone18', channel: 'sparse_bm25' }],
          anchorConditioned: false,
          matchedFilterConstraints: [],
          fusionProfile: 'test',
          fusionScore: 0.1,
        },
      });
      const transliterated = makeCandidateWithOverrides('wine-translit', {
        retrievalProvenance: {
          channels: ['sparse_bm25'],
          channelScores: [],
          queryViewMatches: [{ viewName: 'transliterated', matchedText: 'opus one', channel: 'sparse_bm25' }],
          anchorConditioned: false,
          matchedFilterConstraints: [],
          fusionProfile: 'test',
          fusionScore: 0.1,
        },
      });
      const vintage = makeCandidateWithOverrides('wine-vintage', {
        retrievalProvenance: {
          channels: ['sparse_bm25'],
          channelScores: [],
          queryViewMatches: [{ viewName: 'vintage_stripped', matchedText: 'opus one', channel: 'sparse_bm25' }],
          anchorConditioned: false,
          matchedFilterConstraints: [],
          fusionProfile: 'test',
          fusionScore: 0.1,
        },
      });
      const none = makeCandidateWithOverrides('wine-none', {
        retrievalProvenance: {
          channels: ['dense_semantic'],
          channelScores: [],
          queryViewMatches: [],
          anchorConditioned: false,
          matchedFilterConstraints: [],
          fusionProfile: 'test',
          fusionScore: 0.1,
        },
      });
      const ranker = makeRanker(makeScoreAggregator(0.5));

      const { results } = await ranker.rank(makeInput([none, vintage, transliterated, strict]));

      expect(results.map((result) => String(result.entityId))).toEqual([
        'wine-strict',
        'wine-translit',
        'wine-vintage',
        'wine-none',
      ]);
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

      const plan = {
        ...makeQueryPlan(),
        constraints: sharedConstraints,
      } as QueryPlanV1;
      const input: RankingInput = {
        queryPlan: plan,
        candidates: [candidate],
        constraints: sharedConstraints,
        compiled: makeCompiled(plan),
      };

      const ranker = makeRanker(makeScoreAggregator(0.9), { evidenceItems: [STUB_EVIDENCE] });

      const { results: [result] } = await ranker.rank(input);

      expect(result?.matchedConstraints).toEqual(['country', 'price_band']);
      expect(result?.unmetConstraints).toEqual(['wine_type', 'appellation']);
      expect(result?.inferredConstraints).toEqual(['appellation']);
    });

    it('does not surface descriptive compositional inferred priors as unmet constraints', async () => {
      const candidate = {
        ...makeCandidate('wine-002'),
        matchedConstraints: ['region', 'wine_type', 'body'],
        unmetHardConstraints: [],
      };
      const sharedConstraints: ConstraintBundle = {
        hard: [
          makeConstraint('region', 'Bordeaux'),
          makeConstraint('wine_type', 'red'),
        ],
        soft: [
          makeConstraint('body', 'full'),
        ],
        inferred: [
          {
            attribute: 'grape_family',
            operator: 'in',
            value: ['Cabernet', 'Merlot'],
            source_phrase: 'composition(bordeaux+red)',
            confidence: 0.6,
            inferred_binding: 'descriptive',
          },
        ],
      };

      const plan = {
        ...makeQueryPlan(),
        constraints: sharedConstraints,
      } as QueryPlanV1;
      const input: RankingInput = {
        queryPlan: plan,
        candidates: [candidate],
        constraints: sharedConstraints,
        compiled: makeCompiled(plan),
      };

      const ranker = makeRanker(makeScoreAggregator(0.9), { evidenceItems: [STUB_EVIDENCE] });
      const { results: [result] } = await ranker.rank(input);

      expect(result?.matchedConstraints).toEqual(['region', 'wine_type', 'body']);
      expect(result?.unmetConstraints).toEqual([]);
      expect(result?.inferredConstraints).toEqual([]);
    });
  });

  describe('channel-aware primary rank (T5.3)', () => {
    it('passes channel-adjusted weights into the score aggregator for learned sparse candidates', async () => {
      const candidate: HybridCandidate = {
        ...makeCandidate('wine-learned-sparse'),
        retrievalTrace: {
          retrievalProfile: 'default',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: ['learned_sparse'],
        },
      };
      const aggregate = vi.fn().mockReturnValue(0.8);
      const aggregator = { aggregate } as unknown as ScoreAggregator;
      const ranker = makeRanker(aggregator);

      const input = makeInput([candidate]);
      await ranker.rank(input);

      const passedWeights = aggregate.mock.calls[0]?.[1];
      expect(passedWeights).toEqual(
        resolveExpectedRankerWeights(input, ['learned_sparse']),
      );
    });

    it('uses different channel-aware weight profiles for sparse-only and relative-filter candidates', async () => {
      const sparseCandidate: HybridCandidate = {
        ...makeCandidate('wine-sparse'),
        retrievalTrace: {
          retrievalProfile: 'default',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: ['sparse_bm25'],
        },
      };
      const relativeCandidate: HybridCandidate = {
        ...makeCandidate('wine-relative'),
        retrievalTrace: {
          retrievalProfile: 'default',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: ['relative'],
          candidateSources: ['relative_filter'],
        },
      };
      const aggregate = vi.fn()
        .mockReturnValueOnce(0.7)
        .mockReturnValueOnce(0.6);
      const aggregator = { aggregate } as unknown as ScoreAggregator;
      const ranker = makeRanker(aggregator);

      const input = makeInput([sparseCandidate, relativeCandidate]);
      await ranker.rank(input);

      const sparseWeights = aggregate.mock.calls[0]?.[1];
      const relativeWeights = aggregate.mock.calls[1]?.[1];
      expect(sparseWeights).not.toEqual(relativeWeights);
      expect(sparseWeights).toEqual(
        resolveExpectedRankerWeights(input, ['sparse_bm25']),
      );
      expect(relativeWeights).toEqual(
        resolveExpectedRankerWeights(input, ['relative_filter']),
      );
    });

    it('activates situation learned facets only when explicit gift/beginner constraints are present', async () => {
      const candidate: HybridCandidate = {
        ...makeCandidate('wine-situation'),
        retrievalTrace: {
          retrievalProfile: 'default',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: [],
        },
      };
      const aggregate = vi.fn().mockReturnValue(0.8);
      const aggregator = { aggregate } as unknown as ScoreAggregator;
      const ranker = makeRanker(aggregator);
      const situationConstraints = makeConstraintsWithSoftEntries([
        makeConstraint('occasion', ['gift']),
        makeConstraint('style', ['approachable']),
      ]);
      const input = makeInputWithOverrides([candidate], {
        constraints: situationConstraints,
        queryPlan: {
          constraints: situationConstraints,
        },
      });

      await ranker.rank(input);

      const passedWeights = aggregate.mock.calls[0]?.[1];
      expect(passedWeights).toEqual(
        resolveExpectedRankerWeights(input, []),
      );
      expect(passedWeights.giftSuitability).toBeGreaterThan(0);
      expect(passedWeights.beginnerSuitability).toBeGreaterThan(0);
    });

    it('activates gift learned facet from explicit gift_suitability constraint', async () => {
      const candidate: HybridCandidate = {
        ...makeCandidate('wine-situation-suitability'),
        retrievalTrace: {
          retrievalProfile: 'default',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: [],
        },
      };
      const aggregate = vi.fn().mockReturnValue(0.8);
      const aggregator = { aggregate } as unknown as ScoreAggregator;
      const ranker = makeRanker(aggregator);
      const suitabilityConstraints = makeConstraintsWithSoftEntries([
        makeConstraint('gift_suitability', 0.72, '>='),
      ]);
      const input = makeInputWithOverrides([candidate], {
        constraints: suitabilityConstraints,
        queryPlan: {
          constraints: suitabilityConstraints,
        },
      });

      await ranker.rank(input);

      const passedWeights = aggregate.mock.calls[0]?.[1];
      expect(passedWeights.giftSuitability).toBeGreaterThan(0);
      expect(passedWeights.beginnerSuitability).toBe(0);
    });

    it('activates profile-aware situation weights from parents_first_time recipient profile', async () => {
      const candidate: HybridCandidate = {
        ...makeCandidate('wine-parents-profile'),
        retrievalTrace: {
          retrievalProfile: 'default',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: [],
        },
      };
      const aggregate = vi.fn().mockReturnValue(0.8);
      const aggregator = { aggregate } as unknown as ScoreAggregator;
      const ranker = makeRanker(aggregator);
      const constraints = makeConstraintsWithSoftEntries([
        makeConstraint('recipient_profile', 'parents_first_time'),
      ]);
      const input = makeInputWithOverrides([candidate], {
        constraints,
        queryPlan: { constraints },
      });

      await ranker.rank(input);

      const passedWeights = aggregate.mock.calls[0]?.[1];
      expect(passedWeights.softConstraint).toBeGreaterThan(0.1);
      expect(passedWeights.beginnerSuitability).toBeGreaterThan(0);
      expect(passedWeights.giftSuitability).toBe(0);
    });

    it('keeps situation learned facets off when the constraint bundle has no explicit trigger', async () => {
      const candidate: HybridCandidate = {
        ...makeCandidate('wine-situation-none'),
        retrievalTrace: {
          retrievalProfile: 'default',
          lexicalQueriesUsed: [],
          semanticQueriesUsed: [],
          filtersApplied: [],
          candidateSources: [],
        },
      };
      const aggregate = vi.fn().mockReturnValue(0.8);
      const aggregator = { aggregate } as unknown as ScoreAggregator;
      const ranker = makeRanker(aggregator);
      const input = makeInputWithOverrides([candidate], {
        constraints: makeConstraintsWithSoftEntries([
          makeConstraint('price_band', ['premium']),
        ]),
        queryPlan: {
          constraints: makeConstraintsWithSoftEntries([
            makeConstraint('price_band', ['premium']),
          ]),
        },
      });

      await ranker.rank(input);

      const passedWeights = aggregate.mock.calls[0]?.[1];
      expect(passedWeights).toEqual(
        resolveExpectedRankerWeights(input, []),
      );
      expect(passedWeights.giftSuitability).toBe(0);
      expect(passedWeights.beginnerSuitability).toBe(0);
    });
  });

  describe('-Infinity filtering', () => {
    it('all -Infinity scores → returns []', async () => {
      const candidates = makeCandidates(2, 'wine-00');

      const ranker = makeRanker(
        makeScoreAggregatorSequence([-Infinity, -Infinity]),
        { signalScores: makeComponentScores({ hardConstraintPass: false }) },
      );

      const { results } = await ranker.rank(makeInput(candidates));

      expect(results).toEqual([]);
    });

    it('mixed: 2 finite (0.9, 0.5) + 1 -Infinity → returns only 2 results', async () => {
      const candidates = makeCandidates(3, 'wine-00');

      const ranker = makeRanker(makeScoreAggregatorSequence([0.9, -Infinity, 0.5]));

      const { results } = await ranker.rank(makeInput(candidates));

      expect(results).toHaveLength(2);
      expect(results.every((r) => Number.isFinite(r.finalScore))).toBe(true);
    });
  });

  describe('reranking threshold', () => {
    it.each([
      [
        'reranker provided + 6 candidates + rerankForced → reranker.rerank() is called',
        { count: 6, rerankForced: true, expectsCall: true },
      ],
      [
        'reranker provided + 4 candidates (≤ RERANK_THRESHOLD) → reranker.rerank() NOT called',
        { count: 4, rerankForced: false, expectsCall: false },
      ],
    ])('%s', async (_label, scenario) => {
      const candidates = makeCandidates(scenario.count, 'wine-00');
      const { port, spy } = makeReranker(makeDescendingRerankResults(candidates));
      const ranker = makeRanker(makeScoreAggregator(0.5), { reranker: port });

      await ranker.rank(makeInput(candidates, scenario.rerankForced));

      if (scenario.expectsCall) {
        expect(spy).toHaveBeenCalledOnce();
      } else {
        expect(spy).not.toHaveBeenCalled();
      }
    });

    it('reranker receives rich passage when candidate has producer/region/searchTextEn/grapePrimary', async () => {
      const rich = makeRichCandidate();
      const filler = Array.from({ length: 5 }, (_, i) => makeCandidate(`wine-fill-${i}`));
      const candidates = [rich, ...filler];

      const { port, spy } = makeReranker(makeDescendingRerankResults(candidates));
      const ranker = makeRanker(makeScoreAggregator(0.85), { reranker: port });

      // rerankForced bypasses the gate for this passage-building test
      await ranker.rank(makeInput(candidates, true));

      expect(spy).toHaveBeenCalledOnce();
      const rerankCandidates = spy.mock.calls[0]![1] as readonly RerankCandidate[];
      // Find the rich candidate by content (sort order may vary due to tie-breaking)
      const richText = rerankCandidates.find((c) => c.text.includes('Brunello 2013'))?.text ?? '';
      expect(richText).toContain('Brunello 2013');
      expect(richText).toContain('Poggio Salvi');
      expect(richText).toContain('Montalcino');
      expect(richText).toContain('cherry');
      expect(richText).toContain('Sangiovese');
    });

    it('no reranker provided + 10 candidates → rerank never called', async () => {
      const candidates = makeCandidates(10, 'wine-0');

      // No reranker passed — just verify the pipeline completes without error
      const ranker = makeRanker(makeScoreAggregator(0.5));

      const { results } = await ranker.rank(makeInput(candidates));

      expect(results).toHaveLength(10);
    });

    it('uses has_anchor gate reason and executes reranking when anchor profile is present', async () => {
      const candidates = makeCandidates(6, 'wine-anchor');
      const { port, spy } = makeReranker(makeDescendingRerankResults(candidates));
      const ranker = makeRanker(makeScoreAggregator(0.5), { reranker: port });

      const { metadata } = await ranker.rank(makeInputWithOverrides(candidates, {
        anchorProfile: { anchorEntityId: createEntityId('anchor-1') } as never,
      }));

      expect(spy).toHaveBeenCalledOnce();
      expect(metadata.rerankGateReason).toBe('has_anchor');
      expect(metadata.rerankExecuted).toBe(true);
    });

    it('uses already_precise gate reason and skips reranking for entity route', async () => {
      const candidates = makeCandidates(8, 'wine-exact');
      const { port, spy } = makeReranker([]);
      const ranker = makeRanker(makeScoreAggregator(0.5), { reranker: port });

      const { metadata } = await ranker.rank(makeInputWithOverrides(candidates, {
        queryPlan: {
          route: 'entity',
        },
      }));

      expect(spy).not.toHaveBeenCalled();
      expect(metadata.rerankGateReason).toBe('already_precise');
      expect(metadata.rerankExecuted).toBe(false);
    });

    it('learned LTR rerank is skipped when gate returns shouldRerank=false (too_few_candidates)', async () => {
      // Regression test: previously, ltrModels presence caused the learned rerank
      // to fire even when gateDecision.shouldRerank === false (gate was bypassed).
      // With <5 candidates the gate always returns shouldRerank=false (too_few_candidates).
      // The learned LTR rerank must NOT execute in this case.
      const candidates = makeCandidates(3, 'wine-gate');
      const aggregatorScores = [0.9, 0.7, 0.5];

      const ltrModels = new Map([['semantic_preference', makeUniformSemanticPreferenceLtrModel()]]);

      const ranker = makeRanker(makeScoreAggregatorSequence(aggregatorScores), { ltrModels });

      const { results, metadata } = await ranker.rank(makeInput(candidates));

      // Gate returns too_few_candidates (< 5), so LTR rerank must NOT run.
      expect(metadata.rerankExecuted).toBe(false);
      expect(metadata.rerankGateReason).toBe('too_few_candidates');

      // Original ordering must be preserved (LTR rerank did not run).
      expect(results).toHaveLength(3);
      expect(results[0]!.finalScore).toBeCloseTo(0.9, 5);
      expect(results[1]!.finalScore).toBeCloseTo(0.7, 5);
      expect(results[2]!.finalScore).toBeCloseTo(0.5, 5);
    });

    it('learned LTR rerank executes when gate returns shouldRerank=true (rerankForced)', async () => {
      // Companion test: with rerankForced=true and an LTR model, the learned
      // rerank must fire. Verifies the gate-pass path works after the bug fix.
      const candidates = makeCandidates(3, 'wine-ltr');
      const aggregatorScores = [0.9, 0.5, 0.3];

      const ltrModels = new Map([['semantic_preference', makeBm25DominantLtrModel()]]);

      const ranker = makeRanker(makeScoreAggregatorSequence(aggregatorScores), { ltrModels });

      // rerankForced bypasses the too_few_candidates gate rule.
      const { results, metadata } = await ranker.rank(makeInput(candidates, true));

      // LTR rerank must have executed.
      expect(metadata.rerankExecuted).toBe(true);
      expect(results).toHaveLength(3);
    });

    it('projects dual-lane ranking features into the LTR inference vector', async () => {
      const candidates = [
        makeCandidateWithOverrides('wine-dual-top', {
          vintageYear: 2022,
          entityPosteriorScore: 0.97,
          identityExactnessTier: 'exact',
          lanePresence: 'corroborated',
        }),
        makeCandidateWithOverrides('wine-dual-tail', {
          vintageYear: 2018,
          entityPosteriorScore: 0.99,
          identityExactnessTier: 'exact',
          lanePresence: 'general_only',
        }),
      ];
      const aggregatorScores = [0.8, 0.7];
      const entityPosteriorWeightIndex = 8;
      const ltrModels = new Map([
        [
          'semantic_preference',
          makeLtrModel(
            Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, (_, index) =>
              index === entityPosteriorWeightIndex ? 1 : 0,
            ),
          ),
        ],
      ]);
      const ranker = makeRanker(makeScoreAggregatorSequence(aggregatorScores), { ltrModels });

      const { results, metadata } = await ranker.rank(makeInput(candidates, true));

      expect(metadata.rerankExecuted).toBe(true);
      const top = results.find((result) => String(result.entityId) === 'wine-dual-top');
      expect(top?.scoreDecomposition?.ltrFeatureVector).toHaveLength(LAMBDAMART_FEATURE_DIMENSION);
      expect(top?.scoreDecomposition?.ltrFeatureDimension).toBe(LAMBDAMART_FEATURE_DIMENSION);
      expect(top?.scoreDecomposition?.ltrFeatureNameOrder).toEqual(LAMBDAMART_FEATURE_NAMES);
      expect(top?.scoreDecomposition?.ltrFeatureSchemaHash).toBe(LTR_FEATURE_SCHEMA_HASH);
      expect(top?.scoreDecomposition?.ltrFeatureVector).toEqual([
        0.0,
        0.5,
        0.3,
        0.0,
        0.5,
        0.5,
        0.0,
        0.0,
        0.97,
        1.0,
        1.0,
        0.0,
        0.0,
        0.0,
      ]);

      const tail = results.find((result) => String(result.entityId) === 'wine-dual-tail');
      expect(tail?.scoreDecomposition?.ltrFeatureVector).toEqual([
        0.0,
        0.5,
        0.3,
        0.0,
        0.5,
        0.5,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        1.0,
        0.0,
        1.0,
      ]);
    });

    it('preserves recency in live LTR inference artifacts', async () => {
      const candidates = [makeCandidateWithOverrides('wine-recency', {
        vintageYear: 2023,
      })];
      const aggregatorScores = [0.8];
      const recencyWeightIndex = 3;
      const ltrModels = new Map([
        [
          'semantic_preference',
          makeLtrModel(
            Array.from({ length: LAMBDAMART_FEATURE_DIMENSION }, (_, index) =>
              index === recencyWeightIndex ? 1 : 0,
            ),
          ),
        ],
      ]);
      const ranker = makeRanker(
        makeScoreAggregatorSequence(aggregatorScores),
        {
          ltrModels,
          signalScores: makeComponentScores({ recency: 0.65 }),
        },
      );

      const { results, metadata } = await ranker.rank(makeInput(candidates, true));

      expect(metadata.rerankExecuted).toBe(true);
      expect(results[0]?.scoreDecomposition?.ltrFeatureVector?.[recencyWeightIndex]).toBeCloseTo(0.65, 5);
    });

    it('no_model_for_query_class is reported when no LTR model is registered', async () => {
      const candidates = makeCandidates(1, 'wine-no-model');
      const ltrModels = new Map([
        ['comparison_query', makeUniformSemanticPreferenceLtrModel()],
      ]);
      const ranker = makeRanker(makeScoreAggregator(0.5), { ltrModels });

      const { metadata } = await ranker.rank(makeInput(candidates, true));

      expect(metadata.rerankExecuted).toBe(false);
      expect(metadata.rerankGateReason).toBe('forced');
      expect(metadata.rerankDecision).toMatchObject({
        applied: false,
        decision: 'no_model_for_query_class',
      });
    });

    it('empty_candidates path is exercised when forced LTR receives no viable candidates', async () => {
      const ltrModels = new Map([['semantic_preference', makeUniformSemanticPreferenceLtrModel()]]);
      const ranker = makeRanker(makeScoreAggregator(0.5), { ltrModels });

      const { results, metadata } = await ranker.rank(makeInput([], true));

      // applyLearnedLtrRerank returns empty_candidates here; the public metadata
      // surface records the empty-candidate skip directly with zero counts.
      expect(results).toEqual([]);
      expect(metadata.rerankExecuted).toBe(false);
      expect(metadata.rerankGateReason).toBe('forced');
      expect(metadata.rerankDecision).toMatchObject({
        applied: false,
        decision: 'empty_candidates',
        inputCount: 0,
        outputCount: 0,
      });
      expect(metadata.scoreDriftRecord).toBeUndefined();
    });

    it('feature_dimension_mismatch degrades runtime signal when LTR weights are malformed', async () => {
      const candidates = makeCandidates(6, 'wine-dim');
      const aggregatorScores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
      const ltrModels = new Map([
        [
          'semantic_preference',
          makeLtrModel(Array.from({ length: LAMBDAMART_FEATURE_DIMENSION - 1 }, () => 1)),
        ],
      ]);
      const ranker = makeRanker(makeScoreAggregatorSequence(aggregatorScores), { ltrModels });

      const { metadata } = await ranker.rank(makeInput(candidates, true));

      expect(metadata.rerankExecuted).toBe(false);
      expect(metadata.rerankGateReason).toBe('forced');
      expect(metadata.rerankDecision).toMatchObject({
        applied: false,
        decision: 'feature_dimension_mismatch',
      });
      expect(metadata.runtimeSignal).toEqual({
        rerankerStatus: 'skipped',
        degradation: {
          executionMode: 'degraded',
          degradationReasons: ['ltr_dimension_mismatch'],
        },
      });
    });
  });

  describe('score blending', () => {
    it('originalScore=0.8, rerankerScore=0.6 → min-max norm + semantic_preference blend (w=0.18)', async () => {
      // Use rerankForced to trigger reranking regardless of gate conditions
      const candidates = makeCandidates(6, 'wine-0');

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
      const ranker = makeRanker(makeScoreAggregatorSequence(aggregatorScores), { reranker: port });

      const { results } = await ranker.rank(makeInput(candidates, true));

      // Find result for first candidate
      const firstResult = results.find((r) => r.entityId === firstEntityId);
      expect(firstResult).toBeDefined();
      // Rerank scores [0.6, 0.1, …] → norm(first)=1.0; w=0.18 (default blend scale 1)
      // blended = 0.18 * 1.0 + 0.82 * 0.8 = 0.836
      expect(firstResult!.finalScore).toBeCloseTo(0.836, 10);
    });

    it('collapsed reranker scores keep heuristic ordering and emit a degraded runtime signal', async () => {
      const candidates = makeCandidates(6, 'wine-0');
      const aggregatorScores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
      const reranker: RerankerPort = {
        rerank: async (_query, rerankCandidates) =>
          rerankCandidates.map((c, index) => ({
            entityId: c.entityId,
            score: 1.0,
            rank: index + 1,
          })),
      };

      const ranker = makeRanker(makeScoreAggregatorSequence(aggregatorScores), { reranker });

      const { results, metadata } = await ranker.rank(makeInput(candidates, true));

      expect(results).toHaveLength(aggregatorScores.length);
      results.forEach((result, index) => {
        expect(result.finalScore).toBeCloseTo(aggregatorScores[index]!, 12);
      });
      expect(metadata.runtimeSignal).toEqual({
        rerankerStatus: 'executed',
        degradation: {
          executionMode: 'degraded',
          degradationReasons: ['reranker_score_normalization_failed'],
        },
      });
    });
  });

  describe('rerankTopK', () => {
    it('uses the compiled execution budget rerankLimit as the rerank ceiling', async () => {
      const candidates = makeCandidates(8, 'wine-0');
      const rerankSpy = vi.fn().mockResolvedValue(
        candidates.slice(0, 3).map((candidate, index) => ({
          entityId: candidate.entityId,
          score: 1 - index * 0.1,
          rank: index + 1,
        })),
      );
      const reranker: RerankerPort = { rerank: rerankSpy };
      const ranker = makeRanker(makeScoreAggregatorSequence([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2]), {
        reranker,
        rerankTopK: 8,
      });

      await ranker.rank(makeInputWithOverrides(candidates, {
        compiled: {
          ...makeCompiled(),
          execution: {
            ...makeCompiled().execution,
            budget: { maxCandidates: 20, rerankLimit: 3, enablePrecisionRerank: true },
          },
        },
      }));

      expect(rerankSpy).toHaveBeenCalledOnce();
      const callArgs = rerankSpy.mock.calls[0] as [string, readonly RerankCandidate[], number];
      expect(callArgs[1]).toHaveLength(3);
    });

    it('rerankTopK=3 with 8 candidates: top-3 sent to reranker, remaining 5 appended', async () => {
      const candidates = makeCandidates(8, 'wine-0');

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

      const ranker = makeRanker(makeScoreAggregatorSequence(aggregatorScores), {
        reranker,
        rerankTopK: 3,
      });

      const { results } = await ranker.rank(makeInputWithOverrides(candidates, {
        rerankForced: true,
        compiled: {
          ...makeCompiled(),
          execution: {
            ...makeCompiled().execution,
            budget: { maxCandidates: 20, rerankLimit: 3, enablePrecisionRerank: true },
          },
        },
      }));

      // Reranker should have been called with exactly 3 candidates
      expect(rerankSpy).toHaveBeenCalledOnce();
      const callArgs = rerankSpy.mock.calls[0] as [string, readonly RerankCandidate[], number];
      expect(callArgs[1]).toHaveLength(3);

      // Total results = 8
      expect(results).toHaveLength(8);
    });

    it('after reranking, results are re-sorted by blended score descending', async () => {
      // Use rerankForced to trigger reranking with a small set
      const candidates = makeCandidates(6, 'wine-0');

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

      const ranker = makeRanker(makeScoreAggregatorSequence(aggregatorScores), { reranker });

      const { results } = await ranker.rank(makeInput(candidates, true));

      // Verify results are sorted descending by blended score
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.finalScore).toBeGreaterThanOrEqual(results[i + 1]!.finalScore);
      }
    });

    it('surfaces reranker timeout fallback as a degraded runtime signal', async () => {
      const candidates = makeCandidates(6, 'wine-0');
      const reranker: RerankerPort = {
        rerank: async () => {
          throw new Error('Reranker service: request timed out after 30000ms');
        },
      };

      const ranker = makeRanker(
        makeScoreAggregatorSequence([0.9, 0.8, 0.7, 0.6, 0.5, 0.4]),
        { reranker },
      );

      const { metadata } = await ranker.rank(makeInput(candidates, true));

      expect(metadata.runtimeSignal).toEqual({
        rerankerStatus: 'failed',
        rerankerFailureReason: 'timeout',
        degradation: {
          executionMode: 'degraded',
          degradationReasons: ['reranker_timeout'],
        },
      });
    });

    it('records fine-grained ranking stage timings when a request stageTimer is provided', async () => {
      const candidates = makeCandidates(6, 'wine-0');
      const reranker: RerankerPort = {
        rerank: (_query, rerankCandidates) =>
          Promise.resolve(
            rerankCandidates.map((c, i) => ({
              entityId: c.entityId,
              score: 1.0 - i * 0.1,
              rank: i + 1,
            })),
          ),
      };
      const ranker = makeRanker(makeScoreAggregatorSequence([0.9, 0.8, 0.7, 0.6, 0.5, 0.4]), { reranker });
      const stageTimer = createStageTimer();

      await ranker.rank(makeInputWithOverrides(candidates, {
        rerankForced: true,
        requestContext: { stageTimer },
      }));

      expect(stageTimer.snapshot()).toEqual(expect.objectContaining({
        'ranking.primary_scoring': expect.any(Number),
        'ranking.cross_encoder': expect.any(Number),
        'ranking.cross_encoder.remote': expect.any(Number),
        'ranking.cross_encoder.postprocess': expect.any(Number),
        'ranking.evidence_mapping': expect.any(Number),
      }));
    });

    it('prefers remote cross-encoder over local LTR when a reranker is configured', async () => {
      const candidates = makeCandidates(6, 'wine-ltr-primary');
      const rerankSpy = vi.fn().mockResolvedValue(makeDescendingRerankResults(candidates));
      const ranker = makeRanker(makeScoreAggregatorSequence([0.9, 0.8, 0.7, 0.6, 0.5, 0.4]), {
        reranker: { modelId: 'rerank-v4.0-pro', rerank: rerankSpy },
        ltrModels: new Map([['semantic_preference', makeUniformSemanticPreferenceLtrModel()]]),
      });
      const stageTimer = createStageTimer();

      const { metadata } = await ranker.rank(makeInputWithOverrides(candidates, {
        rerankForced: true,
        requestContext: { stageTimer },
      }));

      expect(rerankSpy).toHaveBeenCalledTimes(1);
      expect(metadata.rerankExecuted).toBe(true);
      expect(metadata.rerankDecision).toMatchObject({
        applied: true,
        decision: 'applied',
        modelId: 'rerank-v4.0-pro',
      });
      expect(stageTimer.snapshot()).toEqual(expect.objectContaining({
        'ranking.cross_encoder': expect.any(Number),
        'ranking.cross_encoder.remote': expect.any(Number),
        'ranking.cross_encoder.postprocess': expect.any(Number),
      }));
      expect(stageTimer.snapshot()).not.toEqual(expect.objectContaining({
        'ranking.ltr': expect.any(Number),
      }));
    });

    it('falls back to local LTR when the remote reranker fails', async () => {
      const candidates = makeCandidates(6, 'wine-ltr-fallback');
      const rerankSpy = vi.fn().mockRejectedValue(new Error('HTTP 503 from reranker'));
      const ranker = makeRanker(makeScoreAggregatorSequence([0.9, 0.8, 0.7, 0.6, 0.5, 0.4]), {
        reranker: { modelId: 'rerank-v4.0-pro', rerank: rerankSpy },
        ltrModels: new Map([['semantic_preference', makeUniformSemanticPreferenceLtrModel()]]),
      });
      const stageTimer = createStageTimer();

      const { metadata } = await ranker.rank(makeInputWithOverrides(candidates, {
        rerankForced: true,
        requestContext: { stageTimer },
      }));

      expect(rerankSpy).toHaveBeenCalledTimes(1);
      expect(metadata.rerankExecuted).toBe(true);
      expect(metadata.rerankDecision).toMatchObject({
        applied: true,
        decision: 'applied',
        modelId: 'semantic_preference',
      });
      expect(metadata.runtimeSignal).toMatchObject({
        rerankerStatus: 'failed',
        rerankerFailureReason: 'http_error',
        degradation: {
          executionMode: 'degraded',
          degradationReasons: ['reranker_http_error'],
        },
      });
      expect(stageTimer.snapshot()).toEqual(expect.objectContaining({
        'ranking.cross_encoder': expect.any(Number),
        'ranking.ltr': expect.any(Number),
      }));
    });
  });

  describe('wave 2 ranking observability', () => {
    it('counts absent inference LTR component scores before they collapse to 0', async () => {
      const candidates = makeCandidates(1, 'wine-ltr-observability');
      const sparseScores: ComponentScores = {
        entityIntegrity: 0.9,
        hardConstraintPass: true,
        softConstraint: 0.2,
        availability: 1.0,
        uncertaintyPenalty: 0.05,
      };
      const ranker = new Ranker(
        makeSignalComputer(sparseScores),
        makeScoreAggregatorSequence([0.88]),
        makeEvidenceMapper(),
        { ltrModels: new Map([['semantic_preference', makeUniformSemanticPreferenceLtrModel()]]) },
      );

      const { results, metadata } = await ranker.rank(makeInput(candidates, true));

      expect(metadata.rerankExecuted).toBe(true);
      expect(results).toHaveLength(1);
      expect(globalSilentSkipCounter.snapshot()).toMatchObject({
        ltr_inference_component_score_absent_semantic: 1,
        ltr_inference_component_score_absent_popularity: 1,
        ltr_inference_component_score_absent_attribute_alignment: 1,
        ltr_inference_component_score_absent_preference_alignment: 1,
        ltr_inference_component_score_absent_multilingual_score: 1,
      });
    });

    it('emits scoreDriftRecord when learned LTR rerank executes', async () => {
      const candidates = makeCandidates(3, 'wine-drift');
      const scoresByEntityId: Record<string, ComponentScores> = {
        [String(candidates[0]!.entityId)]: makeComponentScores({
          semantic: 0.1,
          popularity: 0.1,
          attributeAlignment: 0.1,
          preferenceAlignment: 0.1,
        }),
        [String(candidates[1]!.entityId)]: makeComponentScores({
          semantic: 0.9,
          popularity: 0.9,
          attributeAlignment: 0.9,
          preferenceAlignment: 0.9,
        }),
        [String(candidates[2]!.entityId)]: makeComponentScores({
          semantic: 0.6,
          popularity: 0.6,
          attributeAlignment: 0.6,
          preferenceAlignment: 0.6,
        }),
      };
      const ranker = new Ranker(
        makeSignalComputerByEntity(scoresByEntityId),
        makeScoreAggregatorSequence([0.9, 0.6, 0.4]),
        makeEvidenceMapper(),
        { ltrModels: new Map([['semantic_preference', makeUniformSemanticPreferenceLtrModel()]]) },
      );

      const { metadata } = await ranker.rank(makeInput(candidates, true));

      expect(metadata.scoreDriftRecord).toBeDefined();
      expect(metadata.scoreDriftRecord?.queryClass).toBe('semantic_preference');
      expect(metadata.scoreDriftRecord?.heuristicTop3EntityIds).toEqual(
        candidates.map((candidate) => String(candidate.entityId)),
      );
      expect(metadata.scoreDriftRecord?.ltrTop3EntityIds[0]).toBe(String(candidates[1]!.entityId));
      expect(metadata.scoreDriftRecord?.rankOrderChanges).toBeGreaterThan(0);
      expect(metadata.scoreDriftRecord?.averageRerankDeltaNormalized).toBeGreaterThan(0);
    });

    it('propagates sparseRank and blocks deep eviction of sparse-rank-1 candidate', async () => {
      const protectedCandidate = { ...makeCandidate('wine-protected'), sparseRank: 1 };
      const candidates = [
        protectedCandidate,
        makeCandidate('wine-strong-a'),
        makeCandidate('wine-strong-b'),
        makeCandidate('wine-strong-c'),
      ];
      const scoresByEntityId: Record<string, ComponentScores> = {
        [String(protectedCandidate.entityId)]: makeComponentScores({
          semantic: 0.0,
          popularity: 0.0,
          attributeAlignment: 0.0,
          preferenceAlignment: 0.0,
        }),
        [String(candidates[1]!.entityId)]: makeComponentScores({
          semantic: 1.0,
          popularity: 1.0,
          attributeAlignment: 1.0,
          preferenceAlignment: 1.0,
        }),
        [String(candidates[2]!.entityId)]: makeComponentScores({
          semantic: 0.9,
          popularity: 0.9,
          attributeAlignment: 0.9,
          preferenceAlignment: 0.9,
        }),
        [String(candidates[3]!.entityId)]: makeComponentScores({
          semantic: 0.8,
          popularity: 0.8,
          attributeAlignment: 0.8,
          preferenceAlignment: 0.8,
        }),
      };
      const ranker = new Ranker(
        makeSignalComputerByEntity(scoresByEntityId),
        makeScoreAggregatorSequence([0.95, 0.8, 0.7, 0.6]),
        makeEvidenceMapper(),
        { ltrModels: new Map([['semantic_preference', makeUniformSemanticPreferenceLtrModel()]]) },
      );

      const { results, metadata } = await ranker.rank(makeInput(candidates, true));
      const protectedResult = results.find((result) => result.entityId === protectedCandidate.entityId);

      expect(protectedResult?.sparseRank).toBe(1);
      expect(protectedResult?.rank).toBeLessThanOrEqual(3);
      expect(metadata.scoreDriftRecord?.safetyEnvelopeBlocks).toBe(1);
    });
  });
});
