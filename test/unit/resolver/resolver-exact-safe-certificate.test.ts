import { describe, expect, it } from 'vitest';
import { AmbiguityClassifier, Blocker, Calibrator, CandidateScorer, Resolver } from '../../../src/domain/resolver/index.js';
import type { BlockingPort } from '../../../src/domain/resolver/port/blocking.port.js';
import type { CalibrationStore } from '../../../src/domain/resolver/port/calibration-store.port.js';
import type { ResolverInput } from '../../../src/domain/resolver/service/resolver.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

const blockingPort: BlockingPort = {
  async block() {
    return [createEntityId('entity-haut-brion')];
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

describe('Resolver exact-safe singleton certificate', () => {
  it('resolves a singleton exact-safe candidate even below the generic confidence threshold', async () => {
    const resolver = new Resolver(
      new Blocker(blockingPort),
      new CandidateScorer(),
      new AmbiguityClassifier(),
      new Calibrator(calibrationStore),
    );

    const input: ResolverInput = {
      rawQuery: '오브리옹',
      normalizedQuery: '오브리옹',
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
          surfaceForm: '오브리옹',
          normalizedForm: '오브리옹',
          candidateEntityIds: [createEntityId('entity-haut-brion')],
          lookupStrategies: ['exact'],
          aliasType: 'observed_query_alias',
          confidence: 0.98,
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
        anchorConfidence: 0.98,
        constraintConfidence: 0.95,
      },
      candidateEntities: [
        {
          entityId: createEntityId('entity-haut-brion'),
          entityType: 'wine',
          canonicalLabel: '1967 Château Haut-Brion',
          aliasMatches: [{
            aliasValue: '오브리옹',
            aliasType: 'observed_query_alias',
            matchScore: 0.98,
          }],
          identityCertificates: [{
            kind: 'exact_safe',
            normalizedSurface: '오브리옹',
            sourceTier: 'curated',
            singleton: true,
            collisionFree: true,
          }],
          attributeHints: {
            producer: 'Château Haut-Brion',
          },
          sourceSignals: {
            canonicalExactMatch: 0,
            canonicalNormalizedMatch: 0.35,
            aliasExactMatch: 0.35,
            aliasFuzzyMatch: 0,
            aliasTypePrior: 0.35,
            producerMatch: 0,
            vintageMatch: 0,
            regionMatch: 0,
            grapeHintMatch: 0,
            phoneticMatch: 0,
            editDistanceScore: 0,
            ambiguityPenalty: 0,
          },
          source: 'alias',
        },
      ],
    };

    const result = await resolver.resolve(input);

    expect(result.status).toBe('resolved');
    expect(result.topEntity?.entityId).toBe('entity-haut-brion');
    expect(result.decisionTrace.outcomeReasonCodes).toContain('SINGLETON_EXACT_SAFE_CERTIFICATE_RESOLVED');
  });
});
