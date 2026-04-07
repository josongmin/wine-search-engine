import { beforeEach, describe, expect, it } from 'vitest';
import { PromotionGate } from '../../src/domain/learning/service/promotion-gate.js';
import {
  InMemoryAdversarialGuard,
  InMemoryProposalStore,
} from './helpers/in-memory-adapters.js';
import { CHATEAU_MARGAUX_ID } from './helpers/test-fixtures.js';
import {
  makePendingAliasProposal,
  resetLearningFlywheelTestIds,
} from './helpers/learning-flywheel-test-helpers.js';

describe('Learning Flywheel promotion gate integration', () => {
  let proposalStore: InMemoryProposalStore;
  let adversarialGuard: InMemoryAdversarialGuard;
  let promotionGate: PromotionGate;

  beforeEach(() => {
    resetLearningFlywheelTestIds();
    proposalStore = new InMemoryProposalStore();
    adversarialGuard = new InMemoryAdversarialGuard();
    promotionGate = new PromotionGate(proposalStore, adversarialGuard, {
      aliasAutoApproveConfidence: 0.9,
      aliasMinQueryCount: 10,
      aliasMinCTR: 0.7,
      thresholdMinEvalCases: 100,
      thresholdMinUtilityDelta: 0.02,
      killSwitchActive: false,
    });
  });

  it('approves proposal with sufficient evidence and high confidence', async () => {
    const proposal = makePendingAliasProposal({
      proposalId: 'p-approve-1',
      surfaceForm: 'good alias',
      queryCount: 25,
      confidence: 0.92,
    });
    await proposalStore.saveAliasProposal(proposal);

    const decision = await promotionGate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(true);
    expect(decision.reasons).toContain('AUTO_APPROVED_HIGH_CONFIDENCE');
    expect(decision.newStatus).toBe('approved');
  });

  it('rejects proposal from high-noise source (adversarial surface form)', async () => {
    const ADVERSARIAL_FORM = 'аdversarial-alias';
    adversarialGuard.markAdversarial(ADVERSARIAL_FORM);

    const proposal = makePendingAliasProposal({
      proposalId: 'p-reject-adversarial',
      surfaceForm: ADVERSARIAL_FORM,
      confidence: 0.95,
    });
    await proposalStore.saveAliasProposal(proposal);

    const decision = await promotionGate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('ADVERSARIAL_GUARD_REJECTED');
    expect(decision.newStatus).toBe('rejected');
  });

  it.each([
    [
      'insufficient query count',
      makePendingAliasProposal({
        proposalId: 'p-reject-count',
        surfaceForm: 'low count alias',
        queryCount: 5,
        clickThroughRate: 0.9,
        sessionSuccessRate: 0.8,
        confidence: 0.95,
      }),
      'INSUFFICIENT_QUERY_COUNT',
    ],
    [
      'insufficient CTR',
      makePendingAliasProposal({
        proposalId: 'p-reject-ctr',
        surfaceForm: 'low ctr alias',
        queryCount: 20,
        clickThroughRate: 0.3,
        sessionSuccessRate: 0.8,
        confidence: 0.85,
      }),
      'INSUFFICIENT_CTR',
    ],
  ])('rejects proposal with %s', async (_label, proposal, expectedReason) => {
    await proposalStore.saveAliasProposal(proposal);

    const decision = await promotionGate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain(expectedReason);
  });

  it('kill switch halts all promotions', async () => {
    promotionGate.activateKillSwitch();
    expect(promotionGate.isKillSwitchActive()).toBe(true);

    const proposal = makePendingAliasProposal({
      proposalId: 'p-kill-switch',
      surfaceForm: 'perfect alias',
      queryCount: 50,
      clickThroughRate: 0.95,
      sessionSuccessRate: 0.9,
      confidence: 0.99,
    });
    await proposalStore.saveAliasProposal(proposal);

    const decision = await promotionGate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('KILL_SWITCH_ACTIVE');
  });

  it('kill switch can be deactivated to resume promotion', async () => {
    promotionGate.activateKillSwitch();
    promotionGate.deactivateKillSwitch();
    expect(promotionGate.isKillSwitchActive()).toBe(false);

    const proposal = makePendingAliasProposal({
      proposalId: 'p-resumed',
      surfaceForm: 'resumed alias',
    });
    await proposalStore.saveAliasProposal(proposal);

    const decision = await promotionGate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(true);
  });

  it('processPendingAliasProposals handles multiple pending proposals', async () => {
    const goodProposal = makePendingAliasProposal({
      proposalId: 'p-good',
      surfaceForm: 'good alias two',
      queryCount: 25,
      confidence: 0.93,
    });
    const badProposal = makePendingAliasProposal({
      proposalId: 'p-bad',
      surfaceForm: 'bad alias two',
      targetEntityId: CHATEAU_MARGAUX_ID,
      queryCount: 3,
      clickThroughRate: 0.5,
      sessionSuccessRate: 0.3,
      confidence: 0.4,
    });

    await proposalStore.saveAliasProposal(goodProposal);
    await proposalStore.saveAliasProposal(badProposal);

    const results = await promotionGate.processPendingAliasProposals();

    expect(results.length).toBe(2);
    const goodResult = results.find((r) => r.proposal.proposalId === 'p-good');
    const badResult = results.find((r) => r.proposal.proposalId === 'p-bad');
    expect(goodResult!.decision.approved).toBe(true);
    expect(badResult!.decision.approved).toBe(false);
  });
});
