import { beforeEach, describe, expect, it } from 'vitest';
import { FeedbackProcessor } from '../../src/domain/learning/service/feedback-processor.js';
import { AliasProposer } from '../../src/domain/learning/service/alias-proposer.js';
import {
  InMemoryExistingAliasChecker,
  InMemoryFeedbackStore,
  InMemoryProposalStore,
} from './helpers/in-memory-adapters.js';
import { OPUS_ONE_ID } from './helpers/test-fixtures.js';
import {
  nextProposalId,
  resetLearningFlywheelTestIds,
  seedClickSignals,
  seedSessionSuccessSignals,
} from './helpers/learning-flywheel-test-helpers.js';

describe('Learning Flywheel alias proposer integration', () => {
  let feedbackStore: InMemoryFeedbackStore;
  let proposalStore: InMemoryProposalStore;
  let aliasChecker: InMemoryExistingAliasChecker;
  let feedbackProcessor: FeedbackProcessor;
  let aliasProposer: AliasProposer;

  beforeEach(() => {
    resetLearningFlywheelTestIds();
    feedbackStore = new InMemoryFeedbackStore();
    proposalStore = new InMemoryProposalStore();
    aliasChecker = new InMemoryExistingAliasChecker();
    feedbackProcessor = new FeedbackProcessor(feedbackStore);
    aliasProposer = new AliasProposer(proposalStore, aliasChecker, {
      minQueryCount: 10,
      minCTR: 0.7,
      minSessionSuccessRate: 0.6,
      autoApprovalConfidence: 0.9,
    });
  });

  async function proposeAliasesForQuery(
    query: string,
    options: {
      clickCount: number;
      clickSessionModulo: number;
      sessionSuccessCount?: number;
      existingAlias?: boolean;
    },
  ) {
    if (options.existingAlias) {
      aliasChecker.addExisting(query);
    }
    await seedClickSignals(feedbackStore, query, OPUS_ONE_ID, {
      count: options.clickCount,
      sessionModulo: options.clickSessionModulo,
    });
    if (options.sessionSuccessCount !== undefined) {
      await seedSessionSuccessSignals(feedbackStore, query, OPUS_ONE_ID, options.sessionSuccessCount);
    }
    const aggregations = await feedbackProcessor.aggregateByQueryEntity();
    return aliasProposer.proposeAliases(aggregations, nextProposalId);
  }

  it('creates alias proposal for query with sufficient evidence', async () => {
    const QUERY = 'new opus alias';
    const proposals = await proposeAliasesForQuery(QUERY, {
      clickCount: 12,
      clickSessionModulo: 6,
      sessionSuccessCount: 4,
    });

    expect(proposals.length).toBeGreaterThan(0);
    const proposal = proposals.find(
      (p) => p.surfaceForm === QUERY && p.targetEntityId === OPUS_ONE_ID,
    );
    expect(proposal).toMatchObject({
      surfaceForm: QUERY,
      targetEntityId: OPUS_ONE_ID,
      status: 'pending',
      proposedType: 'observed_query_alias',
    });
    expect(proposal!.confidence).toBeGreaterThan(0);
  });

  it('does not propose alias if query count is below threshold', async () => {
    const QUERY = 'too-few-signals query';
    const proposals = await proposeAliasesForQuery(QUERY, {
      clickCount: 5,
      clickSessionModulo: 5,
    });

    const proposal = proposals.find((p) => p.surfaceForm === QUERY);
    expect(proposal).toBeUndefined();
  });

  it('does not propose alias if it already exists in the alias table', async () => {
    const QUERY = 'opus one existing';
    const proposals = await proposeAliasesForQuery(QUERY, {
      clickCount: 12,
      clickSessionModulo: 6,
      sessionSuccessCount: 4,
      existingAlias: true,
    });

    const proposal = proposals.find((p) => p.surfaceForm === QUERY);
    expect(proposal).toBeUndefined();
  });

  it('proposal has confidence above default threshold when evidence is strong', async () => {
    const QUERY = 'high confidence alias';
    const proposals = await proposeAliasesForQuery(QUERY, {
      clickCount: 25,
      clickSessionModulo: 10,
      sessionSuccessCount: 10,
    });

    const proposal = proposals.find((p) => p.surfaceForm === QUERY);
    expect(proposal).toMatchObject({
      surfaceForm: QUERY,
      targetEntityId: OPUS_ONE_ID,
    });
    expect(proposal!.confidence).toBeGreaterThan(0.5);
  });
});
