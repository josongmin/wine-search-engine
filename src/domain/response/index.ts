// Models
export { type SearchResponseV1 } from './model/search-response.js';
export {
  type ResultItem,
  type EntitySummary,
  type MatchDetail,
  type ConstraintEvaluation,
  type UncertaintyBlock,
} from './model/result-item.js';
export { type EngineDecision } from './model/engine-decision.js';
export {
  type ClarificationPayload,
  type ClarificationCandidate,
} from './model/clarification.js';
export {
  type CounterfactualReject,
  type ResponseMeta,
} from './model/counterfactual.js';

// Services
export { ResponseBuilder, type ResponseBuildParams } from './service/response-builder.js';
