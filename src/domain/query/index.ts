// Models
export { QUERY_INTENTS, type QueryIntent } from './model/query-intent.js';
export { QUERY_ROUTES, type QueryRoute } from './model/query-route.js';
export { type AnchorCandidate } from './model/anchor-candidate.js';
export { type QueryPolicy } from './model/query-policy.js';
export { type QueryUncertainty } from './model/query-uncertainty.js';
export { type SessionContext } from './model/session-context.js';
export {
  type ExpansionBundle,
  type ConstraintOperator,
  type NormalizedConstraint,
  type ConstraintBundle,
} from './model/constraint-bundle.js';
export { type QueryBudget, DEFAULT_QUERY_BUDGET } from './model/query-budget.js';
export {
  type ThresholdProfileV1,
  type ThresholdEntry,
  DEFAULT_THRESHOLD_PROFILE,
} from './model/threshold-profile.js';
export { type NormalizedQueryViews } from './model/query-views.js';
export { type QueryLookupProvenance } from './model/query-lookup-provenance.js';
export { type QueryPlanV1, type QueryPlanV2, planV2ToUnderstandingSnapshot } from './model/query-plan.js';
export { type QueryUnderstandingSnapshot } from './model/query-understanding-snapshot.js';
export {
  type DecompositionStrategy,
  type QueryDecompositionHint,
  type DetectableDecompositionOutcome,
  toQueryDecompositionHint,
} from './model/query-decomposition.js';

// Ports
export { type ThresholdStore } from './port/threshold-store.port.js';
export { type AmbiguityDictionary } from './port/ambiguity-dictionary.port.js';

// Services
export {
  AnchorExtractor,
  type AliasMatcher,
  type AliasMatchResult,
} from './service/anchor-extractor.js';
export { ExpansionBuilder } from './service/expansion-builder.js';
export { PolicyCompiler } from './service/policy-compiler.js';
export {
  QueryNormalizer,
  buildNormalizedQueryViews,
  normalizeQueryStrict,
} from './service/query-normalizer.js';
export {
  ReformulationDetector,
  type ReformulationType,
} from './service/reformulation-detector.js';
export { Planner, type PlannerContext } from './service/planner.js';
