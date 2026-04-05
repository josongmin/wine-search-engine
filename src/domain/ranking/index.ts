// ── Models ──────────────────────────────────────────────────────────────────
export type { RankingInput, UserContext } from './model/ranking-input.js';
export type { RankedResult, ComponentScores } from './model/ranked-result.js';
export type { ScoringWeights } from './model/scoring-weights.js';
export { DEFAULT_WEIGHTS, resolveWeights } from './model/scoring-weights.js';

// ── Ports ───────────────────────────────────────────────────────────────────
export type {
  RerankerPort,
  RerankCandidate,
  RerankResult,
} from './port/reranker.port.js';

// ── Services ────────────────────────────────────────────────────────────────
export { SignalComputer } from './service/signal-computer.js';
export { ScoreAggregator } from './service/score-aggregator.js';
export { EvidenceMapper } from './service/evidence-mapper.js';
export { Ranker } from './service/ranker.js';

// ── LambdaMART Learning-to-Rank (Epic 4) ─────────────────────────────────────
// TODO: Reinstate after LTR implementation is complete
// export { LambdaMARTRanker } from './service/lambdamart-ranker.js';
// export { LTRRanker } from './service/ltr-ranker.js';
