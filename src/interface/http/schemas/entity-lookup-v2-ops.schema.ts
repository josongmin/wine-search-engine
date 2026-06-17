/**
 * Entity Lookup V2 — operator curation plane HTTP contracts (T-ELV2-07).
 *
 * The trusted operator surface under `/v2/entity-lookup/ops/*`. Reads
 * (alias-audit, coverage-health, proposals list) are X-Debug-Key gated; writes
 * (submit / review / publish) are X-Ops-Write-Key gated at the handler. All
 * objects chain `.strict()`; numeric fields are `.finite()`; arrays carry a
 * domain-justified `.max(N)`. Wire keys are snake_case (RFC-014 house style).
 *
 * These are deliberately all POST-with-body to match the existing
 * `/v2/entity-lookup/ops/inspect` trusted-read contract (no querystring/param
 * plumbing on the internal ops plane).
 */

import { z } from 'zod';
import { ALIAS_TYPES } from '../../../domain/alias/model/alias.js';
import { PROPOSAL_KINDS, PROPOSAL_STATUSES } from '../../../domain/curation/model/proposal.js';
import { LOOKUP_V2_OPS_UNWIRED_SUBSTRATE_IDS_MAX } from '../../../domain/resolver/v2/lookup-v2-substrate-capabilities.js';

// Operator-facing field bounds. Internal trusted surface, so bounds are
// generous but finite (the 1 MiB body limit is the hard ceiling on evidence).
const OPS_ENTITY_ID_MAX = 200;
const OPS_SURFACE_MAX = 200;
const OPS_REASON_MAX = 500;
const OPS_DECISION_REASON_MAX = 500;
const OPS_OPERATOR_MAX = 120;
const OPS_PROPOSAL_ID_MAX = 64;
const OPS_SNAPSHOT_VERSION_MAX = 120;
const OPS_NORMALIZED_FORM_MAX = 200;
const OPS_MEMBER_IDS_MAX = 50;
const OPS_LIST_LIMIT_MAX = 200;
const OPS_LIST_LIMIT_DEFAULT = 50;
const OPS_LIST_RESULT_MAX = 500;
const OPS_AUDIT_ALIASES_MAX = 500;

const ProposalKindSchema = z.enum(PROPOSAL_KINDS);
const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);
const AliasTypeSchema = z.enum(ALIAS_TYPES);
const EvidenceSchema = z.record(z.unknown());
const entityId = () => z.string().min(1).max(OPS_ENTITY_ID_MAX);
const operator = () => z.string().min(1).max(OPS_OPERATOR_MAX);
const proposalId = () => z.string().min(1).max(OPS_PROPOSAL_ID_MAX);

// --- request schemas -------------------------------------------------------

export const AliasAuditRequestSchema = z.object({
  entity_id: entityId(),
}).strict();

export const CoverageHealthRequestSchema = z.object({}).strict();

export const ListProposalsRequestSchema = z.object({
  kind: ProposalKindSchema.optional(),
  status: ProposalStatusSchema.optional(),
  limit: z.number().int().finite().min(1).max(OPS_LIST_LIMIT_MAX).default(OPS_LIST_LIMIT_DEFAULT),
}).strict();

const SubmitAliasProposalSchema = z.object({
  kind: z.literal('alias'),
  surface_form: z.string().min(1).max(OPS_SURFACE_MAX),
  target_entity_id: entityId(),
  proposed_type: AliasTypeSchema,
  confidence: z.number().finite().min(0).max(1),
  evidence: EvidenceSchema,
  proposed_by: operator().optional(),
}).strict();

const SubmitAmbiguityProposalSchema = z.object({
  kind: z.literal('ambiguity'),
  normalized_form: z.string().min(1).max(OPS_NORMALIZED_FORM_MAX),
  member_entity_ids: z.array(entityId()).min(2).max(OPS_MEMBER_IDS_MAX),
  evidence: EvidenceSchema,
  proposed_by: operator().optional(),
}).strict();

const SubmitSuppressionProposalSchema = z.object({
  kind: z.literal('suppression'),
  surface_form: z.string().min(1).max(OPS_SURFACE_MAX),
  target_entity_id: entityId().optional(),
  reason: z.string().min(1).max(OPS_REASON_MAX),
  evidence: EvidenceSchema,
  proposed_by: operator().optional(),
}).strict();

export const SubmitProposalRequestSchema = z.discriminatedUnion('kind', [
  SubmitAliasProposalSchema,
  SubmitAmbiguityProposalSchema,
  SubmitSuppressionProposalSchema,
]);

