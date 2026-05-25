/**
 * Evidence-record utilities — the bridge between the agent's raw
 * observations and the per-dim scoring helpers that need a structured
 * record view of "what evidence the agent surfaced".
 *
 * Split from {@link ./scorer.ts} during the 2026-05-25 decomposition.
 * Two helpers extracted:
 *  - buildContextEvidenceRecords: prefers tool-call evidence frames when
 *    present; falls back to the legacy parseObservations(text) path.
 *  - normalizeEvidenceText: canonical lowercase + NFKC normalisation for
 *    case-insensitive evidence containment checks.
 *
 * No shared mutable state; both functions are pure. Used by ≥6 internal
 * scoring sites across scorer.ts (toolAccuracy, answerQuality, evidence
 * coverage, exact-lookup verification, context relevance, drinkability).
 */

import type { EvidenceRecord } from '../../../src/domain/evaluation/service/claim-level-evaluator.js';
import { buildEvidenceRecordsFromFrames } from '../../../src/domain/evaluation/service/build-evidence-records-from-frames.js';
import { parseObservations } from '../../../src/domain/evaluation/service/evidence-parser.js';
import type { ScenarioExecution } from './scorer.js';

/**
 * Build the canonical EvidenceRecord set for one scenario execution.
 *
 * Two-tier fallback: when the execution carries `evidenceFrames` (the
 * structured tool-call-evidence channel introduced post-RFC-018), parse
 * those directly. Otherwise fall back to the legacy `parseObservations`
 * path which scrapes records out of the agent's textual observations.
 */
export function buildContextEvidenceRecords(execution: ScenarioExecution): readonly EvidenceRecord[] {
  if (execution.evidenceFrames !== undefined && execution.evidenceFrames.length > 0) {
    return buildEvidenceRecordsFromFrames(execution.evidenceFrames);
  }
  return parseObservations(execution.observations);
}

/**
 * Canonical text normalisation for evidence containment checks.
 *
 * Lowercase + trim + NFKC so the predicate scoring treats "BARolo",
 * "barolo", and "barolo " as identical needles. NFKC handles compat
 * decompositions (e.g. fullwidth Latin → ASCII) that arise in mixed
 * Korean/English wine names.
 */
export function normalizeEvidenceText(value: unknown): string {
  return String(value).trim().toLowerCase().normalize('NFKC');
}
