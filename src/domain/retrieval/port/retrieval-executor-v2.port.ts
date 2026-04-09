import type { HybridCandidate } from '../model/hybrid-candidate.js';
import type { HybridRetrievalInput } from '../model/retrieval-input.js';

/**
 * RetrievalExecutorV2 contract.
 *
 * Candidate retrieval execution seam used by SearchUseCase and specialized
 * routing, replacing generate()-named V1 semantics over time.
 */
export interface RetrievalExecutorV2Port {
  execute(input: HybridRetrievalInput): Promise<readonly HybridCandidate[]>;
}

