/**
 * LTR / LambdaMART **training** entrypoints — kept separate from {@link ./index.js}
 * so production bundles do not re-export training helpers from the main barrel.
 */

export { buildTrainingExamples, trainAllModels } from './service/ltr-training-service.js';

export type {
  RankingFeatures,
  LambdaMARTExample,
  QueryClassWeights,
} from './service/lambdamart-ranker.js';
