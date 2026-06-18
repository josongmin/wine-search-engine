/**
 * T-ELV2-03 — consume ops-published curation proposals into snapshot ETL.
 *
 * Ops publish (`status=published`) is staging-only; this module materializes
 * alias overlays, ambiguity rows, and alias suppressions into snapshot artifacts.
 * Legacy abbreviation ETL may still commit `approved` rows — those remain readable
 * until operators publish through the ops plane.
 */

import { z } from 'zod';
import type { Pool } from 'pg';
import { parseAliasType } from '../../src/domain/alias/model/alias.js';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import {
  parseCurationAliasEvidence,
  parseCurationAmbiguityEvidence,
} from '../../src/domain/curation/model/curation-proposal-evidence.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';
import { hashStableJson, hashText, type AmbiguityRegistrySnapshotRow } from './search-snapshot-schema.js';
import { hasHangul, type SnapshotAliasOverlayProposal } from './build-alias-artifact.js';

/** Source tag for ops-published alias overlays without explicit evidence.source. */
export const CURATION_PUBLISHED_ALIAS_SOURCE = 'curation:published_proposal';

/** Default ambiguity type when ops evidence omits ambiguityTypes. */
export const CURATION_PUBLISHED_AMBIGUITY_TYPE = 'operator_curation';

const jsonRecord = z.record(z.unknown());

const PublishedAliasProposalRowSchema = z.object({
  proposal_id: z.string().min(1),
  surface_form: z.string().min(1),
  target_entity_id: z.string().min(1),
  proposed_type: z.string().min(1),
  evidence: jsonRecord,
  confidence: z.coerce.number().finite(),
  status: z.string().min(1),
  target_snapshot_version: z.string().min(1).nullable(),
}).strict();

const PublishedAmbiguityProposalRowSchema = z.object({
  proposal_id: z.string().min(1),
  normalized_form: z.string().min(1),
  member_entity_ids: z.array(z.string().min(1)).min(2),
  evidence: jsonRecord,
  status: z.string().min(1),
  target_snapshot_version: z.string().min(1).nullable(),
}).strict();

const PublishedSuppressionProposalRowSchema = z.object({
  proposal_id: z.string().min(1),
  surface_form: z.string().min(1),
  target_entity_id: z.string().min(1).nullable(),
  reason: z.string().min(1),
  status: z.string().min(1),
  target_snapshot_version: z.string().min(1).nullable(),
}).strict();

export interface PublishedSuppressionRule {
  readonly proposalId: string;
  readonly normalizedSurface: string;
  readonly targetEntityId: CanonicalEntityId | null;
  readonly reason: string;
}

export interface PublishedCurationConsumption {
  readonly aliasProposalIds: readonly string[];
  readonly ambiguityProposalIds: readonly string[];
  readonly suppressionProposalIds: readonly string[];
}

