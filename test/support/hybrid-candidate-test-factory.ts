import type {
  GeneralLaneOnlyHybridCandidate,
  GeneralOnlyHybridCandidate,
  HybridCandidate,
  HybridCandidateBase,
  IdentityLaneHybridCandidate,
} from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type {
  DualLanePresence,
  IdentityExactnessTier,
} from '../../src/domain/retrieval/model/dual-lane-artifact.js';
import {
  createEntityId,
  type CanonicalEntityId,
} from '../../src/domain/shared/types/index.js';

type CandidateCommonOverrides = Partial<HybridCandidateBase> & {
  readonly entityId?: CanonicalEntityId;
};

type GeneralLaneOnlyInput = CandidateCommonOverrides & {
  readonly lanePresence?: undefined;
  readonly identityExactnessTier?: 'none';
  readonly entityPosteriorScore?: undefined;
};

type GeneralOnlyInput = CandidateCommonOverrides & {
  readonly lanePresence: 'general_only';
  readonly identityExactnessTier?: 'none';
  readonly entityPosteriorScore?: undefined;
};

type IdentityLaneInput = CandidateCommonOverrides & {
  readonly lanePresence: Exclude<DualLanePresence, 'general_only'>;
  readonly identityExactnessTier?: IdentityExactnessTier;
  readonly entityPosteriorScore?: number;
};

type HybridCandidateTestInput =
  | GeneralLaneOnlyInput
  | GeneralOnlyInput
  | IdentityLaneInput;

function buildBaseCandidate(
  overrides: CandidateCommonOverrides,
): HybridCandidateBase {
  const {
    entityId = createEntityId('test-hybrid-candidate'),
    matchedConstraints = [],
    retrievalTrace = {
      retrievalProfile: 'test',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [],
    },
    ...rest
  } = overrides;

  return {
    entityId,
    matchedConstraints,
    retrievalTrace,
    ...rest,
  };
}

export function makeHybridCandidate(
  overrides: HybridCandidateTestInput = {},
): HybridCandidate {
  const base = buildBaseCandidate(overrides);

  if (overrides.lanePresence === undefined) {
    const candidate: GeneralLaneOnlyHybridCandidate = {
      ...base,
      identityExactnessTier: 'none',
    };
    return candidate;
  }

  if (overrides.lanePresence === 'general_only') {
    const candidate: GeneralOnlyHybridCandidate = {
      ...base,
      lanePresence: 'general_only',
      identityExactnessTier: 'none',
    };
    return candidate;
  }

  const candidate: IdentityLaneHybridCandidate = {
    ...base,
    lanePresence: overrides.lanePresence,
    identityExactnessTier: overrides.identityExactnessTier ?? 'none',
    ...(overrides.entityPosteriorScore !== undefined
      ? { entityPosteriorScore: overrides.entityPosteriorScore }
      : {}),
  };
  return candidate;
}
