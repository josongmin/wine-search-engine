// Models
export { type HybridRetrievalInput, type AnchorProfile } from './model/retrieval-input.js';
export { type HybridCandidate } from './model/hybrid-candidate.js';
export { type RetrievalTrace } from './model/retrieval-trace.js';
export { type RetrievalDocument } from './model/retrieval-document.js';

// Ports
export {
  type SearchIndexPort,
  type SparseHit,
  type DenseHit,
} from './port/search-index.port.js';
export { type EmbeddingServicePort } from './port/embedding-service.port.js';

// Services
export { FusionService } from './service/fusion.js';
export { CandidatePoolService } from './service/candidate-pool.js';
export {
  RetrievalProfileService,
  type RetrievalProfile,
} from './service/retrieval-profile.js';
export {
  CascadeRouter,
  type RetrievalPhase,
} from './service/cascade-router.js';
export { ConstraintFilter } from './service/constraint-filter.js';