export interface PublishedCurationLoadResult {
  readonly aliasOverlays: ReadonlyMap<CanonicalEntityId, readonly SnapshotAliasOverlayProposal[]>;
  readonly ambiguityRows: readonly AmbiguityRegistrySnapshotRow[];
  readonly suppressionRules: readonly PublishedSuppressionRule[];
  readonly consumed: PublishedCurationConsumption;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAliasOverlayEvidence(
  evidence: Record<string, unknown>,
  confidence: number,
  surfaceForm: string,
): Pick<SnapshotAliasOverlayProposal, 'source' | 'sourceTrust' | 'scope'> {
  const canonical = parseCurationAliasEvidence(evidence);
  const source = canonical.source ?? CURATION_PUBLISHED_ALIAS_SOURCE;
  const sourceTrust = canonical.sourceTrust ?? confidence;
  const scope = canonical.aliasScope ?? (hasHangul(surfaceForm) ? 'locale_ko' : 'global');
  return { source, sourceTrust, scope };
}

export function parsePublishedAliasProposalRow(
  row: unknown,
): { readonly targetEntityId: CanonicalEntityId; readonly proposal: SnapshotAliasOverlayProposal } {
  const parsed = PublishedAliasProposalRowSchema.parse(row);
  const aliasType = parseAliasType(parsed.proposed_type);
  if (aliasType === undefined) {
    throw new Error(`Published alias proposal has invalid type for ${parsed.target_entity_id}`);
  }
  if (!Number.isFinite(parsed.confidence) || parsed.confidence <= 0) {
    throw new Error(`Published alias proposal has invalid confidence for ${parsed.target_entity_id}`);
  }
  const evidence = normalizeAliasOverlayEvidence(parsed.evidence, parsed.confidence, parsed.surface_form);
  return {
    targetEntityId: parsed.target_entity_id as CanonicalEntityId,
    proposal: {
      value: parsed.surface_form,
      type: aliasType,
      source: evidence.source,
      sourceTrust: evidence.sourceTrust,
      confidencePrior: parsed.confidence,
      scope: evidence.scope,
    },
  };
}

function readAmbiguityTypes(evidence: Record<string, unknown>): readonly string[] {
  const canonical = parseCurationAmbiguityEvidence(evidence);
  const raw = canonical.ambiguityTypes;
  if (raw === undefined) {
    return [CURATION_PUBLISHED_AMBIGUITY_TYPE];
  }
  return raw.length > 0 ? raw : [CURATION_PUBLISHED_AMBIGUITY_TYPE];
}

function readAmbiguitySeverity(
  evidence: Record<string, unknown>,
): AmbiguityRegistrySnapshotRow['severity'] {
  const canonical = parseCurationAmbiguityEvidence(evidence);
  return canonical.severity ?? 'high';
}

export function publishedAmbiguityProposalToSnapshotRow(args: {
  readonly proposalId: string;
  readonly normalizedForm: string;
  readonly memberEntityIds: readonly string[];
  readonly evidence: Record<string, unknown>;
  readonly knownEntityIds: ReadonlySet<CanonicalEntityId>;
}): AmbiguityRegistrySnapshotRow | null {
  const entityIds = [...new Set(
    args.memberEntityIds.filter((entityId) => args.knownEntityIds.has(entityId as CanonicalEntityId)),
  )].sort((left, right) => left.localeCompare(right));
  if (entityIds.length < 2) {
    return null;
  }
  const ambiguityTypes = readAmbiguityTypes(args.evidence);
  const contentHash = hashStableJson({
    proposalId: args.proposalId,
    normalizedForm: args.normalizedForm,
    entityIds,
    ambiguityTypes,
  });
  return {
    registryId: hashText(`curation-ambiguity:${contentHash}`),
    normalizedForm: args.normalizedForm,
    entityIds,
    ambiguityTypes,
    severity: readAmbiguitySeverity(args.evidence),
  };
}

export function parsePublishedAmbiguityProposalRow(
  row: unknown,
  knownEntityIds: ReadonlySet<CanonicalEntityId>,
): AmbiguityRegistrySnapshotRow | null {
  const parsed = PublishedAmbiguityProposalRowSchema.parse(row);
  return publishedAmbiguityProposalToSnapshotRow({
    proposalId: parsed.proposal_id,
    normalizedForm: normalizeForMatch(parsed.normalized_form),
    memberEntityIds: parsed.member_entity_ids,
    evidence: parsed.evidence,
    knownEntityIds,
  });
}

export function parsePublishedSuppressionProposalRow(row: unknown): PublishedSuppressionRule {
  const parsed = PublishedSuppressionProposalRowSchema.parse(row);
  return {
    proposalId: parsed.proposal_id,
    normalizedSurface: normalizeForMatch(parsed.surface_form),
    targetEntityId: parsed.target_entity_id as CanonicalEntityId | null,
    reason: parsed.reason,
  };
}

export function mergePublishedAmbiguityRows(
  baseRows: readonly AmbiguityRegistrySnapshotRow[],
  publishedRows: readonly AmbiguityRegistrySnapshotRow[],
): readonly AmbiguityRegistrySnapshotRow[] {
  const merged = new Map<string, AmbiguityRegistrySnapshotRow>();
  for (const row of baseRows) {
    merged.set(row.normalizedForm, row);
  }
  for (const row of publishedRows) {
    merged.set(row.normalizedForm, row);
  }
  return [...merged.values()].sort((left, right) =>
    left.normalizedForm.localeCompare(right.normalizedForm)
    || left.registryId.localeCompare(right.registryId),
  );
}

export function applyPublishedSuppressionRules<
  T extends { readonly entityId: string; readonly normalizedValue: string },
>(aliases: readonly T[], rules: readonly PublishedSuppressionRule[]): readonly T[] {
  if (rules.length === 0) {
    return aliases;
  }
  return aliases.filter((alias) => {
    for (const rule of rules) {
      if (alias.normalizedValue !== rule.normalizedSurface) {
        continue;
      }
      if (rule.targetEntityId === null || rule.targetEntityId === alias.entityId) {
        return false;
      }
    }
    return true;
  });
}

export function mergeAliasOverlayMaps(
  ...maps: readonly ReadonlyMap<CanonicalEntityId, readonly SnapshotAliasOverlayProposal[]>[]
): ReadonlyMap<CanonicalEntityId, readonly SnapshotAliasOverlayProposal[]> {
  const merged = new Map<CanonicalEntityId, SnapshotAliasOverlayProposal[]>();
  for (const map of maps) {
    for (const [entityId, proposals] of map.entries()) {
      const existing = merged.get(entityId) ?? [];
      merged.set(entityId, [...existing, ...proposals]);
    }
  }
  return merged;
}

/** Max snapshot-build passes while resolving pinned curation proposals. */
export const CURATION_SNAPSHOT_PIN_MAX_PASSES = 4;

/**
 * Pin semantics: unpinned proposals apply on every build; pinned proposals apply
 * only when the build's snapshot id is known and matches the pin (fail-closed).
 */
export function matchesTargetSnapshotVersion(
  targetSnapshotVersion: string | null,
  snapshotId: string | undefined,
): boolean {
  if (targetSnapshotVersion === null) {
    return true;
  }
  if (snapshotId === undefined) {
    return false;
  }
  return targetSnapshotVersion === snapshotId;
}

export function hasAdditionalPublishedConsumption(
  baseline: PublishedCurationConsumption,
  candidate: PublishedCurationConsumption,
): boolean {
  const baselineIds = new Set<string>([
    ...baseline.aliasProposalIds,
    ...baseline.ambiguityProposalIds,
    ...baseline.suppressionProposalIds,
  ]);
  for (const proposalId of candidate.aliasProposalIds) {
    if (!baselineIds.has(proposalId)) {
      return true;
    }
  }
  for (const proposalId of candidate.ambiguityProposalIds) {
    if (!baselineIds.has(proposalId)) {
      return true;
    }
  }
  for (const proposalId of candidate.suppressionProposalIds) {
    if (!baselineIds.has(proposalId)) {
      return true;
    }
  }
  return false;
}

export function formatUnconsumedPublishedProposalIds(
  baseline: PublishedCurationConsumption,
  target: PublishedCurationConsumption,
): readonly string[] {
  const baselineIds = new Set<string>([
    ...baseline.aliasProposalIds,
    ...baseline.ambiguityProposalIds,
    ...baseline.suppressionProposalIds,
  ]);
  const missing: string[] = [];
  for (const proposalId of [
    ...target.aliasProposalIds,
    ...target.ambiguityProposalIds,
    ...target.suppressionProposalIds,
  ]) {
    if (!baselineIds.has(proposalId)) {
      missing.push(proposalId);
    }
  }
  return missing;
}

export function buildCurationPinConvergenceError(args: {
  readonly snapshotId: string;
  readonly passesAttempted: number;
  readonly unconsumedProposalIds: readonly string[];
}): Error {
  const ids = args.unconsumedProposalIds.join(', ');
  return new Error(
    `Curation pin convergence failed after ${args.passesAttempted} snapshot build pass(es) `
    + `for ${args.snapshotId}: published proposals still pinned for this build `
    + `but not materialized in artifacts [${ids}]`,
  );
}

export function buildCurationPinSnapshotMismatchError(args: {
  readonly snapshotId: string;
  readonly mismatched: readonly { readonly proposalId: string; readonly targetSnapshotVersion: string }[];
}): Error {
  const details = args.mismatched
    .map((row) => `${row.proposalId}→${row.targetSnapshotVersion}`)
    .join(', ');
  return new Error(
    `Curation pin snapshot mismatch for ${args.snapshotId}: consumed published proposals `
    + `are pinned to a different snapshot id [${details}]`,
  );
}

function isCurationStagingPgConfigured(): boolean {
  return process.env['DATABASE_URL'] !== undefined || process.env['PG_HOST'] !== undefined;
}

/** Shared fail-loud guard when staging PG env is set but the pool is disabled. */
export const CURATION_STAGING_PG_POOL_DISABLED_MESSAGE =
  'Curation staging PG is configured (DATABASE_URL/PG_HOST) but the pg pool is disabled; '
  + 'refusing silent curation staging access.';

async function openCurationStagingPgPoolOrNull(): Promise<Pool | null> {
  if (!isCurationStagingPgConfigured()) {
    return null;
  }
  const [{ loadConfig }, { createPgPool, shouldUsePgPool }] = await Promise.all([
    import('../../src/config/env.js'),
    import('../../src/infrastructure/db/pg-pool.js'),
  ]);
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error(CURATION_STAGING_PG_POOL_DISABLED_MESSAGE);
  }
  return createPgPool(config.pg);
}

