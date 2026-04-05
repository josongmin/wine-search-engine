import { describe, expect, it } from 'vitest';
import { Blocker, CandidateScorer, Calibrator, AmbiguityClassifier, Resolver } from '../../../src/domain/resolver/index.js';
import { QueryNormalizer } from '../../../src/domain/query/index.js';
import type { BlockingPort } from '../../../src/domain/resolver/port/blocking.port.js';
import type { CalibrationStore } from '../../../src/domain/resolver/port/calibration-store.port.js';
import type { ResolverInput } from '../../../src/domain/resolver/service/resolver.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

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
});
