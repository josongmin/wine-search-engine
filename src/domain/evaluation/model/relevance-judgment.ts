/**
 * Relevance judgment types for retrieval evaluation silver/gold labeling.
 *
 * Grading scale follows TREC-style 4-point relevance:
 *   0 = irrelevant, 1 = marginally relevant, 2 = relevant, 3 = highly relevant
 *
 * References:
 *   - Thomas et al. 2023 "Large Language Models can Accurately Predict Searcher Preferences"
 *   - Faggioli et al. 2023 "Perspectives on Large Language Models for Relevance Judgment"
 */

export type RelevanceGrade = 0 | 1 | 2 | 3;

/** Minimum grade that counts as "relevant" for binary relevance metrics. */
export const RELEVANCE_THRESHOLD_GRADE: RelevanceGrade = 2;

export type JudgmentSource = 'llm_silver' | 'human_gold' | 'human_audit';

export interface RelevanceJudgment {
  readonly queryId: string;
  readonly query: string;
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly grade: RelevanceGrade;
  /** Labeler's self-assessed confidence, range [0, 1]. */
  readonly confidence: number;
  readonly source: JudgmentSource;
  readonly labelerModel?: string;
  readonly rationale?: string;
  readonly auditedBy?: string;
  /** Epoch milliseconds when human audit was performed. */
  readonly auditedAt?: number;
}