function isPublishedProposalStatus(status: string): boolean {
  return status === 'published';
}

/** True when a staging row should be tracked in `consumed` / materialization mark. */
export function isPublishedCurationConsumptionStatus(status: string): boolean {
  return isPublishedProposalStatus(status);
}

export async function loadPublishedCurationProposals(args: {
  readonly entityIds: readonly CanonicalEntityId[];
  readonly knownEntityIds: ReadonlySet<CanonicalEntityId>;
  readonly targetSnapshotId?: string | undefined;
}): Promise<PublishedCurationLoadResult> {
  const empty: PublishedCurationLoadResult = {
    aliasOverlays: new Map(),
    ambiguityRows: [],
    suppressionRules: [],
    consumed: { aliasProposalIds: [], ambiguityProposalIds: [], suppressionProposalIds: [] },
  };
  const uniqueEntityIds = [...new Set(args.entityIds)];
  if (uniqueEntityIds.length === 0) {
    return empty;
  }
  if (!isCurationStagingPgConfigured()) {
    return empty;
  }

  const pool = await openCurationStagingPgPoolOrNull();
  if (pool === null) {
    return empty;
  }
  try {
    const aliasResult = await pool.query(
      `SELECT proposal_id, surface_form, target_entity_id, proposed_type, evidence, confidence,
              status, target_snapshot_version
         FROM alias_proposals
        WHERE target_entity_id = ANY($1::text[])
          AND (
            status = 'published'
            OR (status = 'approved' AND proposed_type = 'abbreviation')
          )
        ORDER BY target_entity_id ASC, confidence DESC, proposal_id ASC`,
      [uniqueEntityIds],
    );

    const aliasProposalIds: string[] = [];
    const aliasOverlays = new Map<CanonicalEntityId, SnapshotAliasOverlayProposal[]>();
    for (const row of aliasResult.rows) {
      if (!isRecordValue(row)) {
        continue;
      }
      const proposalId = typeof row['proposal_id'] === 'string' ? row['proposal_id'] : '';
      const status = typeof row['status'] === 'string' ? row['status'] : '';
      const targetSnapshotVersion = typeof row['target_snapshot_version'] === 'string'
        ? row['target_snapshot_version']
        : row['target_snapshot_version'] === null
          ? null
          : null;
      if (!matchesTargetSnapshotVersion(targetSnapshotVersion, args.targetSnapshotId)) {
        continue;
      }
      const parsed = parsePublishedAliasProposalRow(row);
      if (proposalId.length > 0 && isPublishedCurationConsumptionStatus(status)) {
        aliasProposalIds.push(proposalId);
      }
      const existing = aliasOverlays.get(parsed.targetEntityId) ?? [];
      existing.push(parsed.proposal);
      aliasOverlays.set(parsed.targetEntityId, existing);
    }

    const ambiguityResult = await pool.query(
      `SELECT proposal_id, normalized_form, member_entity_ids, evidence, status, target_snapshot_version
         FROM ambiguity_proposals
        WHERE status = 'published'
        ORDER BY normalized_form ASC, proposal_id ASC`,
    );
    const ambiguityProposalIds: string[] = [];
    const ambiguityRows: AmbiguityRegistrySnapshotRow[] = [];
    for (const row of ambiguityResult.rows) {
      if (!isRecordValue(row)) {
        continue;
      }
      const proposalId = typeof row['proposal_id'] === 'string' ? row['proposal_id'] : '';
      const status = typeof row['status'] === 'string' ? row['status'] : '';
      const targetSnapshotVersion = typeof row['target_snapshot_version'] === 'string'
        ? row['target_snapshot_version']
        : row['target_snapshot_version'] === null
          ? null
          : null;
      if (!matchesTargetSnapshotVersion(targetSnapshotVersion, args.targetSnapshotId)) {
        continue;
      }
      const snapshotRow = parsePublishedAmbiguityProposalRow(row, args.knownEntityIds);
      if (snapshotRow !== null) {
        if (proposalId.length > 0 && isPublishedCurationConsumptionStatus(status)) {
          ambiguityProposalIds.push(proposalId);
        }
        ambiguityRows.push(snapshotRow);
      }
    }

    const suppressionResult = await pool.query(
      `SELECT proposal_id, surface_form, target_entity_id, reason, status, target_snapshot_version
         FROM suppression_proposals
        WHERE status = 'published'
        ORDER BY surface_form ASC, proposal_id ASC`,
    );
    const suppressionProposalIds: string[] = [];
    const suppressionRules: PublishedSuppressionRule[] = [];
    for (const row of suppressionResult.rows) {
      if (!isRecordValue(row)) {
        continue;
      }
      const proposalId = typeof row['proposal_id'] === 'string' ? row['proposal_id'] : '';
      const status = typeof row['status'] === 'string' ? row['status'] : '';
      const targetSnapshotVersion = typeof row['target_snapshot_version'] === 'string'
        ? row['target_snapshot_version']
        : row['target_snapshot_version'] === null
          ? null
          : null;
      if (!matchesTargetSnapshotVersion(targetSnapshotVersion, args.targetSnapshotId)) {
        continue;
      }
      suppressionRules.push(parsePublishedSuppressionProposalRow(row));
      if (proposalId.length > 0 && isPublishedCurationConsumptionStatus(status)) {
        suppressionProposalIds.push(proposalId);
      }
    }

    return {
      aliasOverlays,
      ambiguityRows,
      suppressionRules,
      consumed: { aliasProposalIds, ambiguityProposalIds, suppressionProposalIds },
    };
  } finally {
    await pool.end();
  }
}

