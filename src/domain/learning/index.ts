// ── Models ──────────────────────────────────────────────────────────────────
export type {
  FeedbackSignal,
  FeedbackType,
} from './model/feedback-signal.js';
export type {
  AliasProposal,
  AliasProposalStatus,
  ProposedAliasType,
  AliasProposalEvidence,
} from './model/alias-proposal.js';
export type {
  DriftSignal,
  DriftSeverity,
  DriftWindow,
} from './model/drift-signal.js';
export type {
  ThresholdProposal,
  ThresholdProposalStatus,
  ThresholdSet,
  ThresholdProposalEvidence,
} from './model/threshold-proposal.js';

// ── Ports ───────────────────────────────────────────────────────────────────
export type {
  FeedbackStore,
  FeedbackFilter,
  AggregatedFeedbackStats,
} from './port/feedback-store.port.js';
export type { ProposalStore } from './port/proposal-store.port.js';

// ── Services ────────────────────────────────────────────────────────────────
export {
  FeedbackProcessor,
  type QueryEntityAggregation,
  type FeedbackQualityIssue,
} from './service/feedback-processor.js';
export {
  AliasProposer,
  type AliasProposerConfig,
  type ExistingAliasChecker,
} from './service/alias-proposer.js';
export {
  DriftDetector,
  type TrackedMetric,
  type DriftDetectorConfig,
} from './service/drift-detector.js';
export {
  ThresholdOptimizer,
  type ThresholdOptimizerConfig,
} from './service/threshold-optimizer.js';
export {
  PromotionGate,
  type PromotionDecision,
  type PromotionGateConfig,
  type AdversarialGuardPort,
} from './service/promotion-gate.js';
