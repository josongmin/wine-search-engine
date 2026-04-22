import { describe, expect, it } from 'vitest';
import { AmbiguityClassifier, Blocker, Calibrator, CandidateScorer, Resolver } from '../../../src/domain/resolver/index.js';
import type { BlockingPort } from '../../../src/domain/resolver/port/blocking.port.js';
import type { CalibrationStore } from '../../../src/domain/resolver/port/calibration-store.port.js';
import type { ResolverInput } from '../../../src/domain/resolver/service/resolver.js';
import type { ResolverCandidate } from '../../../src/domain/resolver/model/resolved-candidate.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

const blockingPort: BlockingPort = {
  async block() {
    return [createEntityId('entity-a'), createEntityId('entity-b')];
  },
};

const calibrationStore: CalibrationStore = {
  async getCalibrationParams() {
    return null;
  },
  async save() {
    return;
  },
};

function makeCandidate(entityId: string): ResolverCandidate {
  return {
    entityId: createEntityId(entityId),
    entityType: 'wine',
    canonicalLabel: entityId,
    aliasMatches: [],
    sourceSignals: {
      canonicalExactMatch: 0,
      canonicalNormalizedMatch: 0.4,
      aliasExactMatch: 0.4,
      aliasFuzzyMatch: 0,
      aliasTypePrior: 0,
      producerMatch: 0,
      vintageMatch: 0,
      regionMatch: 0,
      grapeHintMatch: 0,
      phoneticMatch: 0,
      editDistanceScore: 0,
      ambiguityPenalty: 0,
    },
  };
}

