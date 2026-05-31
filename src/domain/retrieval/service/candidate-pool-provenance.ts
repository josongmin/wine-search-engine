import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type {
  CandidateEnvelope,
  CandidateChannel,
  QueryViewMatch,
} from '../model/candidate-envelope.js';
import { CandidateProvenanceV2Schema } from '../model/retrieval-contract-v2.js';
import {
  RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
  RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
  RETRIEVAL_CHANNEL_LEARNED_SPARSE,
  RETRIEVAL_CHANNEL_SPARSE_BM25,
  preferCanonicalRetrievalChannelLabels,
  toCanonicalCandidateChannel,
} from '../model/retrieval-channel.js';
import { rrfContribution } from '../../shared/utils/rrf.js';
import { bootstrapLogger } from '../../shared/bootstrap-logger.js';

function toCandidateChannels(candidate: HybridCandidate): CandidateChannel[] {
  const channels: CandidateChannel[] = [];
  const seenChannels = new Set<CandidateChannel>();
  const pushChannel = (channel: CandidateChannel): void => {
    if (!seenChannels.has(channel)) {
      seenChannels.add(channel);
      channels.push(channel);
    }
  };
  if (candidate.sparseRank !== undefined) pushChannel(RETRIEVAL_CHANNEL_SPARSE_BM25);
  if (candidate.denseRank !== undefined) pushChannel(RETRIEVAL_CHANNEL_DENSE_SEMANTIC);
  if (candidate.learnedSparseRank !== undefined) pushChannel(RETRIEVAL_CHANNEL_LEARNED_SPARSE);
  if (candidate.anchorRank !== undefined) pushChannel(RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY);

  for (const source of candidate.retrievalTrace.candidateSources) {
    const canonicalSource = toCanonicalCandidateChannel(source);
    if (canonicalSource !== null) {
      pushChannel(canonicalSource);
    }
  }

  return channels;
}

// toCanonicalCandidateChannel + isCandidateChannel: imported from retrieval-channel.ts (SSoT)

function normalizeCandidateChannelScores(
  channelScores: CandidateEnvelope['provenance']['channelScores'],
): CandidateEnvelope['provenance']['channelScores'] {
  return channelScores.flatMap((score) => {
    const canonical = toCanonicalCandidateChannel(score.channel);
    return canonical === null ? [] : [{ ...score, channel: canonical }];
  });
}

