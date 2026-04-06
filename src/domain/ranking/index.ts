// ── Models ──────────────────────────────────────────────────────────────────
export type { RankingInput, UserContext } from './model/ranking-input.js';
export type { RankedResult, ComponentScores } from './model/ranked-result.js';
export type { ScoringWeights } from './model/scoring-weights.js';
export { DEFAULT_WEIGHTS, resolveWeights } from './model/scoring-weights.js';
export type { ModeWeightProfile } from './model/mode-weights.js';
export { getModeWeights, DEFAULT_WEIGHTS as DEFAULT_MODE_WEIGHTS } from './model/mode-weights.js';

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

// ── LambdaMART / LTR inference types (Epic 4) — training APIs: ./training.js ─
export type {
  RankingFeatures,
  LambdaMARTExample,
  QueryClassWeights,
} from './service/lambdamart-ranker.js';

export { LTRRanker } from './service/ltr-ranker.js';
export type { RankableDocument, RankedDocument } from './service/ltr-ranker.js';

export { extractLTRFeatures } from './service/ltr-feature-extractor.js';
export type { LTRScoreComponents } from './service/ltr-feature-extractor.js';
