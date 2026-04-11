import { describe, expect, it } from 'vitest';
import { Blocker, CandidateScorer, Calibrator, AmbiguityClassifier, Resolver } from '../../../src/domain/resolver/index.js';
import { QueryNormalizer } from '../../../src/domain/query/index.js';
import type { BlockingPort } from '../../../src/domain/resolver/port/blocking.port.js';
import type { CalibrationStore } from '../../../src/domain/resolver/port/calibration-store.port.js';
import type { ResolverInput } from '../../../src/domain/resolver/service/resolver.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

const ZERO_SIGNALS = {
  canonicalExactMatch: 0,
  canonicalNormalizedMatch: 0,
  aliasExactMatch: 0,
  aliasFuzzyMatch: 0,
  aliasTypePrior: 0,
  producerMatch: 0,
  vintageMatch: 0,
  regionMatch: 0,
  grapeHintMatch: 0,
  phoneticMatch: 0,
  editDistanceScore: 0,
  ambiguityPenalty: 0,
} as const;

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

describe('Resolver provenance', () => {
  it('surfaces query-view and anchor lookup provenance in the decision trace', async () => {
    const resolver = new Resolver(
      new Blocker(blockingPort),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator(calibrationStore),
    );

    const queryViews = new QueryNormalizer().normalize('Opus-One 18');
    const input: ResolverInput = {
      rawQuery: 'Opus-One 18',
      normalizedQuery: queryViews.accentless,
      normalizedQueryViews: queryViews,
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
          surfaceForm: 'Opus One 18',
          normalizedForm: 'opus one 18',
          candidateEntityIds: [createEntityId('entity-opus-one-2018')],
          lookupVariants: ['opusone18', 'opus one 2018'],
          lookupStrategies: ['compact_exact'],
          confidence: 0.92,
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
      candidateEntities: [],
    };

    const result = await resolver.resolve(input);

    expect(result.decisionTrace.queryProvenance?.normalizedQueryViews?.compact).toBe('opusone18');
    expect(result.decisionTrace.queryProvenance?.normalizedQueryViews?.lookupVariants).toEqual(
      expect.arrayContaining(['opusone18', 'opus one 2018']),
    );
    expect(result.decisionTrace.queryProvenance?.anchorLookupVariants).toEqual(
      expect.arrayContaining(['opusone18', 'opus one 2018']),
    );
    expect(result.decisionTrace.queryProvenance?.anchorLookupStrategies).toEqual(
      expect.arrayContaining(['compact_exact']),
    );
    expect(result.decisionTrace.queryProvenance?.lookupStrategyAdjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: 'entity-opus-one-2018',
          strategies: ['compact_exact'],
          rawScoreDelta: 0.04,
        }),
      ]),
    );
  });

  it('surfaces blocker-seed provenance for candidates that entered scoring via blocker hydration', async () => {
    const resolver = new Resolver(
      new Blocker(blockingPort),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator(calibrationStore),
    );

    const input: ResolverInput = {
      rawQuery: '오퍼스원 2018',
      normalizedQuery: 'opus one 2018',
      queryClass: 'short_entity',
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        fallbackMode: 'fail',
        policyReasonCodes: [],
      },
      anchorCandidates: [],
      uncertainty: {
        overall: 0.2,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.8,
        anchorConfidence: 0.2,
        constraintConfidence: 0.9,
      },
      candidateEntities: [],
      blockerSeedCandidates: [
        {
          entityId: createEntityId('entity-opus-one-2018'),
          entityType: 'wine',
          canonicalLabel: 'Opus One 2018',
          aliasMatches: [],
          sourceSignals: ZERO_SIGNALS,
          attributeHints: { vintage: 2018 },
          source: 'blocker_seed',
        },
      ],
    };

    const result = await resolver.resolve(input);

    expect(result.candidates[0]?.blockerSeed).toBe(true);
    expect(result.decisionTrace.queryProvenance?.blockerSeedEntityIds).toEqual([
      'entity-opus-one-2018',
    ]);
    expect(result.decisionTrace.queryProvenance?.blockerSeedCount).toBe(1);
  });
});
