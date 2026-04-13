import { describe, expect, it, vi } from 'vitest';
import { Resolver } from '../service/resolver.js';
import { createCanonicalEntityId } from '../../shared/types/index.js';
import type { ResolverInput } from '../service/resolver.js';
import type { ResolverCandidate } from '../model/resolved-candidate.js';

const ENTITY_ID = createCanonicalEntityId('wine-ce-test');

function makeResolverInput(overrides: Partial<ResolverInput> = {}): ResolverInput {
  const candidate: ResolverCandidate = {
    entityId: ENTITY_ID,
    entityType: 'wine',
    canonicalLabel: '2014 Kalaris Merlot',
    aliasMatches: [{
      aliasValue: 'Kalaris Merlot',
      aliasType: 'canonical',
      matchScore: 1,
    }],
    sourceSignals: {
      canonicalExactMatch: 1,
      canonicalNormalizedMatch: 1,
      aliasExactMatch: 1,
      aliasFuzzyMatch: 0,
      aliasTypePrior: 1,
      producerMatch: 0,
      vintageMatch: 0,
      regionMatch: 0,
      grapeHintMatch: 0,
      phoneticMatch: 0,
      editDistanceScore: 0,
      ambiguityPenalty: 0,
    },
    attributeHints: {
      producer: 'Kalaris',
      vintage: 2014,
      vintage_year: 2014,
      grape_primary: 'Merlot',
    },
    source: 'alias',
    sources: ['alias'],
  };

  return {
    rawQuery: 'Kalaris Merlot',
    normalizedQuery: 'kalaris merlot',
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
        surfaceForm: 'Kalaris',
        normalizedForm: 'kalaris',
        candidateEntityIds: [ENTITY_ID],
        lookupStrategies: ['substring'],
        confidence: 0.95,
        source: 'alias',
      },
      {
        surfaceForm: 'Kalaris Merlot',
        normalizedForm: 'kalaris merlot',
        candidateEntityIds: [ENTITY_ID],
        lookupStrategies: ['substring'],
        confidence: 0.95,
        source: 'alias',
      },
    ],
    uncertainty: {
      overall: 0.05,
      ambiguityDetected: false,
      ambiguityTypes: [],
      ambiguitySeverity: 'low',
      decisionEffect: 'trace_only',
      parserConfidence: 0.95,
      anchorConfidence: 0.95,
      constraintConfidence: 0.95,
    },
    candidateEntities: [candidate],
    ...overrides,
  };
}

describe('Resolver singleton routing', () => {
  it('does not resolve a singleton candidate below the calibrated threshold', async () => {
    const resolver = new Resolver(
      {
        block: vi.fn().mockResolvedValue([ENTITY_ID]),
      } as never,
      {
        score: vi.fn().mockReturnValue(0.2),
      } as never,
      {
        classify: vi.fn().mockReturnValue({
          detected: false,
          types: [],
          severity: 'low',
        }),
      } as never,
      {
        calibrate: vi.fn().mockResolvedValue({
          top1CalibratedScore: 0.2,
          top2CalibratedScore: 0,
          calibratedGap: 0.2,
          decisionConfidenceC: 0.2,
        }),
      } as never,
    );

    const result = await resolver.resolve(makeResolverInput());

    expect(result.status).not.toBe('resolved');
    expect(result.recommendedNextAction).not.toBe('return_result');
    expect(result.decisionTrace.outcomeReasonCodes).not.toContain('SINGLETON_BYPASS_RESOLVED');
  });

  it('resolves a high-confidence singleton even when two noisy anchors point to the same entity', async () => {
    const resolver = new Resolver(
      {
        block: vi.fn().mockResolvedValue([ENTITY_ID]),
      } as never,
      {
        score: vi.fn().mockReturnValue(0.92),
      } as never,
      {
        classify: vi.fn().mockReturnValue({
          detected: false,
          types: [],
          severity: 'low',
        }),
      } as never,
      {
        calibrate: vi.fn().mockResolvedValue({
          top1CalibratedScore: 0.92,
          top2CalibratedScore: 0,
          calibratedGap: 0.92,
          decisionConfidenceC: 0.92,
        }),
      } as never,
    );

    const result = await resolver.resolve(makeResolverInput());

    expect(result.status).toBe('resolved');
    expect(result.recommendedNextAction).toBe('return_result');
    expect(result.decisionTrace.outcomeReasonCodes).toContain('SINGLETON_BYPASS_RESOLVED');
  });
});
