export type ReleaseQueryFamily =
  | 'entity_exact'
  | 'pure_constraint'
  | 'anchored_similarity'
  | 'pairing'
  | 'browse'
  | 'situation_based'
  | 'no_match';

export interface EntityExactReleaseBaseline {
  readonly wrongResolveRate: number;
  readonly top3Recall: number;
}

export interface AnchoredSimilarityReleaseBaseline {
  readonly seedExclusionPrecision: number;
}

export interface RankedFamilyReleaseBaseline {
  readonly zeroCandidateRate: number;
  readonly meanNdcgAt10: number;
  readonly meanRecallAt20: number;
  readonly meanMrrAt10: number;
}

export interface NoMatchReleaseBaseline {
  readonly failClosedRate: number;
}

export interface QueryFamilyReleaseBaselines {
  readonly entity_exact: EntityExactReleaseBaseline;
  readonly pure_constraint: RankedFamilyReleaseBaseline;
  readonly anchored_similarity: AnchoredSimilarityReleaseBaseline;
  readonly pairing: RankedFamilyReleaseBaseline;
  readonly browse: RankedFamilyReleaseBaseline;
  readonly situation_based: RankedFamilyReleaseBaseline;
  readonly no_match: NoMatchReleaseBaseline;
}

export const QUERY_FAMILY_RELEASE_BASELINE_VERSION = '2026-05-28-query-family-release-gate-v2';

export const QUERY_FAMILY_RELEASE_BASELINES: QueryFamilyReleaseBaselines = {
  entity_exact: {
    wrongResolveRate: 0.5,
    top3Recall: 1,
  },
  pure_constraint: {
    zeroCandidateRate: 0,
    meanNdcgAt10: 1,
    meanRecallAt20: 1,
    meanMrrAt10: 1,
  },
  anchored_similarity: {
    seedExclusionPrecision: 1,
  },
  pairing: {
    zeroCandidateRate: 0,
    meanNdcgAt10: 0.8889263577680148,
    meanRecallAt20: 1,
    meanMrrAt10: 1,
  },
  browse: {
    zeroCandidateRate: 0,
    meanNdcgAt10: 0.9173194127129571,
    meanRecallAt20: 0.5,
    meanMrrAt10: 1,
  },
  situation_based: {
    zeroCandidateRate: 0,
    meanNdcgAt10: 1,
    meanRecallAt20: 1,
    meanMrrAt10: 1,
  },
  no_match: {
    failClosedRate: 1,
  },
};

export const QUERY_FAMILY_RELEASE_THRESHOLDS = {
  entityExactWrongResolveMaxIncrease: 0,
  entityExactTop3RecallMaxDrop: 0,
  anchoredSimilaritySeedExclusionMaxDrop: 0,
  noMatchFailClosedMaxDrop: 0,
  rankedFamilyZeroCandidateMaxIncrease: 0,
  rankedFamilyNdcgAt10MaxDrop: 0.02,
  rankedFamilyRecallAt20MaxDrop: 0,
  rankedFamilyMrrAt10MaxDrop: 0.02,
} as const;
