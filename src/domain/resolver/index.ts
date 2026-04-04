// ── Models ──────────────────────────────────────────────────────────────────
export type { EntityResolveResult } from './model/resolve-result.js';
export type { MatchSignalSet } from './model/match-signal-set.js';
export type { CalibratedResolutionScore } from './model/calibrated-score.js';
export {
  AMBIGUITY_TYPES,
  type AmbiguityType,
  type AmbiguityState,
} from './model/ambiguity-state.js';
export type { ResolverDecisionTrace } from './model/decision-trace.js';
export type {
  ResolvedCandidate,
  ResolverCandidate,
  AliasMatchInfo,
} from './model/resolved-candidate.js';

// ── Ports ───────────────────────────────────────────────────────────────────
export type { BlockingPort } from './port/blocking.port.js';
export type {
  CalibrationStore,
  CalibrationParams,
} from './port/calibration-store.port.js';
export type {
  LearnedMatcherPort,
  LearnedMatcherOutput,
} from './port/learned-matcher.port.js';

// ── Services ────────────────────────────────────────────────────────────────
export { Blocker } from './service/blocker.js';
export { CandidateScorer } from './service/candidate-scorer.js';
export { AmbiguityClassifier } from './service/ambiguity-classifier.js';
export { Calibrator } from './service/calibrator.js';
export { Resolver, type ResolverInput } from './service/resolver.js';