describe('Resolver lookup strategy adjustments', () => {
  it('prefers a candidate backed by transliterated exact lookup over an otherwise tied candidate', async () => {
    const resolver = new Resolver(
      new Blocker(blockingPort),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator(calibrationStore),
    );

    const input: ResolverInput = {
      rawQuery: '샤토 마고',
      normalizedQuery: '샤토 마고',
      queryClass: 'short_entity',
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        fallbackMode: 'fail',
        policyReasonCodes: [],
      },
      anchorCandidates: [
        {
          surfaceForm: 'Chateau Margaux',
          normalizedForm: 'chateau margaux',
          candidateEntityIds: [createEntityId('entity-a')],
          lookupStrategies: ['transliterated_exact'],
          confidence: 0.95,
          source: 'alias',
        },
      ],
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0.95,
        constraintConfidence: 0.9,
      },
      candidateEntities: [makeCandidate('entity-a'), makeCandidate('entity-b')],
    };

    const result = await resolver.resolve(input);

    expect(result.topEntity?.entityId).toBe('entity-a');
    const adjustments = result.decisionTrace.queryProvenance?.lookupStrategyAdjustments ?? [];
    // entity-a: transliterated_exact 전략으로 +0.05 보너스 받음
    expect(adjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: 'entity-a',
          strategies: ['transliterated_exact'],
          rawScoreDelta: 0.05,
        }),
      ]),
    );
    // entity-b: lookup strategy 없음 → adjustments에 등장하지 않거나 delta=0
    // arrayContaining만 쓰면 entity-b가 의도치 않게 보너스를 받아도 테스트 통과됨
    const entityBAdj = adjustments.find((a: { entityId: string }) => a.entityId === 'entity-b');
    expect(entityBAdj?.rawScoreDelta ?? 0).toBe(0);
    // entity-a가 실제로 1위 — 조정 없이도 entity-b보다 높아야 함
    expect(result.candidates[0]?.entityId).toBe('entity-a');
    expect(result.decisionTrace.queryProvenance?.candidateSourceBreakdown).toBeUndefined();
  });

  it.each([
    ['prefix_exact', 'opu', 'opus one'],
    ['transliterated_prefix', '오퍼스', '오퍼스 원'],
  ] as const)(
    'treats %s as exact-like support and does not conservatively clarify short-form queries',
    async (strategy, rawQuery, surfaceForm) => {
      const resolver = new Resolver(
        new Blocker(blockingPort),
        new CandidateScorer(),
        new AmbiguityClassifier(),
        new Calibrator(calibrationStore),
      );

      const input: ResolverInput = {
        rawQuery,
        normalizedQuery: rawQuery,
        queryClass: 'short_entity',
        policy: {
          requireExact: false,
          allowApproximate: true,
          requireClarification: true,
          fallbackMode: 'fail',
          policyReasonCodes: [],
        },
        anchorCandidates: [
          {
            surfaceForm,
            normalizedForm: surfaceForm,
            candidateEntityIds: [createEntityId('entity-a')],
            lookupStrategies: [strategy],
            confidence: 0.95,
            source: 'alias',
          },
          {
            surfaceForm: 'fallback noisy alias',
            normalizedForm: 'fallback noisy alias',
            candidateEntityIds: [createEntityId('entity-b')],
            lookupStrategies: ['fuzzy_char_ngram'],
            confidence: 0.4,
            source: 'alias',
          },
        ],
        uncertainty: {
          overall: 0.35,
          ambiguityDetected: false,
          ambiguityTypes: [],
          ambiguitySeverity: 'low',
          decisionEffect: 'trace_only',
          parserConfidence: 0.85,
          anchorConfidence: 0.95,
          constraintConfidence: 0.8,
        },
        candidateEntities: [
          makeCandidate('entity-a'),
          makeCandidate('entity-b'),
        ],
      };

      const result = await resolver.resolve(input);

      const adjustments = result.decisionTrace.queryProvenance?.lookupStrategyAdjustments ?? [];
      expect(adjustments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entityId: 'entity-a',
            strategies: [strategy],
            rawScoreDelta: 0.05,
          }),
          expect.objectContaining({
            entityId: 'entity-b',
            strategies: ['fuzzy_char_ngram'],
            rawScoreDelta: 0.01,
          }),
        ]),
      );
      expect(result.decisionTrace.outcomeReasonCodes).not.toContain(
        'NOISY_SHORT_FORM_REQUIRE_CLARIFICATION',
      );
    },
  );

  it('keeps fuzzy-only short-form support conservative', async () => {
    const resolver = new Resolver(
      new Blocker(blockingPort),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator(calibrationStore),
    );

    const input: ResolverInput = {
      rawQuery: 'opus',
      normalizedQuery: 'opus',
      queryClass: 'short_entity',
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: true,
        fallbackMode: 'fail',
        policyReasonCodes: [],
      },
      anchorCandidates: [
        {
          surfaceForm: 'Opus',
          normalizedForm: 'opus',
          candidateEntityIds: [createEntityId('entity-a')],
          lookupStrategies: ['fuzzy_char_ngram'],
          confidence: 0.65,
          source: 'alias',
        },
        {
          surfaceForm: 'Opus',
          normalizedForm: 'opus',
          candidateEntityIds: [createEntityId('entity-b')],
          lookupStrategies: ['fuzzy_char_ngram'],
          confidence: 0.65,
          source: 'alias',
        },
      ],
      uncertainty: {
        overall: 0.5,
        ambiguityDetected: true,
        ambiguityTypes: ['polysemous_name'],
        ambiguitySeverity: 'medium',
        decisionEffect: 'clarify',
        parserConfidence: 0.8,
        anchorConfidence: 0.65,
        constraintConfidence: 0.8,
      },
      candidateEntities: [makeCandidate('entity-a'), makeCandidate('entity-b')],
    };

    const result = await resolver.resolve(input);

    expect(result.status).toBe('ambiguous');
    expect(result.recommendedNextAction).toBe('clarify');
    expect(result.decisionTrace.outcomeReasonCodes).toContain('NOISY_SHORT_FORM_REQUIRE_CLARIFICATION');
    expect(result.decisionTrace.queryProvenance?.lookupStrategyAdjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rawScoreDelta: 0.01,
          strategies: ['fuzzy_char_ngram'],
        }),
      ]),
    );
  });
});
