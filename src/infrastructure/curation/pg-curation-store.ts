/**
 * PgCurationStore — PostgreSQL adapter for the lookup-V2 curation write plane
 * (T-ELV2-07), backed by the staging tables from migration 030.
 *
 * Hard guarantees (per CLAUDE.md):
 *   - proposal ids are minted with `crypto.randomUUID()` (never Math.random).
 *   - every JSONB column (evidence, member_entity_ids) is validated with Zod
 *     before any consumer sees it — never `as DomainType` on a raw row.
 *   - status transitions are atomic + optimistic: the UPDATE only applies when
 *     the row is still in `expectedFrom`, so two concurrent reviewers cannot
 *     double-apply a lifecycle step.
 *   - publishing here is a STAGING marker only; runtime materialisation belongs
 *     to the snapshot ETL (RFC §5: runtime-plane direct write 금지).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { pgCurationMaterializationTrackingEnabled } from './curation-materialization-capability.js';
import { readCanonicalCurationEvidence } from '../../domain/curation/model/curation-proposal-evidence.js';
import {
  isProposalStatus,
  type AliasProposal,
  type AmbiguityProposal,
  type Proposal,
  type ProposalKind,
  type ProposalStatus,
  type SuppressionProposal,
} from '../../domain/curation/model/proposal.js';
import { parseAliasType, type AliasType } from '../../domain/alias/model/alias.js';
import type {
  AliasAuditAlias,
  AliasAuditView,
  CreateAliasProposalInput,
  CreateAmbiguityProposalInput,
  CreateSuppressionProposalInput,
  CurationHealth,
  CurationStorePort,
  ProposalListFilter,
  ProposalTransition,
} from '../../domain/curation/port/curation-store.port.js';

/** Upper bound on a single list/audit query so a malformed limit cannot scan the table. */
const MAX_PROPOSAL_LIST_ROWS = 500;

const TABLE_BY_KIND: Readonly<Record<ProposalKind, string>> = {
  alias: 'alias_proposals',
  ambiguity: 'ambiguity_proposals',
  suppression: 'suppression_proposals',
};

// --- row schemas -----------------------------------------------------------

const jsonRecord = z.record(z.unknown());
const dateLike = z.union([z.date(), z.string().min(1)]);
const statusString = z.string().refine(isProposalStatus, { message: 'invalid proposal status' });

/** Lifecycle/audit columns shared by all three staging tables. */
const lifecycleShape = {
  proposal_id: z.string().min(1),
  status: statusString,
  evidence: jsonRecord,
  proposed_by: z.string().min(1).nullable(),
  reviewed_by: z.string().min(1).nullable(),
  reviewed_at: dateLike.nullable(),
  decision_reason: z.string().min(1).nullable(),
  published_at: dateLike.nullable(),
  target_snapshot_version: z.string().min(1).nullable(),
  created_at: dateLike,
  updated_at: dateLike,
};

const AliasProposalRowSchema = z.object({
  ...lifecycleShape,
  surface_form: z.string().min(1),
  target_entity_id: z.string().min(1),
  proposed_type: z.string().min(1),
  confidence: z.coerce.number().finite(),
}).strict();

const AmbiguityProposalRowSchema = z.object({
  ...lifecycleShape,
  normalized_form: z.string().min(1),
  member_entity_ids: z.array(z.string().min(1)),
}).strict();

const SuppressionProposalRowSchema = z.object({
  ...lifecycleShape,
  surface_form: z.string().min(1),
  target_entity_id: z.string().min(1).nullable(),
  reason: z.string().min(1),
}).strict();

const AliasAuditRowSchema = z.object({
  alias_id: z.string().min(1),
  surface_form: z.string().min(1),
  alias_type: z.string().min(1),
  source: z.string().min(1),
}).strict();

const CountRowSchema = z.object({
  status: statusString,
  n: z.coerce.number().int().nonnegative(),
}).strict();

// --- row → domain ----------------------------------------------------------

function toDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) {
    throw new Error(`[PgCurationStore] invalid timestamp value: ${String(value)}`);
  }
  return d;
}

function canonicalEvidenceForKind(
  kind: ProposalKind,
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  return { ...readCanonicalCurationEvidence(kind, evidence) };
}