export async function assertConsumedCurationPinsAlignWithSnapshot(args: {
  readonly snapshotId: string;
  readonly consumed: PublishedCurationConsumption;
}): Promise<void> {
  const pool = await openCurationStagingPgPoolOrNull();
  if (pool === null) {
    return;
  }

  try {
    const mismatched: { proposalId: string; targetSnapshotVersion: string }[] = [];
    const tables: readonly { readonly kind: 'alias' | 'ambiguity' | 'suppression'; readonly ids: readonly string[] }[] = [
      { kind: 'alias', ids: args.consumed.aliasProposalIds },
      { kind: 'ambiguity', ids: args.consumed.ambiguityProposalIds },
      { kind: 'suppression', ids: args.consumed.suppressionProposalIds },
    ];
    for (const table of tables) {
      if (table.ids.length === 0) {
        continue;
      }
      const tableName = table.kind === 'alias'
        ? 'alias_proposals'
        : table.kind === 'ambiguity'
          ? 'ambiguity_proposals'
          : 'suppression_proposals';
      const result = await pool.query<{ proposal_id: string; target_snapshot_version: string }>(
        `SELECT proposal_id, target_snapshot_version
           FROM ${tableName}
          WHERE proposal_id = ANY($1::text[])
            AND target_snapshot_version IS NOT NULL
            AND target_snapshot_version <> $2`,
        [table.ids, args.snapshotId],
      );
      for (const row of result.rows) {
        mismatched.push({
          proposalId: row.proposal_id,
          targetSnapshotVersion: row.target_snapshot_version,
        });
      }
    }
    if (mismatched.length > 0) {
      throw buildCurationPinSnapshotMismatchError({
        snapshotId: args.snapshotId,
        mismatched,
      });
    }
  } finally {
    await pool.end();
  }
}