function normalizeCandidateQueryViewMatches(
  queryViewMatches: readonly QueryViewMatch[],
): CandidateEnvelope['provenance']['queryViewMatches'] {
  const seen = new Set<string>();
  const normalized: QueryViewMatch[] = [];

  for (const match of queryViewMatches) {
    const canonical = toCanonicalCandidateChannel(match.channel);
    if (canonical === null) {
      continue;
    }
    const next = { ...match, channel: canonical } satisfies QueryViewMatch;
    const key = `${next.viewName}\u0000${next.matchedText}\u0000${next.channel}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(next);
    }
  }

  return normalized;
}

function normalizeCandidateProvenance(
  provenance: CandidateEnvelope['provenance'],
): CandidateEnvelope['provenance'] {
  const channels: CandidateChannel[] = [];
  const seenChannels = new Set<CandidateChannel>();
  for (const channel of provenance.channels) {
    const canonical = toCanonicalCandidateChannel(channel);
    if (canonical !== null && !seenChannels.has(canonical)) {
      seenChannels.add(canonical);
      channels.push(canonical);
    }
  }

  return {
    ...provenance,
    channels,
    channelScores: normalizeCandidateChannelScores(provenance.channelScores),
    queryViewMatches: normalizeCandidateQueryViewMatches(provenance.queryViewMatches),
  };
}

function toCandidateProvenance(
  provenance: CandidateEnvelope['provenance'],
): CandidateEnvelope['provenance'] {
  const normalized = normalizeCandidateProvenance(provenance);
  const result = CandidateProvenanceV2Schema.safeParse(normalized);
  if (!result.success) {
    bootstrapLogger.warn(
      { issues: result.error.issues },
      '[CandidatePool] toCandidateProvenance: schema validation failed — using raw normalized provenance',
    );
    return normalized;
  }
  const parsed = result.data;
  return {
    channels: parsed.channels,
    channelScores: parsed.channelScores,
    queryViewMatches: parsed.queryViewMatches,
    anchorConditioned: parsed.anchorConditioned,
    matchedFilterConstraints: parsed.matchedFilterConstraints,
    ...(parsed.failedHardConstraints !== undefined
      ? { failedHardConstraints: parsed.failedHardConstraints }
      : {}),
    ...(parsed.protectedInclusionReason !== undefined
      ? { protectedInclusionReason: parsed.protectedInclusionReason }
      : {}),
    fusionProfile: parsed.fusionProfile,
    fusionScore: parsed.fusionScore,
  };
}

export function hybridCandidateToEnvelope(
  candidate: HybridCandidate,
  fusionK: number,
): CandidateEnvelope {
  if (candidate.retrievalProvenance !== undefined) {
    const provenance = toCandidateProvenance(candidate.retrievalProvenance);
    return {
      entityId: candidate.entityId,
      provenance,
      legacyCandidate: {
        ...candidate,
        retrievalTrace: {
          ...candidate.retrievalTrace,
          candidateSources: preferCanonicalRetrievalChannelLabels(
            candidate.retrievalTrace.candidateSources,
          ),
        },
      },
    };
  }

  const channels = toCandidateChannels(candidate);
  const channelScores = [];

  // Bugbash 2026-04-09 (Group C): per-channel raw scores must never be
  // fabricated from any fused score. Missing per-channel raw means missing
  // evidence, not "reuse the fusion total".
  // Contract: when a per-channel rank is present but the matching raw is
  // missing, we log a warning and SKIP that channel entry rather than
  // fabricating an incorrect rawScore.
  if (candidate.sparseRank !== undefined) {
    if (candidate.sparseRawScore !== undefined) {
      channelScores.push({
        channel: RETRIEVAL_CHANNEL_SPARSE_BM25,
        rawScore: candidate.sparseRawScore,
        rank: candidate.sparseRank,
        rrfContribution: rrfContribution(candidate.sparseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: RETRIEVAL_CHANNEL_SPARSE_BM25,
          rank: candidate.sparseRank,
        },
        'hybridCandidateToEnvelope: sparse channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.denseRank !== undefined) {
    if (candidate.denseRawScore !== undefined) {
      channelScores.push({
        channel: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
        rawScore: candidate.denseRawScore,
        rank: candidate.denseRank,
        rrfContribution: rrfContribution(candidate.denseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: RETRIEVAL_CHANNEL_DENSE_SEMANTIC,
          rank: candidate.denseRank,
        },
        'hybridCandidateToEnvelope: dense channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.learnedSparseRank !== undefined) {
    if (candidate.learnedSparseRawScore !== undefined) {
      channelScores.push({
        channel: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
        rawScore: candidate.learnedSparseRawScore,
        rank: candidate.learnedSparseRank,
        rrfContribution: rrfContribution(candidate.learnedSparseRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: RETRIEVAL_CHANNEL_LEARNED_SPARSE,
          rank: candidate.learnedSparseRank,
        },
        'hybridCandidateToEnvelope: learned_sparse channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }
  if (candidate.anchorRank !== undefined) {
    if (candidate.anchorRawScore !== undefined) {
      channelScores.push({
        channel: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
        rawScore: candidate.anchorRawScore,
        rank: candidate.anchorRank,
        rrfContribution: rrfContribution(candidate.anchorRank, fusionK),
      });
    } else {
      bootstrapLogger.warn(
        {
          entityId: candidate.entityId,
          channel: RETRIEVAL_CHANNEL_ANCHOR_SIMILARITY,
          rank: candidate.anchorRank,
        },
        'hybridCandidateToEnvelope: anchor channel has rank but no rawScore — skipping channelScores entry (contract violation)',
      );
    }
  }

  const provenance = {
    channels,
    channelScores,
    queryViewMatches: [],
    anchorConditioned: candidate.anchorRank !== undefined,
    matchedFilterConstraints: candidate.matchedConstraints,
    ...(candidate.unmetHardConstraints !== undefined
      ? { failedHardConstraints: candidate.unmetHardConstraints }
      : {}),
    fusionProfile: candidate.retrievalTrace.retrievalProfile,
    // fusionRrfTotal: set by FusionService only. Non-fusion candidates (Browse/Compare/similar)
    // fall back to sparseRawScore (their canonical per-channel score). Default 0 is safe —
    // these candidates are ranked by signal-computer, not by this fallback fusionScore.
    fusionScore: candidate.fusionRrfTotal ?? candidate.sparseRawScore ?? 0,
  } satisfies CandidateEnvelope['provenance'];
  const normalizedProvenance = toCandidateProvenance(provenance);

  return {
    entityId: candidate.entityId,
    provenance: normalizedProvenance,
    legacyCandidate: {
      ...candidate,
      retrievalTrace: {
        ...candidate.retrievalTrace,
        candidateSources: preferCanonicalRetrievalChannelLabels(
          candidate.retrievalTrace.candidateSources,
        ),
      },
      retrievalProvenance: normalizedProvenance,
    },
  };
}
