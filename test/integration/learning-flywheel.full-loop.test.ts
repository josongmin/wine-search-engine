import { beforeEach, describe, expect, it } from 'vitest';
import { FeedbackProcessor } from '../../src/domain/learning/service/feedback-processor.js';
import { AliasProposer } from '../../src/domain/learning/service/alias-proposer.js';
import { PromotionGate } from '../../src/domain/learning/service/promotion-gate.js';
import {
  InMemoryAdversarialGuard,
  InMemoryExistingAliasChecker,
  InMemoryFeedbackStore,
  InMemoryProposalStore,
} from './helpers/in-memory-adapters.js';
import { OPUS_ONE_ID } from './helpers/test-fixtures.js';
import {
  nextProposalId,
  resetLearningFlywheelTestIds,
  seedStrongAliasEvidence,
} from './helpers/learning-flywheel-test-helpers.js';

describe('Learning Flywheel full-loop integration', () => {
  let feedbackStore: InMemoryFeedbackStore;
  let proposalStore: InMemoryProposalStore;
  let aliasChecker: InMemoryExistingAliasChecker;
  let adversarialGuard: InMemoryAdversarialGuard;
  let feedbackProcessor: FeedbackProcessor;
  let aliasProposer: AliasProposer;
  let promotionGate: PromotionGate;

  beforeEach(() => {
    resetLearningFlywheelTestIds();
    feedbackStore = new InMemoryFeedbackStore();
    proposalStore = new InMemoryProposalStore();
    aliasChecker = new InMemoryExistingAliasChecker();
    adversarialGuard = new InMemoryAdversarialGuard();
    feedbackProcessor = new FeedbackProcessor(feedbackStore);
    aliasProposer = new AliasProposer(proposalStore, aliasChecker, {
      minQueryCount: 10,
      minCTR: 0.7,
      minSessionSuccessRate: 0.6,
      autoApprovalConfidence: 0.9,
    });
    promotionGate = new PromotionGate(proposalStore, adversarialGuard, {
      aliasAutoApproveConfidence: 0.9,
      aliasMinQueryCount: 10,
      aliasMinCTR: 0.7,
      thresholdMinEvalCases: 100,
      thresholdMinUtilityDelta: 0.02,
      killSwitchActive: false,
    });
  });

  it('end-to-end: feedback signals → proposal → promotion decision', async () => {
    const QUERY = 'my opus alias';

    await seedStrongAliasEvidence(feedbackStore, QUERY, OPUS_ONE_ID, {
      clickCount: 12,
      clickSessionModulo: 8,
      sessionSuccessCount: 5,
      offsetStepMs: 800,
    });

    const aggregations = await feedbackProcessor.aggregateByQueryEntity();
    expect(aggregations.length).toBeGreaterThan(0);

    const proposals = await aliasProposer.proposeAliases(aggregations, nextProposalId);
    const proposal = proposals.find((p) => p.surfaceForm === QUERY);
    expect(proposal).toMatchObject({
      surfaceForm: QUERY,
      targetEntityId: OPUS_ONE_ID,
    });

    const decision = await promotionGate.evaluateAliasProposal(proposal!);
    expect(['approved', 'pending']).toContain(decision.newStatus);
  });
});
