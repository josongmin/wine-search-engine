/**
 * Pipeline defect codes — SSoT for DomainError codes that represent true
 * infrastructure or logic failures, as opposed to deliberate pipeline signals
 * (policy blocks, snapshot mismatches, etc.).
 *
 * Rule 30: this constant is used by SearchUseCase (application layer) and
 * SearchPipelineEvaluator (infrastructure adapter) — two files that cannot
 * import from each other. Centralising here prevents silent drift where one
 * caller adds a new defect code and the other does not.
 *
 * Usage:
 *   import { PIPELINE_DEFECT_CODES } from '.../pipeline-defect-codes.js';
 *   if (err instanceof DomainError && PIPELINE_DEFECT_CODES.has(err.code)) { ... }
 */

/**
 * DomainError codes that indicate pipeline defects requiring error-level logging
 * and re-throw (never silently downgraded to a benign fallback).
 *
 * - WRONG_RESOLVE: entity resolved but dropped in blocking/candidate stage
 * - BLOCKING_MISS: retrieval missed a required blocking candidate
 * - EVIDENCE_OBLIGATION: resolved result lacks the required evidence trail
 *
 * Policy-blocked (POLICY_BLOCKED) and snapshot errors are deliberate signals
 * and are intentionally absent from this set.
 */
export const PIPELINE_DEFECT_CODES: ReadonlySet<string> = new Set([
  'WRONG_RESOLVE',
  'BLOCKING_MISS',
  'EVIDENCE_OBLIGATION',
]);
