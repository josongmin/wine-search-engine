import type { QueryClass } from '../../shared/types/index.js';
import { DomainError } from '../../shared/error/domain-error.js';
import type { RetrievalChannel } from '../model/retrieval-channel.js';
import type { QueryFamily } from './channel-mix-policy.js';
import {
  getLiveRetrievalProfileDefinition,
  isLegacyHeuristicRetrievalModeAlias,
  resolveFallbackLiveProfileName,
  resolveLiveProfileNameForRetrievalMode,
  resolveLiveQueryFamilyPolicy,
  type LiveRetrievalProfileName,
} from './live-retrieval-policy-registry.js';

export interface RetrievalProfile {
  readonly name: string;
  readonly channelMix: readonly RetrievalChannel[];
  readonly sparseWeight: number;
  readonly denseWeight: number;
  readonly anchorWeight: number;
  readonly learnedSparseWeight?: number;
  readonly sparseTopN: number;
  readonly denseTopN: number;
  readonly fusionK: number;
  readonly finalTopK: number;
}

function defineProfile(profileName: LiveRetrievalProfileName): RetrievalProfile {
  const definition = getLiveRetrievalProfileDefinition(profileName);
  return {
    name: profileName,
    channelMix: definition.channelMix,
    sparseWeight: definition.sparseWeight,
    denseWeight: definition.denseWeight,
    anchorWeight: definition.anchorWeight,
    ...(definition.learnedSparseWeight !== undefined
      ? { learnedSparseWeight: definition.learnedSparseWeight }
      : {}),
    sparseTopN: definition.sparseTopN,
    denseTopN: definition.denseTopN,
    fusionK: definition.fusionK,
    finalTopK: definition.finalTopK,
  };
}

const HYBRID_DEFAULT = defineProfile('hybrid_default');
const MIXED_ANCHOR = defineProfile('mixed_anchor');
const RECOMMENDATION_ANCHOR = defineProfile('recommendation_anchor');
const EXACT_SAFE_FALLBACK = defineProfile('exact_safe_fallback');
const ENTITY_ANCHOR_FIRST = defineProfile('entity_anchor_first');
const BROWSE_DEFAULT = defineProfile('browse_default');
const REGION_BROWSE = defineProfile('region_browse');
const COMPARE_DEFAULT = defineProfile('compare_default');
const LEARNED_SPARSE_HYBRID = defineProfile('learned_sparse_hybrid');
const RELATIVE_FILTER = defineProfile('relative_filter');

export const RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON = 1e-6;

export function validateRetrievalProfile(
  profile: RetrievalProfile,
  profileName?: string,
): void {
  const label = profileName ?? profile.name;
  const learnedSparseWeight = profile.learnedSparseWeight ?? 0;
  const lanes: ReadonlyArray<readonly [string, number]> = [
    ['sparseWeight', profile.sparseWeight],
    ['denseWeight', profile.denseWeight],
    ['anchorWeight', profile.anchorWeight],
    ['learnedSparseWeight', learnedSparseWeight],
  ];
  for (const [name, weight] of lanes) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new DomainError(
        'INTERNAL_INCONSISTENCY',
        `RetrievalProfile "${label}": ${name} must be a finite non-negative number, got ${weight}`,
      );
    }
  }
  const sum =
    profile.sparseWeight +
    profile.denseWeight +
    profile.anchorWeight +
    learnedSparseWeight;
  if (Math.abs(sum - 1.0) > RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON) {
    throw new DomainError(
      'INTERNAL_INCONSISTENCY',
      `RetrievalProfile "${label}": lane weights must sum to 1.0 ± ${RETRIEVAL_PROFILE_WEIGHT_SUM_EPSILON}, got ${sum} ` +
        `(sparse=${profile.sparseWeight}, dense=${profile.denseWeight}, anchor=${profile.anchorWeight}, learnedSparse=${learnedSparseWeight})`,
    );
  }
}

const ALL_DEFINED_PROFILES: readonly RetrievalProfile[] = [
  HYBRID_DEFAULT,
  MIXED_ANCHOR,
  RECOMMENDATION_ANCHOR,
  EXACT_SAFE_FALLBACK,
  ENTITY_ANCHOR_FIRST,
  BROWSE_DEFAULT,
  REGION_BROWSE,
  COMPARE_DEFAULT,
  LEARNED_SPARSE_HYBRID,
  RELATIVE_FILTER,
];

for (const profile of ALL_DEFINED_PROFILES) {
  validateRetrievalProfile(profile);
}

const PROFILE_REGISTRY: ReadonlyMap<LiveRetrievalProfileName, RetrievalProfile> = new Map(
  ALL_DEFINED_PROFILES.map((profile) => [profile.name as LiveRetrievalProfileName, profile] as const),
);

function profileFromName(profileName: LiveRetrievalProfileName): RetrievalProfile {
  const profile = PROFILE_REGISTRY.get(profileName);
  if (profile === undefined) {
    throw new DomainError(
      'INTERNAL_INCONSISTENCY',
      `Unknown live retrieval profile: ${profileName}`,
    );
  }
  return profile;
}

function throwUnknownRetrievalMode(retrievalMode: string): never {
  throw new DomainError(
    'INTERNAL_INCONSISTENCY',
    `Unknown retrievalMode: ${retrievalMode}`,
  );
}

export class RetrievalProfileService {
  private resolveExecutionProfile(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
  ): RetrievalProfile {
    if (retrievalMode !== undefined) {
      if (!isLegacyHeuristicRetrievalModeAlias(retrievalMode)) {
        const profileName = resolveLiveProfileNameForRetrievalMode(retrievalMode);
        if (profileName === undefined) {
          throwUnknownRetrievalMode(retrievalMode);
        }
        return profileFromName(profileName);
      }
    }

    return profileFromName(resolveFallbackLiveProfileName(queryClass, route));
  }

  getProfile(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
    queryFamily?: QueryFamily,
  ): RetrievalProfile {
    if (queryFamily !== undefined && retrievalMode === undefined) {
      return profileFromName(resolveLiveQueryFamilyPolicy(queryFamily).profileName);
    }

    return this.resolveExecutionProfile(queryClass, route, retrievalMode);
  }

  getChannelMix(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
    queryFamily?: QueryFamily,
  ): readonly RetrievalChannel[] {
    return this.getProfile(queryClass, route, retrievalMode, queryFamily).channelMix;
  }

  getExecutionProfile(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
  ): RetrievalProfile {
    return this.resolveExecutionProfile(queryClass, route, retrievalMode);
  }

  getExecutionChannelMix(
    queryClass: QueryClass,
    route: string,
    retrievalMode?: string,
  ): readonly RetrievalChannel[] {
    return this.getExecutionProfile(queryClass, route, retrievalMode).channelMix;
  }
}
