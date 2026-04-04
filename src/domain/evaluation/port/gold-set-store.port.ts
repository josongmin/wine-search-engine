import type { QueryClass } from '../../shared/types/index.js';
import type { EvalCase, LabelTier } from '../model/eval-case.js';

/**
 * Filter criteria for retrieving evaluation cases from the gold set.
 */
export interface GoldSetFilter {
  /** Filter by query class. */
  readonly queryClass?: QueryClass;

  /** Filter by slice tag. */
  readonly sliceTag?: string;

  /** Filter by label quality tier. */
  readonly labelTier?: LabelTier;

  /** Only return cases created on or after this timestamp (temporal split support). */
  readonly since?: Date;
}

/**
 * Port for accessing the gold-standard evaluation dataset, per RFC-009 §3.
 *
 * The gold set is the authoritative collection of labeled evaluation cases
 * used to measure engine quality. All cases must respect temporal ordering
 * for train/eval splits.
 */
export interface GoldSetStore {
  /**
   * Retrieves evaluation cases matching the given filter criteria.
   *
   * @param filter - Optional filter to narrow the returned cases.
   * @returns Matching evaluation cases, ordered by timestamp ascending.
   */
  getCases(filter?: GoldSetFilter): Promise<readonly EvalCase[]>;

  /**
   * Adds a new evaluation case to the gold set.
   *
   * @param evalCase - The case to add. Must have a unique caseId.
   */
  addCase(evalCase: EvalCase): Promise<void>;

  /**
   * Computes the inter-annotator agreement (IAA) score for the gold set,
   * optionally filtered to a specific slice.
   *
   * Gold-tier cases require κ ≥ 0.8 per RFC-009 §4.
   *
   * @param sliceTag - Optional slice to compute IAA for.
   * @returns The aggregate IAA κ score.
   */
  getIAAScore(sliceTag?: string): Promise<number>;
}
