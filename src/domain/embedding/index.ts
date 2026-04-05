/**
 * Embedding module exports.
 *
 * BGE-M3 embedding service with fine-tuning support (Epic 6).
 */

export { finetune, createWineTriplets, DEFAULT_FINETUNING_CONFIG } from './service/bge-m3-finetuner.js';
export type {
  EmbeddingTriplet,
  EmbeddingModelCheckpoint,
  FineTuningConfig,
  ValidationMetrics,
} from './service/bge-m3-finetuner.js';
