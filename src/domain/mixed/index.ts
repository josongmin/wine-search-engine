// ── Models ──────────────────────────────────────────────────────────────────
export type { AnchorProfile } from './model/anchor-profile.js';
export type { MixedQueryResult } from './model/mixed-query-result.js';

// ── Services ────────────────────────────────────────────────────────────────
export { AnchorProfiler } from './service/anchor-profiler.js';
export type { AnchorEntityData } from './service/anchor-profiler.js';
export { SimilarityScorer } from './service/similarity-scorer.js';
export type { SimilarityCandidate } from './service/similarity-scorer.js';
export { ConstraintOverlay } from './service/constraint-overlay.js';
export { MixedSolver } from './service/mixed-solver.js';
export type {
  AnchorResolverPort,
  SimilarRetrievalPort,
  CandidateAttributePort,
} from './service/mixed-solver.js';
