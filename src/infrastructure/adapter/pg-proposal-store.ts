import type { Pool } from 'pg';
import type { ProposalStore } from '../../domain/learning/port/proposal-store.port.js';
import type { AliasProposal, AliasProposalStatus, AliasProposalEvidence } from '../../domain/learning/model/alias-proposal.js';
import type { ProposedAliasType } from '../../domain/learning/model/alias-proposal.js';
import type { ThresholdProposal, ThresholdProposalStatus, ThresholdSet, ThresholdProposalEvidence } from '../../domain/learning/model/threshold-proposal.js';
import { createEntityId } from '../../domain/shared/types/index.js';
import { isQueryClass } from '../../domain/shared/types/query-class.js';

function toProposedAliasType(value: string): ProposedAliasType {
  if (value === 'observed_query_alias') return value;
  return 'observed_query_alias';
}

function toAliasProposalStatus(value: string): AliasProposalStatus {
  if (value === 'pending' || value === 'approved' || value === 'rejected' || value === 'promoted') return value;
  return 'pending';
}

function toThresholdProposalStatus(value: string): ThresholdProposalStatus {
  if (value === 'pending' || value === 'shadow_testing' || value === 'approved' || value === 'rejected') return value;
  return 'pending';
}

interface AliasProposalRow {
  proposal_id: string;
  surface_form: string;
  target_entity_id: string;
  proposed_type: string;
  evidence: unknown;
  confidence: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface ThresholdProposalRow {
  proposal_id: string;
  query_class: string;
  proposed_thresholds: unknown;
  current_thresholds: unknown;
  expected_utility_delta: number;
  evidence: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function rowToAliasProposal(row: AliasProposalRow): AliasProposal {
  return {
    proposalId: row.proposal_id,
    surfaceForm: row.surface_form,
    targetEntityId: createEntityId(row.target_entity_id),
    proposedType: toProposedAliasType(row.proposed_type),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSONB schema validated at write time; full AliasProposalEvidence Zod validation deferred
    evidence: row.evidence as AliasProposalEvidence,
    confidence: row.confidence,
    status: toAliasProposalStatus(row.status),
    createdAt: row.created_at,
  };
}

function rowToThresholdProposal(row: ThresholdProposalRow): ThresholdProposal {
  return {
    proposalId: row.proposal_id,
    queryClass: isQueryClass(row.query_class) ? row.query_class : 'unknown',
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSONB schema validated at write time; full ThresholdSet Zod validation deferred
    proposedThresholds: row.proposed_thresholds as ThresholdSet,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSONB schema validated at write time; full ThresholdSet Zod validation deferred
    currentThresholds: row.current_thresholds as ThresholdSet,
    expectedUtilityDelta: row.expected_utility_delta,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- JSONB schema validated at write time; full ThresholdProposalEvidence Zod validation deferred
    evidence: row.evidence as ThresholdProposalEvidence,
    status: toThresholdProposalStatus(row.status),
  };
}

export class PgProposalStore implements ProposalStore {
  constructor(private readonly pool: Pool) {}

  async saveAliasProposal(proposal: AliasProposal): Promise<void> {
    await this.pool.query(
      `INSERT INTO alias_proposals (
        proposal_id, surface_form, target_entity_id, proposed_type,
        evidence, confidence, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (proposal_id) DO UPDATE SET
        surface_form = EXCLUDED.surface_form,
        target_entity_id = EXCLUDED.target_entity_id,
        proposed_type = EXCLUDED.proposed_type,
        evidence = EXCLUDED.evidence,
        confidence = EXCLUDED.confidence,
        status = EXCLUDED.status,
        updated_at = NOW()`,
      [
        proposal.proposalId,
        proposal.surfaceForm,
        proposal.targetEntityId,
        proposal.proposedType,
        JSON.stringify(proposal.evidence),
        proposal.confidence,
        proposal.status,
        proposal.createdAt,
      ],
    );
  }

  async saveThresholdProposal(proposal: ThresholdProposal): Promise<void> {
    await this.pool.query(
      `INSERT INTO threshold_proposals (
        proposal_id, query_class, proposed_thresholds, current_thresholds,
        expected_utility_delta, evidence, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (proposal_id) DO UPDATE SET
        query_class = EXCLUDED.query_class,
        proposed_thresholds = EXCLUDED.proposed_thresholds,
        current_thresholds = EXCLUDED.current_thresholds,
        expected_utility_delta = EXCLUDED.expected_utility_delta,
        evidence = EXCLUDED.evidence,
        status = EXCLUDED.status,
        updated_at = NOW()`,
      [
        proposal.proposalId,
        proposal.queryClass,
        JSON.stringify(proposal.proposedThresholds),
        JSON.stringify(proposal.currentThresholds),
        proposal.expectedUtilityDelta,
        JSON.stringify(proposal.evidence),
        proposal.status,
      ],
    );
  }

  async getPendingAliasProposals(): Promise<readonly AliasProposal[]> {
    const result = await this.pool.query<AliasProposalRow>(
      `SELECT * FROM alias_proposals WHERE status = 'pending' ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToAliasProposal);
  }

  async getPendingThresholdProposals(): Promise<readonly ThresholdProposal[]> {
    const result = await this.pool.query<ThresholdProposalRow>(
      `SELECT * FROM threshold_proposals
       WHERE status IN ('pending', 'shadow_testing')
       ORDER BY created_at ASC`,
    );
    return result.rows.map(rowToThresholdProposal);
  }

  async updateProposalStatus(
    proposalId: string,
    status: AliasProposalStatus | ThresholdProposalStatus,
  ): Promise<void> {
    // Try alias_proposals first, then threshold_proposals
    const aliasResult = await this.pool.query(
      `UPDATE alias_proposals SET status = $2, updated_at = NOW() WHERE proposal_id = $1`,
      [proposalId, status],
    );
    if ((aliasResult.rowCount ?? 0) === 0) {
      await this.pool.query(
        `UPDATE threshold_proposals SET status = $2, updated_at = NOW() WHERE proposal_id = $1`,
        [proposalId, status],
      );
    }
  }
}
