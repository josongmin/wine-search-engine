import { describe, expect, it, vi } from 'vitest';
import { Resolver } from '../service/resolver.js';
import { createCanonicalEntityId } from '../../shared/types/index.js';
import type { ResolverInput } from '../service/resolver.js';
import type { ResolverCandidate } from '../model/resolved-candidate.js';

const ENTITY_ID = createCanonicalEntityId('wine-ce-test');
const ENTITY_ID_2 = createCanonicalEntityId('wine-ce-test-2');

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

function makeSecondCandidate(): ResolverCandidate {
  return {
    entityId: ENTITY_ID_2,
    entityType: 'wine',
    canonicalLabel: '2015 Kalaris Merlot',
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
      vintage: 2015,
      vintage_year: 2015,
      grape_primary: 'Merlot',
    },
    source: 'alias',
    sources: ['alias'],
  };
}

describe('Resolver applyDecisionBoundary calibratedGap invariant (C2)', () => {
  it('throws when hasRunnerUp=true but calibratedGap is undefined', async () => {
    const input = makeResolverInput({
      candidateEntities: [
        makeResolverInput().candidateEntities[0]!,
        makeSecondCandidate(),
      ],
    });

    const resolver = new Resolver(
      {
        block: vi.fn().mockResolvedValue([ENTITY_ID, ENTITY_ID_2]),
      } as never,
      {
        score: vi.fn().mockReturnValue(0.5),
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
          top1CalibratedScore: 0.5,
          top2CalibratedScore: 0.4,
          hasRunnerUp: true,
          // Contract violation: hasRunnerUp=true but gap undefined.
          calibratedGap: undefined,
          decisionConfidenceC: 0.5,
          candidateCount: 2,
          calibrationTrusted: true,
        }),
      } as never,
    );

    await expect(resolver.resolve(input)).rejects.toThrow(
      'Invariant: hasRunnerUp=true but calibratedGap=undefined',
    );
  });

  it('does not throw when hasRunnerUp=true and calibratedGap is a finite number', async () => {
    const input = makeResolverInput({
      candidateEntities: [
        makeResolverInput().candidateEntities[0]!,
        makeSecondCandidate(),
      ],
    });

    const resolver = new Resolver(
      {
        block: vi.fn().mockResolvedValue([ENTITY_ID, ENTITY_ID_2]),
      } as never,
      {
        score: vi.fn().mockReturnValue(0.5),
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
          top1CalibratedScore: 0.5,
          top2CalibratedScore: 0.4,
          hasRunnerUp: true,
          calibratedGap: 0.1,
          decisionConfidenceC: 0.5,
          candidateCount: 2,
          calibrationTrusted: true,
        }),
      } as never,
    );

    const result = await resolver.resolve(input);
    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
  });
});

describe('Resolver singleton routing', () => {
  it('skips blocker filtering when the caller marks the candidate pool authoritative', async () => {
    const block = vi.fn().mockResolvedValue([]);
    const resolver = new Resolver(
      { block } as never,
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
          candidateCount: 1,
          calibrationTrusted: true,
        }),
      } as never,
    );

    const result = await resolver.resolve(makeResolverInput({
      blockingPolicy: 'trust_candidate_pool',
    }));

    expect(block).not.toHaveBeenCalled();
    expect(result.candidates).toHaveLength(1);
    expect(result.status).toBe('resolved');
    expect(String(result.topEntity?.entityId)).toBe(String(ENTITY_ID));
  });

  it('keeps legacy blocker enforcement when blockingPolicy is omitted', async () => {
    const block = vi.fn().mockResolvedValue([]);
    const resolver = new Resolver(
      { block } as never,
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
          candidateCount: 1,
          calibrationTrusted: true,
        }),
      } as never,
    );

    const result = await resolver.resolve(makeResolverInput());

    expect(block).toHaveBeenCalledOnce();
    expect(result.candidates).toHaveLength(0);
    expect(result.status).toBe('failed');
    expect(result.decisionTrace.outcomeReasonCodes).toContain('NO_CANDIDATES_AFTER_BLOCKING');
  });

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