export async function markPublishedCurationProposalsMaterialized(args: {
  readonly snapshotId: string;
  readonly consumed: PublishedCurationConsumption;
}): Promise<void> {
  const pool = await openCurationStagingPgPoolOrNull();
  if (pool === null) {
    return;
  }

  const materializedAt = new Date().toISOString();
  try {
    const { pgCurationMaterializationTrackingEnabled } = await import(
      '../../src/infrastructure/curation/curation-materialization-capability.js'
    );
    if (!await pgCurationMaterializationTrackingEnabled(pool)) {
      return;
    }

    if (args.consumed.aliasProposalIds.length > 0) {
      await pool.query(
        `UPDATE alias_proposals
            SET materialized_snapshot_id = $1,
                materialized_at = $2::timestamptz
          WHERE proposal_id = ANY($3::text[])
            AND status = 'published'`,
        [args.snapshotId, materializedAt, args.consumed.aliasProposalIds],
      );
    }
    if (args.consumed.ambiguityProposalIds.length > 0) {
      await pool.query(
        `UPDATE ambiguity_proposals
            SET materialized_snapshot_id = $1,
                materialized_at = $2::timestamptz
          WHERE proposal_id = ANY($3::text[])
            AND status = 'published'`,
        [args.snapshotId, materializedAt, args.consumed.ambiguityProposalIds],
      );
    }
    if (args.consumed.suppressionProposalIds.length > 0) {
      await pool.query(
        `UPDATE suppression_proposals
            SET materialized_snapshot_id = $1,
                materialized_at = $2::timestamptz
          WHERE proposal_id = ANY($3::text[])
            AND status = 'published'`,
        [args.snapshotId, materializedAt, args.consumed.suppressionProposalIds],
      );
    }
  } finally {
    await pool.end();
  }
}

/** @deprecated Use {@link loadPublishedCurationProposals}. */
export async function loadApprovedAbbreviationAliasOverlay(
  entityIds: readonly CanonicalEntityId[],
): Promise<ReadonlyMap<CanonicalEntityId, readonly SnapshotAliasOverlayProposal[]>> {
  const { aliasOverlays } = await loadPublishedCurationProposals({
    entityIds,
    knownEntityIds: new Set(entityIds),
  });
  return aliasOverlays;
}
