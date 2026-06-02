import type { AliasType } from '../../alias/model/alias.js';
import { DomainError } from '../../shared/error/domain-error.js';

/**
 * Entity Lookup V2 — curation proposal model (T-ELV2-07).
 *
 * The staged review→publish substrate for operator curation. A proposal is born
 * `pending`, a reviewer moves it to `approved` or `rejected`, and an approved
 * proposal is `published` — a STAGING marker only. Runtime materialisation
 * (writing the alias/ambiguity into the served snapshot) is the snapshot ETL's
 * job, never a direct write from here (RFC §5: runtime-plane direct write 금지).
 *
 * This module is the SSoT for the proposal status/kind vocabulary and the legal
 * state-transition graph; the DB CHECK constraint in migration 030 mirrors the
 * same four states. Pure domain — imports nothing outside the domain.
 */

/** Proposal lifecycle states (SSoT — mirrors migration 030 status CHECK). */
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'published'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export function isProposalStatus(value: string): value is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

/** The three curation artifact kinds, each backed by its own staging table. */
export const PROPOSAL_KINDS = ['alias', 'ambiguity', 'suppression'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export function isProposalKind(value: string): value is ProposalKind {
  return (PROPOSAL_KINDS as readonly string[]).includes(value);
}

/**
 * Legal lifecycle transitions. `rejected` and `published` are terminal.
 * - pending  → approved | rejected   (review decision)
 * - approved → published | rejected  (publish, or revoke before publish)
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  pending: ['approved', 'rejected'],
  approved: ['published', 'rejected'],
  rejected: [],
  published: [],
};

/** True iff moving a proposal from `from` to `to` is a legal lifecycle step. */
export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Thrown when an illegal lifecycle transition is attempted (e.g. publish a pending proposal). */
export class IllegalProposalTransitionError extends DomainError {
  constructor(from: ProposalStatus, to: ProposalStatus) {
    super(
      'ILLEGAL_PROPOSAL_TRANSITION',
      `Cannot transition curation proposal from "${from}" to "${to}".`,
    );
    this.name = 'IllegalProposalTransitionError';
  }
}

/** Asserts the transition is legal; throws {@link IllegalProposalTransitionError} otherwise. */
export function assertTransition(from: ProposalStatus, to: ProposalStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalProposalTransitionError(from, to);
  }
}

/** A reviewer's decision on a pending proposal. */
export type ReviewDecision = 'approve' | 'reject';

/** Maps a review decision to its target lifecycle status. */
export function reviewDecisionToStatus(decision: ReviewDecision): ProposalStatus {
  return decision === 'approve' ? 'approved' : 'rejected';
}

/** Fields common to every proposal kind (the lifecycle/audit spine). */
export interface ProposalBase {
  readonly proposalId: string;
  readonly status: ProposalStatus;
  /** Free-form provenance/justification payload (JSONB). */
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly proposedBy?: string;
  readonly reviewedBy?: string;
  readonly reviewedAt?: Date;
  readonly decisionReason?: string;
  readonly publishedAt?: Date;
  readonly targetSnapshotVersion?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AliasProposal extends ProposalBase {
  readonly kind: 'alias';
  readonly surfaceForm: string;
  readonly targetEntityId: string;
  readonly proposedType: AliasType;
  readonly confidence: number;
}

export interface AmbiguityProposal extends ProposalBase {
  readonly kind: 'ambiguity';
  readonly normalizedForm: string;
  readonly memberEntityIds: readonly string[];
}

export interface SuppressionProposal extends ProposalBase {
  readonly kind: 'suppression';
  readonly surfaceForm: string;
  readonly targetEntityId?: string;
  readonly reason: string;
}

export type Proposal = AliasProposal | AmbiguityProposal | SuppressionProposal;
