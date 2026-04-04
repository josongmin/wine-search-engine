/**
 * Strength levels for an evidence item.
 */
export type EvidenceStrength = 'low' | 'medium' | 'high';

/**
 * A single piece of evidence supporting a resolution decision, per RFC-000 section 9.1.
 *
 * Every scored result must carry evidence that explains why it was selected or ranked,
 * enabling auditability and debuggability of the decision pipeline.
 */
export interface EvidenceItem {
  /** The category of evidence (e.g. "lexical_match", "semantic_similarity", "constraint_pass"). */
  readonly type: string;

  /** The subsystem or stage that produced this evidence (e.g. "vespa_retrieval", "reranker"). */
  readonly source: string;

  /** A signed contribution string (e.g. "+0.42", "-0.10") representing score impact. */
  readonly contribution: string;

  /** Qualitative strength of this evidence. */
  readonly strength: EvidenceStrength;

  /** Human-readable provenance description for audit trails. */
  readonly provenance: string;

  /** Optional bag of additional metadata for debugging or downstream consumers. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}
