import type { Pool } from 'pg';
import type { ProposalStore } from '../../domain/learning/port/proposal-store.port.js';
import type { AliasProposal, AliasProposalStatus, AliasProposalEvidence } from '../../domain/learning/model/alias-proposal.js';
import type { ProposedAliasType } from '../../domain/learning/model/alias-proposal.js';
import type { ThresholdProposal, ThresholdProposalStatus, ThresholdSet, ThresholdProposalEvidence } from '../../domain/learning/model/threshold-proposal.js';
import { createCanonicalEntityId } from '../../domain/shared/types/index.js';
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

/** Narrow unknown to Record for JSONB field access (Rule 11). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Runtime guard for AliasProposalEvidence JSONB (Rule 11: never cast JSONB directly). */
function toAliasProposalEvidence(raw: unknown): AliasProposalEvidence {
  if (
    isRecord(raw) &&
    typeof raw['queryCount'] === 'number' &&
    typeof raw['clickThroughRate'] === 'number' &&
    typeof raw['sessionSuccessRate'] === 'number'
  ) {
    return {
      queryCount: raw['queryCount'],
      clickThroughRate: raw['clickThroughRate'],
      sessionSuccessRate: raw['sessionSuccessRate'],
    };
  }
  // Fallback: return safe defaults so the store doesn't crash on legacy/corrupted rows.
  return { queryCount: 0, clickThroughRate: 0, sessionSuccessRate: 0 };
}

function rowToAliasProposal(row: AliasProposalRow): AliasProposal {
  return {
    proposalId: row.proposal_id,
    surfaceForm: row.surface_form,
    targetEntityId: createCanonicalEntityId(row.target_entity_id),
    proposedType: toProposedAliasType(row.proposed_type),
    evidence: toAliasProposalEvidence(row.evidence),
    confidence: row.confidence,
    status: toAliasProposalStatus(row.status),
    createdAt: row.created_at,
  };
}

/** Runtime guard for ThresholdSet JSONB (Rule 11: never cast JSONB directly). */
function toThresholdSet(raw: unknown): ThresholdSet {
  if (
    isRecord(raw) &&
    typeof raw['tResolve'] === 'number' &&
    typeof raw['tGap'] === 'number' &&
    typeof raw['tFail'] === 'number'
  ) {
    return { tResolve: raw['tResolve'], tGap: raw['tGap'], tFail: raw['tFail'] };
  }
  return { tResolve: 0, tGap: 0, tFail: 0 };
}

/** Runtime guard for ThresholdProposalEvidence JSONB (Rule 11). */
function toThresholdProposalEvidence(raw: unknown): ThresholdProposalEvidence {
  if (
    isRecord(raw) &&
    typeof raw['evalCaseCount'] === 'number' &&
    typeof raw['utilityBefore'] === 'number' &&
    typeof raw['utilityAfter'] === 'number'
  ) {
    return {
      evalCaseCount: raw['evalCaseCount'],
      utilityBefore: raw['utilityBefore'],
      utilityAfter: raw['utilityAfter'],
    };
  }
  return { evalCaseCount: 0, utilityBefore: 0, utilityAfter: 0 };
}

function rowToThresholdProposal(row: ThresholdProposalRow): ThresholdProposal {
  return {
    proposalId: row.proposal_id,
    queryClass: isQueryClass(row.query_class) ? row.query_class : 'unknown',
    proposedThresholds: toThresholdSet(row.proposed_thresholds),
    currentThresholds: toThresholdSet(row.current_thresholds),
    expectedUtilityDelta: row.expected_utility_delta,
    evidence: toThresholdProposalEvidence(row.evidence),
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
