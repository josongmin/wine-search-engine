import type { EntityId } from '../../shared/types/index.js';

/**
 * The decision taken for a source record during ingestion.
 */
export type LineageDecision = 'merge' | 'split' | 'reject' | 'manual_review';

/**
 * The top-level origin of the lineage record.
 * Stored in the `source_type` column for fast filtering/reporting.
 */
export type LineageSourceType =
  | 'ingestion_pipeline'
  | 'manual_review'
  | 'api_import'
  | 'batch_correction';

/**
 * An immutable audit record capturing the full lineage of a source record
 * through the ingestion pipeline (RFC-002 §9.1).
 *
 * Lineage records are append-only: once written, they must never be mutated.
 */
export interface LineageRecord {
  /** The source record this lineage entry pertains to. */
  readonly sourceRecordId: string;
  /** Origin pipeline category — stored in `source_type` DB column. */
  readonly sourceType: LineageSourceType;
  /** The canonicalization candidate that was produced. */
  readonly candidateId: string;
  /** The entity ID that was matched or created (absent on rejection). */
  readonly matchedEntityId?: EntityId | undefined;
  /** Previous entity IDs before a split or re-merge. */
  readonly previousEntityIds?: readonly EntityId[] | undefined;
  /** Names of normalization rules that were applied. */
  readonly normalizationRulesApplied: readonly string[];
  /** Semantic version of the extraction pipeline. */
  readonly extractionVersion: string;
  /** Semantic version of the matching pipeline. */
  readonly matchingVersion: string;
  /** The decision taken for this record. */
  readonly decision: LineageDecision;
  /** Human-readable explanation for the decision. */
  readonly decisionReason: string;
  /** Operator who made or approved the decision (for manual_review). */
  readonly operator?: string | undefined;
  /** Whether an abuse detection rule was triggered. */
  readonly abuseFlag?: boolean | undefined;
  /** When the decision was recorded. */
  readonly timestamp: Date;
}
