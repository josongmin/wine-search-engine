/**
 * DIP seam regression: CandidatePoolService accepts optional collaborator
 * injection (profileService / cascadeRouter / constraintFilter /
 * candidateAssembler).
 *
 * Default construction (no injected collaborators) is behavior-preserving and
 * covered by the other candidate-pool tests. This file asserts the new seam:
 * an injected `profileService` is actually consulted by `execute`, proving the
 * orchestrator uses the injected instance rather than a privately `new`-ed one.
 */
import { describe, it, expect, vi } from 'vitest';
import { CandidatePoolService } from '../candidate-pool.js';
import { RetrievalProfileService } from '../retrieval-profile.js';
import { FusionService } from '../fusion.js';
import type { HybridRetrievalInput } from '../../model/retrieval-input.js';
import type { QueryPlanV1 } from '../../../query/model/query-plan.js';
import type { SearchIndexPort } from '../../port/search-index.port.js';
import type { EmbeddingServicePort } from '../../port/embedding-service.port.js';
import type { RetrievalProfilePort } from '../../port/candidate-pool-collaborators.port.js';

function minimalPlan(overrides: Partial<QueryPlanV1> = {}): QueryPlanV1 {
  return {
    rawQuery: 'q',
    normalizedQuery: 'q',
    intent: 'semantic_discovery',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'pure_constraint',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: ['red wine'], semantic: ['red wine'] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    ...overrides,
  } as QueryPlanV1;
}

function createSearchIndex(): SearchIndexPort {
  return {
    getSearchAvailabilityState: () => 'available',
    sparseSearch: vi.fn(async () => []),
    denseSearch: vi.fn(async () => []),
    searchLearnedSparse: vi.fn(async () => []),
    getDocument: vi.fn(async () => null),
    getDocuments: vi.fn(async () => new Map()),
    upsertDocument: vi.fn(async () => {}),
    bulkUpsert: vi.fn(async () => {}),
  };
}

function createEmbeddingService(): EmbeddingServicePort {
  return {
    embed: vi.fn(async (): Promise<readonly number[]> => [0.1]),
    embedBatch: vi.fn(
      async (texts: readonly string[]): Promise<readonly (readonly number[])[]> =>
        texts.map((): readonly number[] => [0.1]),
    ),
  };
}

function createInput(): HybridRetrievalInput {
  const queryPlan = minimalPlan();
  return {
    queryPlan,
    route: 'hybrid',
    compiledRetrievalMode: queryPlan.retrievalMode,
    lexicalQueries: ['red wine'],
    semanticQueries: ['red wine'],
    hardConstraints: [],
    softConstraints: [],
  };
}

describe('CandidatePoolService — collaborator DIP seam', () => {
  it('consults the injected profileService instead of a privately constructed one', async () => {
    // Wrap the real service so the returned RetrievalProfile shape is exactly
    // the production shape (behavior-preserving), but observe the call.
    const real = new RetrievalProfileService();
    const getProfileSpy = vi.fn(real.getProfile.bind(real));
    const injected: RetrievalProfilePort = {
      getProfile: getProfileSpy,
      getChannelMix: real.getChannelMix.bind(real),
      getExecutionProfile: real.getExecutionProfile.bind(real),
      getExecutionChannelMix: real.getExecutionChannelMix.bind(real),
    };

    const pool = new CandidatePoolService(
      createSearchIndex(),
      createEmbeddingService(),
      new FusionService(),
      undefined,
      'text-embedding-3-small',
      false,
      undefined,
      false,
      injected,
    );

    await pool.execute(createInput());

    expect(getProfileSpy).toHaveBeenCalledTimes(1);
  });
});