/** Builds the common lifecycle fields, omitting optional keys that are null (exactOptionalPropertyTypes). */
function lifecycleFields(
  kind: ProposalKind,
  row: z.infer<typeof AliasProposalRowSchema>
    | z.infer<typeof AmbiguityProposalRowSchema>
    | z.infer<typeof SuppressionProposalRowSchema>,
): {
  proposalId: string;
  status: ProposalStatus;
  evidence: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
} & Partial<{
  proposedBy: string;
  reviewedBy: string;
  reviewedAt: Date;
  decisionReason: string;
  publishedAt: Date;
  targetSnapshotVersion: string;
}> {
  return {
    proposalId: row.proposal_id,
    status: row.status,
    evidence: canonicalEvidenceForKind(kind, row.evidence),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    ...(row.proposed_by !== null ? { proposedBy: row.proposed_by } : {}),
    ...(row.reviewed_by !== null ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.reviewed_at !== null ? { reviewedAt: toDate(row.reviewed_at) } : {}),
    ...(row.decision_reason !== null ? { decisionReason: row.decision_reason } : {}),
    ...(row.published_at !== null ? { publishedAt: toDate(row.published_at) } : {}),
    ...(row.target_snapshot_version !== null
      ? { targetSnapshotVersion: row.target_snapshot_version }
      : {}),
  };
}

function rowToAliasProposal(raw: unknown): AliasProposal {
  const row = AliasProposalRowSchema.parse(raw);
  const proposedType: AliasType | undefined = parseAliasType(row.proposed_type);
  if (proposedType === undefined) {
    throw new Error(`[PgCurationStore] unknown alias type "${row.proposed_type}"`);
  }
  return {
    kind: 'alias',
    ...lifecycleFields('alias', row),
    surfaceForm: row.surface_form,
    targetEntityId: row.target_entity_id,
    proposedType,
    confidence: row.confidence,
  };
}

function rowToAmbiguityProposal(raw: unknown): AmbiguityProposal {
  const row = AmbiguityProposalRowSchema.parse(raw);
  return {
    kind: 'ambiguity',
    ...lifecycleFields('ambiguity', row),
    normalizedForm: row.normalized_form,
    memberEntityIds: row.member_entity_ids,
  };
}

function rowToSuppressionProposal(raw: unknown): SuppressionProposal {
  const row = SuppressionProposalRowSchema.parse(raw);
  return {
    kind: 'suppression',
    ...lifecycleFields('suppression', row),
    surfaceForm: row.surface_form,
    reason: row.reason,
    ...(row.target_entity_id !== null ? { targetEntityId: row.target_entity_id } : {}),
  };
}

function rowToProposal(kind: ProposalKind, raw: unknown): Proposal {
  switch (kind) {
    case 'alias':
      return rowToAliasProposal(raw);
    case 'ambiguity':
      return rowToAmbiguityProposal(raw);
    case 'suppression':
      return rowToSuppressionProposal(raw);
  }
}

const ALIAS_SELECT_COLS = `proposal_id, surface_form, target_entity_id, proposed_type, confidence,
  evidence, status, proposed_by, reviewed_by, reviewed_at, decision_reason,
  published_at, target_snapshot_version, created_at, updated_at`;
const AMBIGUITY_SELECT_COLS = `proposal_id, normalized_form, member_entity_ids,
  evidence, status, proposed_by, reviewed_by, reviewed_at, decision_reason,
  published_at, target_snapshot_version, created_at, updated_at`;
const SUPPRESSION_SELECT_COLS = `proposal_id, surface_form, target_entity_id, reason,
  evidence, status, proposed_by, reviewed_by, reviewed_at, decision_reason,
  published_at, target_snapshot_version, created_at, updated_at`;

const SELECT_COLS_BY_KIND: Readonly<Record<ProposalKind, string>> = {
  alias: ALIAS_SELECT_COLS,
  ambiguity: AMBIGUITY_SELECT_COLS,
  suppression: SUPPRESSION_SELECT_COLS,
};

export class PgCurationStore implements CurationStorePort {
  constructor(private readonly pool: Pool) {}

