import { z } from 'zod';
import { RETRIEVAL_CHANNELS } from './retrieval-channel.js';

/** Max number of retrieval channels attached to one candidate provenance. */
export const RETRIEVAL_CHANNELS_PER_CANDIDATE_MAX = 8;
/** Max channel-score evidence entries per candidate provenance. */
export const RETRIEVAL_CHANNEL_SCORE_EVIDENCE_MAX = 16;
/** Max query-view matches per candidate provenance. */
export const RETRIEVAL_QUERY_VIEW_MATCHES_MAX = 32;
/**
 * Max constraint identifiers attached per candidate (matched + failed hard).
 * 64 is generous: typical wine queries have ≤8 constraints; the cap exists
 * to bound provenance payload size on adversarial query plans.
 */
const RETRIEVAL_PROVENANCE_CONSTRAINT_LIST_MAX = 64;

export const RetrievalChannelSchema = z.enum(RETRIEVAL_CHANNELS);

export const ChannelScoreEvidenceV2Schema = z.object({
  channel: RetrievalChannelSchema,
  rawScore: z.number().finite(),
  rank: z.number().int().positive(),
  rrfContribution: z.number().finite().min(0),
}).strict();

export const QueryViewMatchV2Schema = z.object({
  viewName: z.string().min(1),
  matchedText: z.string().min(1),
  channel: RetrievalChannelSchema,
}).strict();

export const CandidateProvenanceV2Schema = z.object({
  channels: z.array(RetrievalChannelSchema).max(RETRIEVAL_CHANNELS_PER_CANDIDATE_MAX),
  channelScores: z.array(ChannelScoreEvidenceV2Schema).max(RETRIEVAL_CHANNEL_SCORE_EVIDENCE_MAX),
  queryViewMatches: z.array(QueryViewMatchV2Schema).max(RETRIEVAL_QUERY_VIEW_MATCHES_MAX),
  anchorConditioned: z.boolean(),
  matchedFilterConstraints: z.array(z.string()).max(RETRIEVAL_PROVENANCE_CONSTRAINT_LIST_MAX),
  failedHardConstraints: z
    .array(z.string())
    .max(RETRIEVAL_PROVENANCE_CONSTRAINT_LIST_MAX)
    .optional(),
  protectedInclusionReason: z
    .enum([
      'exact_alias_match',
      'known_item_lookup',
      'anchor_conditioned',
      'hard_constraint_compatible',
      'diversity_slot',
    ])
    .optional(),
  fusionProfile: z.string().min(1),
  fusionScore: z.number().finite(),
}).strict();

export type CandidateProvenanceV2 = z.infer<typeof CandidateProvenanceV2Schema>;

