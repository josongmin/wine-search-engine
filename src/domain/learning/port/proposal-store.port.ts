import type { AliasProposal, AliasProposalStatus } from '../model/alias-proposal.js';
import type { ThresholdProposal, ThresholdProposalStatus } from '../model/threshold-proposal.js';

/**
 * Port for persisting and retrieving alias and threshold proposals,
 * per RFC-010 §4/§8.
 *
 * Proposals are the learning loop's output — suggested changes that
 * must pass through the promotion gate before affecting production.
 */
export interface ProposalStore {
  /**
   * Persists a new alias proposal.
   *
   * @param proposal - The alias proposal to save.
   */
  saveAliasProposal(proposal: AliasProposal): Promise<void>;

  /**
   * Persists a new threshold proposal.
   *
   * @param proposal - The threshold proposal to save.
   */
  saveThresholdProposal(proposal: ThresholdProposal): Promise<void>;

  /**
   * Retrieves all alias proposals with status 'pending'.
   *
   * @returns Pending alias proposals, ordered by creation date ascending.
   */
  getPendingAliasProposals(): Promise<readonly AliasProposal[]>;

  /**
   * Retrieves all threshold proposals with status 'pending' or 'shadow_testing'.
   *
   * @returns Pending threshold proposals, ordered by creation date ascending.
   */
  getPendingThresholdProposals(): Promise<readonly ThresholdProposal[]>;

  /**
   * Updates the status of a proposal (alias or threshold).
   *
   * @param proposalId - The proposal to update.
   * @param status - The new status.
   */
  updateProposalStatus(
    proposalId: string,
    status: AliasProposalStatus | ThresholdProposalStatus,
  ): Promise<void>;
}
