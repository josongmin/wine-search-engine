import type { AliasType } from '../../alias/model/alias.js';
import type {
  AliasProposal,
  AmbiguityProposal,
  Proposal,
  ProposalKind,
  ProposalStatus,
  SuppressionProposal,
} from '../model/proposal.js';

/**
 * Persistence port for the lookup-V2 curation write plane (T-ELV2-07).
 *
 * Owns the staging tables (alias_proposals / ambiguity_proposals /
 * suppression_proposals) plus read views the operator console needs (alias
 * audit, queue health). Transitions are performed with an OPTIMISTIC guard
 * (`expectedFrom`) so concurrent reviewers cannot double-apply a state change;
 * the legality of a transition is decided by the domain (`canTransition`) before
 * the call, and re-enforced atomically here via the conditional update.
 */

/** Input to create an alias proposal (status defaults to `pending`). */
export interface CreateAliasProposalInput {
  readonly surfaceForm: string;
  readonly targetEntityId: string;
  readonly proposedType: AliasType;
  readonly confidence: number;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly proposedBy?: string;
}

export interface CreateAmbiguityProposalInput {
  readonly normalizedForm: string;
  readonly memberEntityIds: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly proposedBy?: string;
}

export interface CreateSuppressionProposalInput {
  readonly surfaceForm: string;
  readonly targetEntityId?: string;
  readonly reason: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly proposedBy?: string;
}

/** Filter for listing proposals (bounded by `limit`). */
export interface ProposalListFilter {
  readonly kind?: ProposalKind;
  readonly status?: ProposalStatus;
  readonly limit: number;
}

/**
 * Parameters for an atomic, guarded status transition. The update only applies
 * when the row's current status equals `expectedFrom`; otherwise it returns null.
 */
export interface ProposalTransition {
  readonly expectedFrom: ProposalStatus;
  readonly to: ProposalStatus;
  readonly reviewedBy?: string;
  readonly reviewedAt?: Date;
  readonly decisionReason?: string;
  readonly publishedAt?: Date;
  readonly targetSnapshotVersion?: string;
}

/** One existing alias for an entity (audit view). */
export interface AliasAuditAlias {
  readonly aliasId: string;
  readonly surfaceForm: string;
  readonly aliasType: string;
  readonly source: string;
}

/** Alias audit for a single entity: live aliases + open proposals touching it. */
export interface AliasAuditView {
  readonly entityId: string;
  readonly aliases: readonly AliasAuditAlias[];
  readonly relatedProposals: readonly Proposal[];
}

/** Queue health for the operator coverage/health surface. */
export interface CurationHealth {
  readonly queueByStatus: Readonly<Record<ProposalStatus, number>>;
  readonly queueByKind: Readonly<Record<ProposalKind, number>>;
  readonly totalProposals: number;
}

export interface CurationStorePort {
  createAliasProposal(input: CreateAliasProposalInput): Promise<AliasProposal>;
  createAmbiguityProposal(input: CreateAmbiguityProposalInput): Promise<AmbiguityProposal>;
  createSuppressionProposal(input: CreateSuppressionProposalInput): Promise<SuppressionProposal>;

  getProposal(kind: ProposalKind, proposalId: string): Promise<Proposal | null>;
  listProposals(filter: ProposalListFilter): Promise<readonly Proposal[]>;

  /**
   * Atomically transition a proposal. Returns the updated proposal, or null when
   * the optimistic precondition failed (row missing or not in `expectedFrom`).
   */
  transitionProposal(
    kind: ProposalKind,
    proposalId: string,
    transition: ProposalTransition,
  ): Promise<Proposal | null>;

  aliasAudit(entityId: string): Promise<AliasAuditView>;
  getCurationHealth(): Promise<CurationHealth>;
}
