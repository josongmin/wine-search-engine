/**
 * Machine-readable failure reasons emitted by the AdmissionGate (RFC-016)
 * and the DecisionEngine.
 *
 * These codes identify the specific invariant violated when a decision
 * is rejected before being emitted as a resolved status.
 *
 * Total enum values: 11
 * - SNAPSHOT_MISMATCH
 * - IDENTITY_REFERENCE_MISSING
 * - IDENTITY_SEAL_VIOLATION
 * - EVIDENCE_INSUFFICIENT
 * - HARD_CONSTRAINT_VIOLATION
 * - AMBIGUITY_BLOCKED
 * - POLICY_BLOCKED
 * - BLOCKING_MISS
 * - INTERNAL_INCONSISTENCY
 * - CONFIDENCE_BELOW_THRESHOLD (Epic 17.3: Hallucination Verify)
 * - NO_CORPUS_MATCH (Wave 1 Cluster F: empty candidate pool + high-confidence
 *   anchor — the user asked something specific that is not in the catalogue.
 *   Clarification cannot help; admit to the user that we don't have it.)
 */
export type FailureReason =
  | 'SNAPSHOT_MISMATCH'
  | 'IDENTITY_REFERENCE_MISSING'
  | 'IDENTITY_SEAL_VIOLATION'
  | 'EVIDENCE_INSUFFICIENT'
  | 'HARD_CONSTRAINT_VIOLATION'
  | 'AMBIGUITY_BLOCKED'
  | 'POLICY_BLOCKED'
  | 'BLOCKING_MISS'
  | 'INTERNAL_INCONSISTENCY'
  | 'CONFIDENCE_BELOW_THRESHOLD'
  | 'NO_CORPUS_MATCH';
