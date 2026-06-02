import { DomainError } from '../../shared/error/domain-error.js';
import type { ProposalKind } from './proposal.js';

/**
 * Curation write-plane error taxonomy (T-ELV2-07). Codes are mapped to HTTP
 * status by the error-handler (PROPOSAL_NOT_FOUND→404, PROPOSAL_CONFLICT→409).
 * {@link IllegalProposalTransitionError} lives in proposal.ts (it is raised by
 * the transition graph itself).
 */

export class ProposalNotFoundError extends DomainError {
  constructor(kind: ProposalKind, proposalId: string) {
    super('PROPOSAL_NOT_FOUND', `No ${kind} proposal with id "${proposalId}".`);
    this.name = 'ProposalNotFoundError';
  }
}

/**
 * Raised when an optimistic transition lost a race — the row was no longer in
 * the expected state when the guarded UPDATE ran (concurrent reviewer).
 */
export class ProposalConflictError extends DomainError {
  constructor(kind: ProposalKind, proposalId: string) {
    super('PROPOSAL_CONFLICT', `The ${kind} proposal "${proposalId}" changed concurrently.`);
    this.name = 'ProposalConflictError';
  }
}