  async createAliasProposal(input: CreateAliasProposalInput): Promise<AliasProposal> {
    const id = randomUUID();
    const evidence = canonicalEvidenceForKind('alias', input.evidence);
    const result = await this.pool.query(
      `INSERT INTO alias_proposals
         (proposal_id, surface_form, target_entity_id, proposed_type, confidence, evidence, status, proposed_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending', $7)
       RETURNING ${ALIAS_SELECT_COLS}`,
      [
        id,
        input.surfaceForm,
        input.targetEntityId,
        input.proposedType,
        input.confidence,
        JSON.stringify(evidence),
        input.proposedBy ?? null,
      ],
    );
    return rowToAliasProposal(result.rows[0]);
  }

  async createAmbiguityProposal(input: CreateAmbiguityProposalInput): Promise<AmbiguityProposal> {
    const id = randomUUID();
    const evidence = canonicalEvidenceForKind('ambiguity', input.evidence);
    const result = await this.pool.query(
      `INSERT INTO ambiguity_proposals
         (proposal_id, normalized_form, member_entity_ids, evidence, status, proposed_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, 'pending', $5)
       RETURNING ${AMBIGUITY_SELECT_COLS}`,
      [
        id,
        input.normalizedForm,
        JSON.stringify(input.memberEntityIds),
        JSON.stringify(evidence),
        input.proposedBy ?? null,
      ],
    );
    return rowToAmbiguityProposal(result.rows[0]);
  }

  async createSuppressionProposal(input: CreateSuppressionProposalInput): Promise<SuppressionProposal> {
    const id = randomUUID();
    const evidence = canonicalEvidenceForKind('suppression', input.evidence);
    const result = await this.pool.query(
      `INSERT INTO suppression_proposals
         (proposal_id, surface_form, target_entity_id, reason, evidence, status, proposed_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6)
       RETURNING ${SUPPRESSION_SELECT_COLS}`,
      [
        id,
        input.surfaceForm,
        input.targetEntityId ?? null,
        input.reason,
        JSON.stringify(evidence),
        input.proposedBy ?? null,
      ],
    );
    return rowToSuppressionProposal(result.rows[0]);
  }

  async getProposal(kind: ProposalKind, proposalId: string): Promise<Proposal | null> {
    const result = await this.pool.query(
      `SELECT ${SELECT_COLS_BY_KIND[kind]} FROM ${TABLE_BY_KIND[kind]} WHERE proposal_id = $1`,
      [proposalId],
    );
    const row: unknown = result.rows[0];
    return row === undefined ? null : rowToProposal(kind, row);
  }

