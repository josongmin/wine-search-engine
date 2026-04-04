/**
 * Integration tests for the learning flywheel.
 *
 * Tests the full loop: feedback signals → aggregation → alias proposals → promotion gate.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FeedbackProcessor } from '../../src/domain/learning/service/feedback-processor.js';
import { AliasProposer } from '../../src/domain/learning/service/alias-proposer.js';
import { PromotionGate } from '../../src/domain/learning/service/promotion-gate.js';
import type { FeedbackSignal } from '../../src/domain/learning/model/feedback-signal.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import {
  InMemoryFeedbackStore,
  InMemoryProposalStore,
  InMemoryExistingAliasChecker,
  InMemoryAdversarialGuard,
} from './helpers/in-memory-adapters.js';
import { OPUS_ONE_ID, CHATEAU_MARGAUX_ID } from './helpers/test-fixtures.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let idCounter = 0;
function nextId(): string {
  return `signal-${++idCounter}`;
}
function nextProposalId(): string {
  return `proposal-${++idCounter}`;
}

const BASE_SNAPSHOT = {
  model_versions: {},
  index_versions: {},
  policy_rule_version: '1.0.0',
  threshold_profile_id: 'default',
  planner_version: '1.0.0',
  feature_flags: {},
} as const;

function makeClickSignal(
  query: string,
  entityId: ReturnType<typeof createEntityId>,
  sessionId: string,
  isPositive = true,
  offsetMs = 0,
): FeedbackSignal {
  return {
    signalId: nextId(),
    type: 'click',
    query,
    queryClass: 'short_entity',
    entityId,
    isPositive,
    timestamp: new Date(Date.now() + offsetMs),
    sessionId,
    decisionSnapshot: BASE_SNAPSHOT,
  };
}

function makeSessionSuccessSignal(
  query: string,
  entityId: ReturnType<typeof createEntityId>,
  sessionId: string,
): FeedbackSignal {
  return {
    signalId: nextId(),
    type: 'session_success',
    query,
    queryClass: 'short_entity',
    entityId,
    isPositive: true,
    timestamp: new Date(),
    sessionId,
    decisionSnapshot: BASE_SNAPSHOT,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Learning Flywheel Integration', () => {
  let feedbackStore: InMemoryFeedbackStore;
  let proposalStore: InMemoryProposalStore;
  let aliasChecker: InMemoryExistingAliasChecker;
  let adversarialGuard: InMemoryAdversarialGuard;
  let feedbackProcessor: FeedbackProcessor;
  let aliasProposer: AliasProposer;
  let promotionGate: PromotionGate;

  beforeEach(() => {
    idCounter = 0;
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

  // ─────────────────────────────────────────────────────────────────────────
  // Feedback storage and aggregation
  // ─────────────────────────────────────────────────────────────────────────

  describe('FeedbackProcessor', () => {
    it('stores and retrieves 15 feedback signals', async () => {
      for (let i = 0; i < 15; i++) {
        const sessionId = `session-${i % 5}`;
        await feedbackStore.saveFeedback(
          makeClickSignal('오푸스원', OPUS_ONE_ID, sessionId, true, i * 100),
        );
      }

      const stored = await feedbackStore.getFeedback();
      expect(stored.length).toBe(15);
    });

    it('aggregates 10 positive clicks on entity E for query Q into strong signal', async () => {
      const QUERY = 'opus one special';

      // 10 clicks across 5 different sessions
      for (let i = 0; i < 10; i++) {
        const sessionId = `session-${i % 5}`;
        await feedbackStore.saveFeedback(
          makeClickSignal(QUERY, OPUS_ONE_ID, sessionId, true, i * 1000),
        );
        // Also add session success for each session
        if (i < 5) {
          await feedbackStore.saveFeedback(
            makeSessionSuccessSignal(QUERY, OPUS_ONE_ID, sessionId),
          );
        }
      }

      const aggregations = await feedbackProcessor.aggregateByQueryEntity();

      const agg = aggregations.find(
        (a) => a.query === QUERY && a.entityId === OPUS_ONE_ID,
      );
      expect(agg).toBeDefined();
      expect(agg!.positiveCount).toBe(15); // 10 clicks + 5 session_success
      expect(agg!.sessionCount).toBe(5);
      expect(agg!.clicks).toBe(10);
    });

    it('identifies strong patterns when minSessions and positiveRate conditions are met', async () => {
      const QUERY = 'margaux classic';

      // 12 positive signals across 6 sessions
      for (let i = 0; i < 12; i++) {
        const sessionId = `sess-${i % 6}`;
        await feedbackStore.saveFeedback(
          makeClickSignal(QUERY, CHATEAU_MARGAUX_ID, sessionId, true, i * 500),
        );
      }

      const aggregations = await feedbackProcessor.aggregateByQueryEntity();
      const strongPatterns = feedbackProcessor.identifyStrongPatterns(
        aggregations,
        5,  // minSessions
        0.7, // minPositiveRate
      );

      expect(strongPatterns.length).toBeGreaterThan(0);
      const pattern = strongPatterns.find((p) => p.query === QUERY);
      expect(pattern).toBeDefined();
    });

    it('detects click spam (> 20 clicks from one session-entity)', async () => {
      for (let i = 0; i < 25; i++) {
        await feedbackStore.saveFeedback(
          makeClickSignal('opus one', OPUS_ONE_ID, 'spam-session', true, i * 10),
        );
      }

      const issues = await feedbackProcessor.detectQualityIssues();
      const spamIssues = issues.filter((issue) => issue.type === 'click_spam');
      expect(spamIssues.length).toBeGreaterThan(0);
      expect(spamIssues[0]!.signalCount).toBeGreaterThanOrEqual(25);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AliasProposer
  // ─────────────────────────────────────────────────────────────────────────

  describe('AliasProposer', () => {
    it('creates alias proposal for query with sufficient evidence', async () => {
      const QUERY = 'new opus alias';

      // 15 positive clicks across 6 sessions → passes thresholds
      for (let i = 0; i < 15; i++) {
        const sessionId = `sess-${i % 6}`;
        await feedbackStore.saveFeedback(
          makeClickSignal(QUERY, OPUS_ONE_ID, sessionId, true, i * 1000),
        );
      }
      // Add session successes (needed for sessionSuccessRate > 0.6)
      for (let i = 0; i < 6; i++) {
        await feedbackStore.saveFeedback(
          makeSessionSuccessSignal(QUERY, OPUS_ONE_ID, `sess-${i}`),
        );
      }

      const aggregations = await feedbackProcessor.aggregateByQueryEntity();
      const proposals = await aliasProposer.proposeAliases(aggregations, nextProposalId);

      expect(proposals.length).toBeGreaterThan(0);
      const proposal = proposals.find(
        (p) => p.surfaceForm === QUERY && p.targetEntityId === OPUS_ONE_ID,
      );
      expect(proposal).toBeDefined();
      expect(proposal!.confidence).toBeGreaterThan(0);
      expect(proposal!.status).toBe('pending');
      expect(proposal!.proposedType).toBe('observed_query_alias');
    });

    it('does not propose alias if query count is below threshold', async () => {
      const QUERY = 'too-few-signals query';

      // Only 5 signals — below minQueryCount=10
      for (let i = 0; i < 5; i++) {
        await feedbackStore.saveFeedback(
          makeClickSignal(QUERY, OPUS_ONE_ID, `sess-${i}`, true, i * 1000),
        );
      }

      const aggregations = await feedbackProcessor.aggregateByQueryEntity();
      const proposals = await aliasProposer.proposeAliases(aggregations, nextProposalId);

      const proposal = proposals.find((p) => p.surfaceForm === QUERY);
      expect(proposal).toBeUndefined();
    });

    it('does not propose alias if it already exists in the alias table', async () => {
      const QUERY = 'opus one existing';
      aliasChecker.addExisting(QUERY);

      // Enough signals
      for (let i = 0; i < 15; i++) {
        await feedbackStore.saveFeedback(
          makeClickSignal(QUERY, OPUS_ONE_ID, `sess-${i % 6}`, true, i * 1000),
        );
      }
      for (let i = 0; i < 6; i++) {
        await feedbackStore.saveFeedback(
          makeSessionSuccessSignal(QUERY, OPUS_ONE_ID, `sess-${i}`),
        );
      }

      const aggregations = await feedbackProcessor.aggregateByQueryEntity();
      const proposals = await aliasProposer.proposeAliases(aggregations, nextProposalId);

      const proposal = proposals.find((p) => p.surfaceForm === QUERY);
      expect(proposal).toBeUndefined();
    });

    it('proposal has confidence above default threshold when evidence is strong', async () => {
      const QUERY = 'high confidence alias';

      // 50 positive signals across 10 sessions — very strong evidence
      for (let i = 0; i < 50; i++) {
        const sessionId = `sess-${i % 10}`;
        await feedbackStore.saveFeedback(
          makeClickSignal(QUERY, OPUS_ONE_ID, sessionId, true, i * 500),
        );
      }
      for (let i = 0; i < 10; i++) {
        await feedbackStore.saveFeedback(
          makeSessionSuccessSignal(QUERY, OPUS_ONE_ID, `sess-${i}`),
        );
      }

      const aggregations = await feedbackProcessor.aggregateByQueryEntity();
      const proposals = await aliasProposer.proposeAliases(aggregations, nextProposalId);

      const proposal = proposals.find((p) => p.surfaceForm === QUERY);
      expect(proposal).toBeDefined();
      // Confidence should be substantial with 50+ signals and high success rate
      expect(proposal!.confidence).toBeGreaterThan(0.5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PromotionGate
  // ─────────────────────────────────────────────────────────────────────────

  describe('PromotionGate', () => {
    it('approves proposal with sufficient evidence and high confidence', async () => {
      const proposal = {
        proposalId: 'p-approve-1',
        surfaceForm: 'good alias',
        targetEntityId: OPUS_ONE_ID,
        proposedType: 'observed_query_alias' as const,
        evidence: {
          queryCount: 25,
          clickThroughRate: 0.85,
          sessionSuccessRate: 0.75,
        },
        confidence: 0.92, // above autoApprovalConfidence=0.9
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await proposalStore.saveAliasProposal(proposal);

      const decision = await promotionGate.evaluateAliasProposal(proposal);

      expect(decision.approved).toBe(true);
      expect(decision.reasons).toContain('AUTO_APPROVED_HIGH_CONFIDENCE');
      expect(decision.newStatus).toBe('approved');
    });

    it('rejects proposal from high-noise source (adversarial surface form)', async () => {
      const ADVERSARIAL_FORM = 'аdversarial-alias'; // Cyrillic 'а' mixed in
      adversarialGuard.markAdversarial(ADVERSARIAL_FORM);

      const proposal = {
        proposalId: 'p-reject-adversarial',
        surfaceForm: ADVERSARIAL_FORM,
        targetEntityId: OPUS_ONE_ID,
        proposedType: 'observed_query_alias' as const,
        evidence: {
          queryCount: 20,
          clickThroughRate: 0.85,
          sessionSuccessRate: 0.75,
        },
        confidence: 0.95,
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await proposalStore.saveAliasProposal(proposal);

      const decision = await promotionGate.evaluateAliasProposal(proposal);

      expect(decision.approved).toBe(false);
      expect(decision.reasons).toContain('ADVERSARIAL_GUARD_REJECTED');
      expect(decision.newStatus).toBe('rejected');
    });

    it('rejects proposal with insufficient query count', async () => {
      const proposal = {
        proposalId: 'p-reject-count',
        surfaceForm: 'low count alias',
        targetEntityId: OPUS_ONE_ID,
        proposedType: 'observed_query_alias' as const,
        evidence: {
          queryCount: 5, // below minQueryCount=10
          clickThroughRate: 0.9,
          sessionSuccessRate: 0.8,
        },
        confidence: 0.95,
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await proposalStore.saveAliasProposal(proposal);

      const decision = await promotionGate.evaluateAliasProposal(proposal);

      expect(decision.approved).toBe(false);
      expect(decision.reasons).toContain('INSUFFICIENT_QUERY_COUNT');
    });

    it('rejects proposal with insufficient CTR', async () => {
      const proposal = {
        proposalId: 'p-reject-ctr',
        surfaceForm: 'low ctr alias',
        targetEntityId: OPUS_ONE_ID,
        proposedType: 'observed_query_alias' as const,
        evidence: {
          queryCount: 20,
          clickThroughRate: 0.3, // below minCTR=0.7
          sessionSuccessRate: 0.8,
        },
        confidence: 0.85,
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await proposalStore.saveAliasProposal(proposal);

      const decision = await promotionGate.evaluateAliasProposal(proposal);

      expect(decision.approved).toBe(false);
      expect(decision.reasons).toContain('INSUFFICIENT_CTR');
    });

    it('kill switch halts all promotions', async () => {
      promotionGate.activateKillSwitch();
      expect(promotionGate.isKillSwitchActive()).toBe(true);

      const proposal = {
        proposalId: 'p-kill-switch',
        surfaceForm: 'perfect alias',
        targetEntityId: OPUS_ONE_ID,
        proposedType: 'observed_query_alias' as const,
        evidence: {
          queryCount: 50,
          clickThroughRate: 0.95,
          sessionSuccessRate: 0.9,
        },
        confidence: 0.99,
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await proposalStore.saveAliasProposal(proposal);

      const decision = await promotionGate.evaluateAliasProposal(proposal);

      expect(decision.approved).toBe(false);
      expect(decision.reasons).toContain('KILL_SWITCH_ACTIVE');
    });

    it('kill switch can be deactivated to resume promotion', async () => {
      promotionGate.activateKillSwitch();
      promotionGate.deactivateKillSwitch();
      expect(promotionGate.isKillSwitchActive()).toBe(false);

      const proposal = {
        proposalId: 'p-resumed',
        surfaceForm: 'resumed alias',
        targetEntityId: OPUS_ONE_ID,
        proposedType: 'observed_query_alias' as const,
        evidence: {
          queryCount: 20,
          clickThroughRate: 0.85,
          sessionSuccessRate: 0.75,
        },
        confidence: 0.92,
        status: 'pending' as const,
        createdAt: new Date(),
      };
      await proposalStore.saveAliasProposal(proposal);

      const decision = await promotionGate.evaluateAliasProposal(proposal);

      expect(decision.approved).toBe(true);
    });

    it('processPendingAliasProposals handles multiple pending proposals', async () => {
      // Add one good and one bad proposal
      const goodProposal = {
        proposalId: 'p-good',
        surfaceForm: 'good alias two',
        targetEntityId: OPUS_ONE_ID,
        proposedType: 'observed_query_alias' as const,
        evidence: { queryCount: 25, clickThroughRate: 0.85, sessionSuccessRate: 0.75 },
        confidence: 0.93,
        status: 'pending' as const,
        createdAt: new Date(),
      };
      const badProposal = {
        proposalId: 'p-bad',
        surfaceForm: 'bad alias two',
        targetEntityId: CHATEAU_MARGAUX_ID,
        proposedType: 'observed_query_alias' as const,
        evidence: { queryCount: 3, clickThroughRate: 0.5, sessionSuccessRate: 0.3 },
        confidence: 0.4,
        status: 'pending' as const,
        createdAt: new Date(),
      };

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

  // ─────────────────────────────────────────────────────────────────────────
  // Full loop: signals → processor → proposer → gate
  // ─────────────────────────────────────────────────────────────────────────

  describe('Full Learning Loop', () => {
    it('end-to-end: feedback signals → proposal → promotion decision', async () => {
      const QUERY = 'my opus alias';

      // Generate strong evidence: 15 clicks across 8 sessions.
      // CTR = clicks / totalSignals = 15/15 = 1.0 (all signals are clicks → CTR = 1.0)
      // sessionSuccessRate = sessionSuccesses / sessionCount.
      // We use only clicks here (all positive) to keep CTR = 1.0 > 0.7 threshold.
      // Then add session_success as a separate signal that is also a click (isPositive)
      // but with type session_success — but note the AliasProposer counts
      // totalSignals = positiveCount + negativeCount from all signal types.
      // To keep CTR high: totalSignals ~ clicks. We use click signals only.
      for (let i = 0; i < 15; i++) {
        await feedbackStore.saveFeedback(
          makeClickSignal(QUERY, OPUS_ONE_ID, `sess-${i % 8}`, true, i * 800),
        );
      }
      // session_success signals are separate — they increment positiveCount
      // and sessionSuccesses, but also totalSignals, which would lower CTR.
      // Instead, mix them as part of the same sessions without diluting CTR too much.
      // 15 clicks + 5 session_success = 20 total, CTR = 15/20 = 0.75 > 0.7 ✓
      for (let i = 0; i < 5; i++) {
        await feedbackStore.saveFeedback(
          makeSessionSuccessSignal(QUERY, OPUS_ONE_ID, `sess-${i}`),
        );
      }

      // Step 1: aggregate
      const aggregations = await feedbackProcessor.aggregateByQueryEntity();
      expect(aggregations.length).toBeGreaterThan(0);

      // Step 2: propose
      const proposals = await aliasProposer.proposeAliases(aggregations, nextProposalId);
      const proposal = proposals.find((p) => p.surfaceForm === QUERY);
      expect(proposal).toBeDefined();

      // Step 3: gate
      const decision = await promotionGate.evaluateAliasProposal(proposal!);
      // With 15+8=23 signals, high CTR, and strong success rate, should auto-approve or queue
      expect(['approved', 'pending']).toContain(decision.newStatus);
    });
  });
});