export const ReviewProposalRequestSchema = z.object({
  kind: ProposalKindSchema,
  proposal_id: proposalId(),
  decision: z.enum(['approve', 'reject']),
  reviewed_by: operator(),
  decision_reason: z.string().min(1).max(OPS_DECISION_REASON_MAX),
}).strict();

export const PublishProposalRequestSchema = z.object({
  kind: ProposalKindSchema,
  proposal_id: proposalId(),
  reviewed_by: operator(),
  target_snapshot_version: z.string().min(1).max(OPS_SNAPSHOT_VERSION_MAX).optional(),
}).strict();

// --- response schemas ------------------------------------------------------

/** Shared lifecycle/audit fields on every proposal wire shape. */
const proposalLifecycleShape = {
  proposal_id: z.string().min(1),
  kind: ProposalKindSchema,
  status: ProposalStatusSchema,
  evidence: EvidenceSchema,
  proposed_by: z.string().min(1).optional(),
  reviewed_by: z.string().min(1).optional(),
  reviewed_at: z.string().min(1).optional(),
  decision_reason: z.string().min(1).optional(),
  published_at: z.string().min(1).optional(),
  target_snapshot_version: z.string().min(1).optional(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
};

const AliasProposalWireSchema = z.object({
  ...proposalLifecycleShape,
  kind: z.literal('alias'),
  surface_form: z.string().min(1),
  target_entity_id: z.string().min(1),
  proposed_type: AliasTypeSchema,
  confidence: z.number().finite(),
}).strict();

const AmbiguityProposalWireSchema = z.object({
  ...proposalLifecycleShape,
  kind: z.literal('ambiguity'),
  normalized_form: z.string().min(1),
  member_entity_ids: z.array(z.string().min(1)).max(OPS_MEMBER_IDS_MAX),
}).strict();

const SuppressionProposalWireSchema = z.object({
  ...proposalLifecycleShape,
  kind: z.literal('suppression'),
  surface_form: z.string().min(1),
  target_entity_id: z.string().min(1).optional(),
  reason: z.string().min(1),
}).strict();

export const ProposalWireSchema = z.discriminatedUnion('kind', [
  AliasProposalWireSchema,
  AmbiguityProposalWireSchema,
  SuppressionProposalWireSchema,
]);

export const ProposalResponseSchema = z.object({
  proposal: ProposalWireSchema,
}).strict();

export const ListProposalsResponseSchema = z.object({
  proposals: z.array(ProposalWireSchema).max(OPS_LIST_RESULT_MAX),
}).strict();

const AliasAuditAliasWireSchema = z.object({
  alias_id: z.string().min(1),
  surface_form: z.string().min(1),
  alias_type: z.string().min(1),
  source: z.string().min(1),
}).strict();

export const AliasAuditResponseSchema = z.object({
  entity_id: z.string().min(1),
  aliases: z.array(AliasAuditAliasWireSchema).max(OPS_AUDIT_ALIASES_MAX),
  related_proposals: z.array(ProposalWireSchema).max(OPS_LIST_RESULT_MAX),
}).strict();

export const CoverageHealthResponseSchema = z.object({
  queue_by_status: z.object({
    pending: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
  }).strict(),
  queue_by_kind: z.object({
    alias: z.number().int().nonnegative(),
    ambiguity: z.number().int().nonnegative(),
    suppression: z.number().int().nonnegative(),
  }).strict(),
  total_proposals: z.number().int().nonnegative(),
  published_awaiting_materialization: z.number().int().nonnegative(),
  legacy_approved_abbreviation_backlog: z.number().int().nonnegative(),
  lookup_runtime: z.object({
    search_snapshot_id: z.string().min(1).optional(),
    family_graph_edge_count: z.number().int().nonnegative(),
    ltr_support_status: z.literal('unsupported'),
    ltr_support_reason: z.literal('lookup_domain_model_absent'),
    unwired_substrate_ids: z.array(z.string().min(1)).max(LOOKUP_V2_OPS_UNWIRED_SUBSTRATE_IDS_MAX),
  }).strict().optional(),
}).strict();

export type SubmitProposalRequest = z.infer<typeof SubmitProposalRequestSchema>;
export type ReviewProposalRequest = z.infer<typeof ReviewProposalRequestSchema>;
export type PublishProposalRequest = z.infer<typeof PublishProposalRequestSchema>;
export type ListProposalsRequest = z.infer<typeof ListProposalsRequestSchema>;
export type ProposalWire = z.infer<typeof ProposalWireSchema>;
