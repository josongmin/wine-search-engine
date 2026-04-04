// ── Models ──────────────────────────────────────────────────────────────────
export type { EvalCase, LabelTier } from './model/eval-case.js';
export type { EvalResult } from './model/eval-result.js';
export type { EvalMetrics, SliceMetrics } from './model/eval-metrics.js';

// ── Ports ───────────────────────────────────────────────────────────────────
export type { GoldSetStore, GoldSetFilter } from './port/gold-set-store.port.js';
export type { EvalResultStore, EvalResultFilter } from './port/eval-result-store.port.js';

// ── Services ────────────────────────────────────────────────────────────────
export { UtilityScorer, type UtilityClassification } from './service/utility-scorer.js';
export {
  SelectivePredictor,
  type RiskCoveragePoint,
} from './service/selective-predictor.js';
export {
  CalibrationEvaluator,
  type ReliabilityBin,
  type QueryClassECE,
} from './service/calibration-evaluator.js';
export {
  EvidenceAuditor,
  type EvidenceAuditSummary,
} from './service/evidence-auditor.js';
export {
  SliceEvaluator,
  type FlaggedSlice,
} from './service/slice-evaluator.js';
export {
  EvalRunner,
  type SearchPipelineOutput,
  type SearchPipelinePort,
  type ReleaseGates,
  type ReleaseGateResult,
  type EvalReport,
} from './service/eval-runner.js';
