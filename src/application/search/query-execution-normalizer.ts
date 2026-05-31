import { QueryNormalizer } from '../../domain/query/service/query-normalizer.js';

/**
 * Shared {@link QueryNormalizer} singleton for the agent query-execution contract
 * pipeline. Centralized here so the contract builder, default builder, and entity
 * signal detectors all share one stateless normalizer instance (SSoT — avoids
 * allocating a fresh normalizer per module).
 */
export const QUERY_NORMALIZER = new QueryNormalizer();
