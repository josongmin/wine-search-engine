/**
 * Wire types for the entity-lookup-V2 operator plane (`/v2/entity-lookup/ops/*`).
 * Mirrors src/interface/http/schemas/entity-lookup-v2-ops.schema.ts (snake_case).
 */

export type ProposalKind = 'alias' | 'ambiguity' | 'suppression';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'published';

interface ProposalLifecycle {
  proposal_id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  evidence: Record<string, unknown>;
  proposed_by?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  decision_reason?: string;
  published_at?: string;
  target_snapshot_version?: string;
  created_at: string;
  updated_at: string;
}

export interface AliasProposalWire extends ProposalLifecycle {
  kind: 'alias';
  surface_form: string;
  target_entity_id: string;
  proposed_type: string;
  confidence: number;
}
export interface AmbiguityProposalWire extends ProposalLifecycle {
  kind: 'ambiguity';
  normalized_form: string;
  member_entity_ids: string[];
}
export interface SuppressionProposalWire extends ProposalLifecycle {
  kind: 'suppression';
  surface_form: string;
  target_entity_id?: string;
  reason: string;
}
export type ProposalWire = AliasProposalWire | AmbiguityProposalWire | SuppressionProposalWire;

export interface ProposalResponse {
  proposal: ProposalWire;
}
export interface ListProposalsResponse {
  proposals: ProposalWire[];
}

export interface AliasAuditResponse {
  entity_id: string;
  aliases: { alias_id: string; surface_form: string; alias_type: string; source: string }[];
  related_proposals: ProposalWire[];
}

export interface CoverageHealthResponse {
  queue_by_status: Record<ProposalStatus, number>;
  queue_by_kind: Record<ProposalKind, number>;
  total_proposals: number;
  published_awaiting_materialization: number;
  legacy_approved_abbreviation_backlog: number;
  lookup_runtime?: {
    search_snapshot_id?: string;
    family_graph_edge_count: number;
    ltr_support_status: 'unsupported';
    ltr_support_reason: 'lookup_domain_model_absent';
    unwired_substrate_ids: readonly string[];
  };
}

export interface ListProposalsRequest {
  kind?: ProposalKind;
  status?: ProposalStatus;
  limit?: number;
}

export interface SubmitAliasProposalRequest {
  kind: 'alias';
  surface_form: string;
  target_entity_id: string;
  proposed_type: string;
  confidence: number;
  evidence: Record<string, unknown>;
  proposed_by?: string;
}
export interface SubmitSuppressionProposalRequest {
  kind: 'suppression';
  surface_form: string;
  target_entity_id?: string;
  reason: string;
  evidence: Record<string, unknown>;
  proposed_by?: string;
}
export interface SubmitAmbiguityProposalRequest {
  kind: 'ambiguity';
  normalized_form: string;
  member_entity_ids: string[];
  evidence: Record<string, unknown>;
  proposed_by?: string;
}
export type SubmitProposalRequest =
  | SubmitAliasProposalRequest
  | SubmitSuppressionProposalRequest
  | SubmitAmbiguityProposalRequest;

export interface ReviewProposalRequest {
  kind: ProposalKind;
  proposal_id: string;
  decision: 'approve' | 'reject';
  reviewed_by: string;
  decision_reason: string;
}
export interface PublishProposalRequest {
  kind: ProposalKind;
  proposal_id: string;
  reviewed_by: string;
  target_snapshot_version?: string;
}

/** The decision-spine response (same shape as the public /v2/entity-lookup). */
export interface OpsInspectResponse {
  status: string;
  decision_reason: string;
  candidates: {
    entity_id: string;
    canonical_label: string;
    calibrated_score: number;
    rank: number;
  }[];
  top_candidate: { entity_id: string; canonical_label: string } | null;
  evidence_summary: {
    admission_reason_code: string;
    decision_reason_code: string;
    top_confidence?: number;
    top1_top2_margin?: number;
    calibration_trusted: boolean;
    query_class: string;
    candidate_pool_size: number;
    channel_coverage: { channel: string; firing: boolean; hit_count: number; latency_ms: number }[];
  };
}
