import { describe, expect, it, vi } from 'vitest';
import { AmbiguityClassifier, Blocker, Calibrator, CandidateScorer, Resolver } from '../../../src/domain/resolver/index.js';
import type { BlockingPort } from '../../../src/domain/resolver/port/blocking.port.js';
import type { CalibrationStore } from '../../../src/domain/resolver/port/calibration-store.port.js';
import type { ResolverInput } from '../../../src/domain/resolver/service/resolver.js';
import type { LearnedMatcherPort } from '../../../src/domain/resolver/port/learned-matcher.port.js';
import type { ResolverCandidate } from '../../../src/domain/resolver/model/resolved-candidate.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import { QueryNormalizer } from '../../../src/domain/query/index.js';

const blockingPort: BlockingPort = {
  async block() {
    return [createEntityId('entity-opus-one-2018')];
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

function makeCandidate(): ResolverCandidate {
  return {
    entityId: createEntityId('entity-opus-one-2018'),
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    aliasMatches: [],
    sourceSignals: {
      canonicalExactMatch: 0,
      canonicalNormalizedMatch: 0.5,
      aliasExactMatch: 0.5,
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

describe('Resolver learned matcher context', () => {
  it('passes noisy lookup context into the learned matcher blend step', async () => {
    const match = vi.fn<LearnedMatcherPort['match']>().mockResolvedValue([
      {
        entityId: createEntityId('entity-opus-one-2018'),
        matchProbability: 0.91,
        modelId: 'matcher',
        modelVersion: '1.0.0',
        matchSignalVector: [0.91, 0.67, 0.12],
      },
    ]);
    const learnedMatcher: LearnedMatcherPort = { match };
    const resolver = new Resolver(
      new Blocker(blockingPort),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator(calibrationStore),
      learnedMatcher,
    );

    const queryViews = new QueryNormalizer().normalize('오푸스원 18');
    const input: ResolverInput = {
      rawQuery: '오푸스원 18',
      normalizedQuery: queryViews.accentless,
      normalizedQueryViews: queryViews,
      queryClass: 'short_entity',
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        fallbackMode: 'hybrid',
        policyReasonCodes: [],
      },
      anchorCandidates: [
        {
          surfaceForm: 'Opus One 2018',
          normalizedForm: 'opus one 2018',
          candidateEntityIds: [createEntityId('entity-opus-one-2018')],
          lookupVariants: ['opus one', 'opusone18'],
          lookupStrategies: ['transliterated_exact', 'compact_exact'],
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
        parserConfidence: 0.95,
        anchorConfidence: 0.95,
        constraintConfidence: 0.95,
      },
      candidateEntities: [makeCandidate()],
    };

    const result = await resolver.resolve(input);

    expect(match).toHaveBeenCalledTimes(1);
    expect(match.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        queryClass: 'short_entity',
        anchorLookupVariants: expect.arrayContaining(['opus one', 'opusone18']),
        anchorLookupStrategies: expect.arrayContaining(['compact_exact', 'transliterated_exact']),
        normalizedQueryViews: expect.objectContaining({
          transliterated: 'opus one',
        }),
        candidateFeatures: expect.any(Map),
      }),
    );
    expect(match.mock.calls[0]?.[2]?.candidateFeatures?.get('entity-opus-one-2018')).toEqual(
      expect.objectContaining({
        provenanceStage: 'compact_exact',
      }),
    );
    expect(result.decisionTrace.learnedMatcherTrace).toEqual(
      expect.objectContaining({
        modelId: 'matcher',
        modelVersion: '1.0.0',
        candidates: [
          expect.objectContaining({
            entityId: 'entity-opus-one-2018',
            matchProbability: 0.91,
            matchSignalVector: [0.91, 0.67, 0.12],
          }),
        ],
      }),
    );
  });

  it('falls back to heuristic resolver scoring when the learned matcher fails', async () => {
    const match = vi.fn<LearnedMatcherPort['match']>().mockRejectedValue(
      new Error('matcher unavailable'),
    );
    const learnedMatcher: LearnedMatcherPort = { match };
    const resolver = new Resolver(
      new Blocker(blockingPort),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator(calibrationStore),
      learnedMatcher,
    );

    const queryViews = new QueryNormalizer().normalize('오푸스원 18');
    const input: ResolverInput = {
      rawQuery: '오푸스원 18',
      normalizedQuery: queryViews.accentless,
      normalizedQueryViews: queryViews,
      queryClass: 'short_entity',
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        fallbackMode: 'hybrid',
        policyReasonCodes: [],
      },
      anchorCandidates: [
        {
          surfaceForm: 'Opus One 2018',
          normalizedForm: 'opus one 2018',
          candidateEntityIds: [createEntityId('entity-opus-one-2018')],
          lookupVariants: ['opus one'],
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
        parserConfidence: 0.95,
        anchorConfidence: 0.95,
        constraintConfidence: 0.95,
      },
      candidateEntities: [makeCandidate()],
    };

    const result = await resolver.resolve(input);

    expect(match).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('resolved');
    expect(result.decisionTrace.learnedMatcherTrace).toBeUndefined();
  });
});
