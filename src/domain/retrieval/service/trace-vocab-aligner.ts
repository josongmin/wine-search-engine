/**
 * T3.6: Trace / Observability Alignment
 *
 * Maps runtime retrieval traces (CandidateEnvelope) to the canonical
 * EvalProvenanceSlice vocabulary for offline eval alignment.
 *
 * Also provides vocab validation so log pipelines can detect drift
 * between runtime and eval vocabularies early.
 */

import type {
  CandidateEnvelope,
  CandidateChannel,
  CandidateProvenance,
} from '../model/candidate-envelope.js';
import type { EvalProvenanceSlice, ProvenanceChannel } from '../model/provenance.js';
import { isProvenanceChannel, PROVENANCE_CHANNELS } from '../model/provenance.js';
import {
  preferCanonicalRetrievalChannelLabel,
  preferCanonicalRetrievalChannelLabels,
} from '../model/retrieval-channel.js';
import type { RankedResult } from '../../ranking/model/ranked-result.js';

interface ProvenanceCarrier {
  readonly entityId: string;
  readonly provenance: CandidateProvenance;
}

/**
 * Convert a runtime CandidateChannel to its canonical ProvenanceChannel.
 * Falls back to null if the channel is not recognized in the eval vocabulary.
 */
function toCanonicalChannel(ch: CandidateChannel): ProvenanceChannel | null {
  const mapped = preferCanonicalRetrievalChannelLabel(ch);
  return isProvenanceChannel(mapped) ? mapped : null;
}

/**
 * Pick the "top channel" — the channel with the highest rrfContribution.
 * Falls back to the first recognized channel if no scores are present.
 */
function pickTopChannel(candidate: ProvenanceCarrier): ProvenanceChannel | null {
  let topChannel: CandidateChannel | null = null;
  let topContribution = -Infinity;

  for (const ev of candidate.provenance.channelScores) {
    if (ev.rrfContribution > topContribution) {
      topContribution = ev.rrfContribution;
      topChannel = ev.channel;
    }
  }

  if (topChannel === null) {
    // Fallback: pick first channel in the channels list
    const first = candidate.provenance.channels[0];
    return first !== undefined ? toCanonicalChannel(first) : null;
  }

  return toCanonicalChannel(topChannel);
}

// ---------------------------------------------------------------------------
// Primary export: trace → eval slice
// ---------------------------------------------------------------------------

/**
 * Convert a ranked CandidateEnvelope to an EvalProvenanceSlice.
 *
 * @param queryId   - Request/query identifier.
 * @param rank      - 1-indexed rank in the final assembled set.
 * @param candidate - The candidate envelope.
 * @returns EvalProvenanceSlice or null if no recognized channels are present.
 */
function carrierToEvalSlice(
  queryId: string,
  rank: number,
  candidate: ProvenanceCarrier,
): EvalProvenanceSlice | null {
  const canonicalChannels: ProvenanceChannel[] = preferCanonicalRetrievalChannelLabels(
    candidate.provenance.channels,
  ).filter(isProvenanceChannel);

  if (canonicalChannels.length === 0) return null;

  const topChannel = pickTopChannel(candidate);
  if (topChannel === null) return null;

  const prov = candidate.provenance;

  return {
    queryId,
    candidateEntityId: candidate.entityId,
    channels: canonicalChannels,
    topChannel,
    anchorConditioned: prov.anchorConditioned,
    protected: prov.protectedInclusionReason !== undefined,
    ...(prov.protectedInclusionReason !== undefined
      ? { protectedReason: prov.protectedInclusionReason }
      : {}),
    fusionScore: prov.fusionScore,
    rank,
  };
}

export function traceToEvalSlice(
  queryId: string,
  rank: number,
  candidate: CandidateEnvelope,
): EvalProvenanceSlice | null {
  return carrierToEvalSlice(queryId, rank, {
    entityId: candidate.entityId,
    provenance: candidate.provenance,
  });
}

export function rankedResultToEvalSlice(
  queryId: string,
  result: RankedResult,
): EvalProvenanceSlice | null {
  if (result.retrievalProvenance === undefined) {
    return null;
  }
  return carrierToEvalSlice(queryId, result.rank, {
    entityId: result.entityId,
    provenance: result.retrievalProvenance,
  });
}

// ---------------------------------------------------------------------------
// Vocabulary validation
// ---------------------------------------------------------------------------

/**
 * Validate that all channels in a trace are recognized in the canonical vocabulary.
 *
 * @returns Array of unrecognized channel names (empty if all valid).
 */
export function validateTraceVocab(candidate: CandidateEnvelope): readonly string[] {
  const unrecognized: string[] = [];
  for (const ch of candidate.provenance.channels) {
    if (!isProvenanceChannel(ch)) {
      unrecognized.push(ch);
    }
  }
  return unrecognized;
}

/**
 * Convert a full candidate set to eval slices, dropping candidates with no
 * recognized channels (returns undefined entries filtered out).
 */
export function candidatesToEvalSlices(
  queryId: string,
  candidates: readonly CandidateEnvelope[],
): readonly EvalProvenanceSlice[] {
  const slices: EvalProvenanceSlice[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const slice = traceToEvalSlice(queryId, i + 1, candidates[i]!);
    if (slice !== null) {
      slices.push(slice);
    }
  }
  return slices;
}

export function rankedResultsToEvalSlices(
  queryId: string,
  rankedResults: readonly RankedResult[],
): readonly EvalProvenanceSlice[] {
  const slices: EvalProvenanceSlice[] = [];
  for (const result of rankedResults) {
    const slice = rankedResultToEvalSlice(queryId, result);
    if (slice !== null) {
      slices.push(slice);
    }
  }
  return slices;
}

/**
 * All recognized canonical channel names (from provenance vocabulary).
 * Useful for log pipeline validation.
 */
export const RECOGNIZED_CHANNELS: readonly ProvenanceChannel[] = PROVENANCE_CHANNELS;