  async listProposals(filter: ProposalListFilter): Promise<readonly Proposal[]> {
    const limit = Math.min(Math.max(1, Math.trunc(filter.limit)), MAX_PROPOSAL_LIST_ROWS);
    const kinds: readonly ProposalKind[] = filter.kind !== undefined
      ? [filter.kind]
      : (['alias', 'ambiguity', 'suppression'] as const);

    const perKind = await Promise.all(
      kinds.map(async (kind) => {
        const params: unknown[] = [];
        let where = '';
        if (filter.status !== undefined) {
          params.push(filter.status);
          where = `WHERE status = $1`;
        }
        params.push(limit);
        const result = await this.pool.query(
          `SELECT ${SELECT_COLS_BY_KIND[kind]} FROM ${TABLE_BY_KIND[kind]}
           ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
          params,
        );
        return result.rows.map((row) => rowToProposal(kind, row));
      }),
    );

    // Merge across kinds, newest first, and cap at the requested limit.
    const merged = perKind.flat();
    merged.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return merged.slice(0, limit);
  }

  async transitionProposal(
    kind: ProposalKind,
    proposalId: string,
    transition: ProposalTransition,
  ): Promise<Proposal | null> {
    const result = await this.pool.query(
      `UPDATE ${TABLE_BY_KIND[kind]}
         SET status = $1,
             reviewed_by = COALESCE($2, reviewed_by),
             reviewed_at = COALESCE($3, reviewed_at),
             decision_reason = COALESCE($4, decision_reason),
             published_at = COALESCE($5, published_at),
             target_snapshot_version = COALESCE($6, target_snapshot_version),
             updated_at = NOW()
       WHERE proposal_id = $7 AND status = $8
       RETURNING ${SELECT_COLS_BY_KIND[kind]}`,
      [
        transition.to,
        transition.reviewedBy ?? null,
        transition.reviewedAt ?? null,
        transition.decisionReason ?? null,
        transition.publishedAt ?? null,
        transition.targetSnapshotVersion ?? null,
        proposalId,
        transition.expectedFrom,
      ],
    );
    const row: unknown = result.rows[0];
    return row === undefined ? null : rowToProposal(kind, row);
  }

  async aliasAudit(entityId: string): Promise<AliasAuditView> {
    const aliasResult = await this.pool.query(
      `SELECT DISTINCT ON (surface_form, alias_type)
         alias_id, surface_form, alias_type, source
       FROM aliases WHERE entity_id = $1
       ORDER BY surface_form, alias_type, created_at DESC
       LIMIT ${MAX_PROPOSAL_LIST_ROWS}`,
      [entityId],
    );
    const aliases: AliasAuditAlias[] = aliasResult.rows.map((raw) => {
      const row = AliasAuditRowSchema.parse(raw);
      return {
        aliasId: row.alias_id,
        surfaceForm: row.surface_form,
        aliasType: row.alias_type,
        source: row.source,
      };
    });

    // Proposals touching this entity, across all three staging tables.
    const [aliasProps, suppressionProps, ambiguityProps] = await Promise.all([
      this.pool.query(
        `SELECT ${ALIAS_SELECT_COLS} FROM alias_proposals WHERE target_entity_id = $1
         ORDER BY created_at DESC LIMIT ${MAX_PROPOSAL_LIST_ROWS}`,
        [entityId],
      ),
      this.pool.query(
        `SELECT ${SUPPRESSION_SELECT_COLS} FROM suppression_proposals WHERE target_entity_id = $1
         ORDER BY created_at DESC LIMIT ${MAX_PROPOSAL_LIST_ROWS}`,
        [entityId],
      ),
      this.pool.query(
        `SELECT ${AMBIGUITY_SELECT_COLS} FROM ambiguity_proposals
         WHERE member_entity_ids @> $1::jsonb
         ORDER BY created_at DESC LIMIT ${MAX_PROPOSAL_LIST_ROWS}`,
        [JSON.stringify([entityId])],
      ),
    ]);

    const relatedProposals: Proposal[] = [
      ...aliasProps.rows.map((r) => rowToAliasProposal(r)),
      ...suppressionProps.rows.map((r) => rowToSuppressionProposal(r)),
      ...ambiguityProps.rows.map((r) => rowToAmbiguityProposal(r)),
    ];
    relatedProposals.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return { entityId, aliases, relatedProposals };
  }

  async getCurationHealth(): Promise<CurationHealth> {
    const queueByStatus: Record<ProposalStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      published: 0,
    };
    const queueByKind: Record<ProposalKind, number> = { alias: 0, ambiguity: 0, suppression: 0 };
    let total = 0;
    let publishedAwaitingMaterialization = 0;
    let legacyApprovedAbbreviationBacklog = 0;
    const materializationTrackingEnabled = await pgCurationMaterializationTrackingEnabled(this.pool);

    for (const kind of ['alias', 'ambiguity', 'suppression'] as const) {
      const result = await this.pool.query(
        `SELECT status, COUNT(*)::int AS n FROM ${TABLE_BY_KIND[kind]} GROUP BY status`,
      );
      for (const raw of result.rows) {
        const { status, n } = CountRowSchema.parse(raw);
        queueByStatus[status] += n;
        queueByKind[kind] += n;
        total += n;
      }
      if (materializationTrackingEnabled) {
        const unmaterialized = await this.pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n
             FROM ${TABLE_BY_KIND[kind]}
            WHERE status = 'published'
              AND materialized_snapshot_id IS NULL`,
        );
        publishedAwaitingMaterialization += unmaterialized.rows[0]?.n ?? 0;
      } else {
        const publishedOnly = await this.pool.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n
             FROM ${TABLE_BY_KIND[kind]}
            WHERE status = 'published'`,
        );
        publishedAwaitingMaterialization += publishedOnly.rows[0]?.n ?? 0;
      }
    }

    const legacyAbbrev = await this.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM alias_proposals
        WHERE status = 'approved'
          AND proposed_type = 'abbreviation'`,
    );
    legacyApprovedAbbreviationBacklog = legacyAbbrev.rows[0]?.n ?? 0;

    return {
      queueByStatus,
      queueByKind,
      totalProposals: total,
      publishedAwaitingMaterialization,
      legacyApprovedAbbreviationBacklog,
    };
  }
}
