/**
 * Project Entity Lookup V2 candidate channel hits into resolver-shaped identity
 * artifacts so search post-route phases can reuse the existing entity-route
 * ranked-result and decision-input builders without a parallel evidence model.
 */

import {
  classifyResolveEvidenceGrade,
  LOOKUP_IDENTITY_GRADE_CHANNELS,
} from '../../../domain/resolver/v2/channel-provenance.js';
import type {
  AliasMatchInfo,
  ResolverCandidate,
  ResolvedCandidate,
} from '../../../domain/resolver/model/resolved-candidate.js';
import type { MatchSignalSet } from '../../../domain/resolver/model/match-signal-set.js';
import { createCanonicalEntityId } from '../../../domain/shared/types/index.js';
import type { LookupV2CandidateView, LookupV2ChannelHitView } from './entity-lookup-v2.dto.js';
import type { EntityLookupV2Result } from './entity-lookup-v2.dto.js';
import { FUZZY_EDIT_DISTANCE_CONFIDENCE_FACTOR } from '../../../domain/resolver/model/fuzzy-match-confidence.js';

const V2_ZERO_SIGNALS: MatchSignalSet = {
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
};

function readChannelHitAliasSurface(hit: LookupV2ChannelHitView): string | undefined {
  const matchedAlias = hit.matchedAlias?.trim();
  if (matchedAlias !== undefined && matchedAlias.length > 0) {
    return matchedAlias;
  }
  const matchedView = hit.matchedView.trim();
  return matchedView.length > 0 ? matchedView : undefined;
}

/** Alias-match surfaces derived from declared V2 channel hits. */
export function projectV2AliasMatches(
  channelHits: readonly LookupV2ChannelHitView[],
): readonly AliasMatchInfo[] {
  const seen = new Set<string>();
  const matches: AliasMatchInfo[] = [];

  for (const hit of channelHits) {
    const aliasValue = readChannelHitAliasSurface(hit);
    if (aliasValue === undefined) {
      continue;
    }
    const dedupeKey = aliasValue.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    matches.push({
      aliasValue,
      matchScore: hit.channelScore,
    });
  }

  return matches;
}

/** Rank-1 V2 candidate — official top or first surfaced row when V2 abstained. */
export function projectV2RankOneCandidate(
  v2Result: EntityLookupV2Result,
): LookupV2CandidateView | undefined {
  if (v2Result.topCandidate !== null) {
    return v2Result.topCandidate;
  }
  return v2Result.candidates.find((candidate) => candidate.rank === 1)
    ?? v2Result.candidates[0];
}

function bestChannelScore(channelHits: readonly LookupV2ChannelHitView[]): number {
  let bestScore = 0;
  for (const hit of channelHits) {
    if (hit.channelScore > bestScore) {
      bestScore = hit.channelScore;
    }
  }
  return bestScore;
}

/**
 * Confidence for decision-engine wiring when V2 abstains but still surfaced
 * candidates (advisory head — terminal V2 status unchanged).
 */
export function projectV2AdvisoryTopConfidence(
  candidate: LookupV2CandidateView | undefined,
  evidenceTopConfidence: number | undefined,
): number {
  if (evidenceTopConfidence !== undefined && evidenceTopConfidence > 0) {
    return evidenceTopConfidence;
  }
  if (candidate === undefined) {
    return 0;
  }
  if (candidate.calibratedScore > 0) {
    return candidate.calibratedScore;
  }
  return bestChannelScore(candidate.channelHits);
}

/** Evidence refs for resolved candidates — same surface as legacy resolver output. */
export function projectV2EvidenceRefs(
  channelHits: readonly LookupV2ChannelHitView[],
): readonly string[] {
  return projectV2AliasMatches(channelHits).map((match) => match.aliasValue);
}

/** Map V2 channel grades into resolver {@link MatchSignalSet} for exactness tiers. */
export function projectV2SourceSignals(
  channelHits: readonly LookupV2ChannelHitView[],
): MatchSignalSet {
  if (channelHits.length === 0) {
    return V2_ZERO_SIGNALS;
  }

  const grade = classifyResolveEvidenceGrade(channelHits);
  let bestIdentityScore = 0;
  let bestFuzzyScore = 0;
  let bestPhoneticScore = 0;

  for (const hit of channelHits) {
    if (LOOKUP_IDENTITY_GRADE_CHANNELS.has(hit.channel)) {
      if (hit.channelScore > bestIdentityScore) {
        bestIdentityScore = hit.channelScore;
      }
      continue;
    }
    if (hit.channel === 'fuzzy_alias') {
      if (hit.channelScore > bestFuzzyScore) {
        bestFuzzyScore = hit.channelScore;
      }
      continue;
    }
    if (hit.channel === 'jamo_phonetic') {
      if (hit.channelScore > bestPhoneticScore) {
        bestPhoneticScore = hit.channelScore;
      }
    }
  }

  return {
    ...V2_ZERO_SIGNALS,
    aliasExactMatch: grade === 'identity_grade' ? bestIdentityScore : 0,
    aliasFuzzyMatch: bestFuzzyScore,
    phoneticMatch: bestPhoneticScore,
    editDistanceScore: bestFuzzyScore > 0
      ? bestFuzzyScore * FUZZY_EDIT_DISTANCE_CONFIDENCE_FACTOR
      : 0,
  };
}

export function projectV2ResolverCandidate(
  candidate: LookupV2CandidateView,
): ResolverCandidate {
  const aliasMatches = projectV2AliasMatches(candidate.channelHits);

  return {
    entityId: createCanonicalEntityId(candidate.entityId),
    entityType: candidate.entityType ?? 'unknown',
    canonicalLabel: candidate.canonicalLabel,
    aliasMatches,
    sourceSignals: projectV2SourceSignals(candidate.channelHits),
    source: 'entity_lookup',
    sources: ['entity_lookup'],
  };
}

export function projectV2ResolvedCandidate(
  candidate: LookupV2CandidateView,
): ResolvedCandidate {
  return {
    entityId: createCanonicalEntityId(candidate.entityId),
    canonicalLabel: candidate.canonicalLabel,
    calibratedScore: candidate.calibratedScore,
    rank: candidate.rank,
    evidenceRefs: projectV2EvidenceRefs(candidate.channelHits),
  };
}

export function projectV2ResolverCandidates(
  candidates: readonly LookupV2CandidateView[],
): readonly ResolverCandidate[] {
  return candidates.map(projectV2ResolverCandidate);
}
