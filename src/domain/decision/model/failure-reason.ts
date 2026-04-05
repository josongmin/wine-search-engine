/**
 * Machine-readable failure reasons emitted by the AdmissionGate (RFC-016).
 *
 * These codes identify the specific invariant violated when a decision
 * is rejected before being emitted as a resolved status.
 *
 * Total enum values: 10
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
  | 'CONFIDENCE_BELOW_THRESHOLD';
