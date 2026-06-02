/**
 * CurationUseCase — application seam for the lookup-V2 operator curation plane
 * (T-ELV2-07). The HTTP ops routes delegate here; this orchestrates the domain
 * transition rules over the {@link CurationStorePort}.
 *
 * Lifecycle discipline (RFC §5): a proposal is `pending` → reviewer `approve`/
 * `reject` → an approved proposal is `published` (a STAGING marker only; the
 * snapshot ETL materialises it into the runtime plane). Every transition is
 * checked against the domain graph (`assertTransition`) and applied with an
 * optimistic guard; a lost race surfaces as a 409, never a silent no-op.
 */

import {
  assertTransition,
  reviewDecisionToStatus,
  type AliasProposal,
  type AmbiguityProposal,
  type Proposal,
  type ProposalKind,
  type ReviewDecision,
  type SuppressionProposal,
} from '../../domain/curation/model/proposal.js';
import {
  ProposalConflictError,
  ProposalNotFoundError,
} from '../../domain/curation/model/curation-errors.js';
import type {
  AliasAuditView,
  CreateAliasProposalInput,
  CreateAmbiguityProposalInput,
  CreateSuppressionProposalInput,
  CurationHealth,
  CurationStorePort,
  ProposalListFilter,
} from '../../domain/curation/port/curation-store.port.js';

/** Operator-supplied review command. */
export interface ReviewProposalCommand {
  readonly kind: ProposalKind;
  readonly proposalId: string;
  readonly decision: ReviewDecision;
  readonly reviewedBy: string;
  readonly decisionReason: string;
}

/** Operator-supplied publish command (approved → published). */
export interface PublishProposalCommand {
  readonly kind: ProposalKind;
  readonly proposalId: string;
  readonly reviewedBy: string;
  readonly targetSnapshotVersion?: string;
}

export class CurationUseCase {
  constructor(
    private readonly store: CurationStorePort,
    /** Injected clock — defaults to wall time; overridable in tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  submitAliasProposal(input: CreateAliasProposalInput): Promise<AliasProposal> {
    return this.store.createAliasProposal(input);
  }

  submitAmbiguityProposal(input: CreateAmbiguityProposalInput): Promise<AmbiguityProposal> {
    return this.store.createAmbiguityProposal(input);
  }

  submitSuppressionProposal(input: CreateSuppressionProposalInput): Promise<SuppressionProposal> {
    return this.store.createSuppressionProposal(input);
  }

  listProposals(filter: ProposalListFilter): Promise<readonly Proposal[]> {
    return this.store.listProposals(filter);
  }

  aliasAudit(entityId: string): Promise<AliasAuditView> {
    return this.store.aliasAudit(entityId);
  }

  curationHealth(): Promise<CurationHealth> {
    return this.store.getCurationHealth();
  }

  /** Approve or reject a proposal (must be `pending`). */
  async reviewProposal(command: ReviewProposalCommand): Promise<Proposal> {
    const current = await this.store.getProposal(command.kind, command.proposalId);
    if (current === null) {
      throw new ProposalNotFoundError(command.kind, command.proposalId);
    }
    const to = reviewDecisionToStatus(command.decision);
    // Domain legality first (throws IllegalProposalTransitionError → 409).
    assertTransition(current.status, to);

    const updated = await this.store.transitionProposal(command.kind, command.proposalId, {
      expectedFrom: current.status,
      to,
      reviewedBy: command.reviewedBy,
      reviewedAt: this.now(),
      decisionReason: command.decisionReason,
    });
    if (updated === null) {
      // The row changed between read and guarded update — lost the race.
      throw new ProposalConflictError(command.kind, command.proposalId);
    }
    return updated;
  }

  /** Publish an approved proposal (staging marker; ETL materialises it). */
  async publishProposal(command: PublishProposalCommand): Promise<Proposal> {
    const current = await this.store.getProposal(command.kind, command.proposalId);
    if (current === null) {
      throw new ProposalNotFoundError(command.kind, command.proposalId);
    }
    assertTransition(current.status, 'published');

    const updated = await this.store.transitionProposal(command.kind, command.proposalId, {
      expectedFrom: current.status,
      to: 'published',
      reviewedBy: command.reviewedBy,
      publishedAt: this.now(),
      ...(command.targetSnapshotVersion !== undefined
        ? { targetSnapshotVersion: command.targetSnapshotVersion }
        : {}),
    });
    if (updated === null) {
      throw new ProposalConflictError(command.kind, command.proposalId);
    }
    return updated;
  }
}
