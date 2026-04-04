import type { EntityId } from '../../shared/types/index.js';

/**
 * The type of alias being proposed by the learning loop.
 */
export type ProposedAliasType = 'observed_query_alias';

/**
 * Status of an alias proposal as it moves through the promotion pipeline.
 *
 * - `pending`  — proposed, awaiting review or auto-approval.
 * - `approved` — cleared by the promotion gate, ready for shadow testing.
 * - `rejected` — rejected by the promotion gate or human review.
 * - `promoted` — deployed to the live alias table (RFC-003).
 */
export type AliasProposalStatus = 'pending' | 'approved' | 'rejected' | 'promoted';

/**
 * Statistical evidence supporting an alias proposal.
 */
export interface AliasProposalEvidence {
  /** Number of distinct queries that led to this alias being proposed. */
  readonly queryCount: number;

  /** Click-through rate for the entity when this query was used. */
  readonly clickThroughRate: number;

  /** Fraction of sessions using this query that ended successfully. */
  readonly sessionSuccessRate: number;
}

/**
 * A proposed alias from the learning loop, per RFC-010 §4.
 *
 * When users repeatedly search for query Q and consistently interact
 * with entity E, the learning loop proposes Q as an observed query alias
 * for E. Proposals must pass the promotion gate (adversarial checks,
 * minimum evidence thresholds) before being added to the alias table.
 */
export interface AliasProposal {
  /** Unique identifier for this proposal. */
  readonly proposalId: string;

  /** The surface form (query text) to register as an alias. */
  readonly surfaceForm: string;

  /** The target entity this alias should resolve to. */
  readonly targetEntityId: EntityId;

  /** The type of alias being proposed. Always 'observed_query_alias' for learning-derived aliases. */
  readonly proposedType: ProposedAliasType;

  /** Statistical evidence supporting this proposal. */
  readonly evidence: AliasProposalEvidence;

  /** Confidence score for this proposal in [0, 1]. */
  readonly confidence: number;

  /** Current status in the promotion pipeline. */
  readonly status: AliasProposalStatus;

  /** When this proposal was created. */
  readonly createdAt: Date;
}
