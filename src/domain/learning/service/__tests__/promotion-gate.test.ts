import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PromotionGate } from '../promotion-gate.js';
import type { AdversarialGuardPort } from '../promotion-gate.js';
import type { ProposalStore } from '../../port/proposal-store.port.js';
import type { AliasProposal } from '../../model/alias-proposal.js';
import type { ThresholdProposal } from '../../model/threshold-proposal.js';
import type { SliceMetrics } from '../../../evaluation/model/eval-metrics.js';
import { createEntityId } from '../../../shared/types/index.js';

// ── Stub factories ────────────────────────────────────────────────────────────

function makeProposalStore(): ProposalStore {
  return {
    saveAliasProposal: vi.fn().mockResolvedValue(undefined),
    saveThresholdProposal: vi.fn().mockResolvedValue(undefined),
    getPendingAliasProposals: vi.fn().mockResolvedValue([]),
    getPendingThresholdProposals: vi.fn().mockResolvedValue([]),
    updateProposalStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAdversarialGuard(isAdversarial = false): AdversarialGuardPort {
  return {
    isAdversarial: vi.fn().mockResolvedValue(isAdversarial),
  };
}

function makeAliasProposal(overrides?: Partial<AliasProposal>): AliasProposal {
  return {
    proposalId: 'proposal-alias-001',
    surfaceForm: 'cabernet sauvignon',
    targetEntityId: createEntityId('entity-001'),
    proposedType: 'observed_query_alias',
    evidence: {
      queryCount: 20,
      clickThroughRate: 0.85,
      sessionSuccessRate: 0.9,
    },
    confidence: 0.95,
    status: 'pending',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeThresholdProposal(overrides?: Partial<ThresholdProposal>): ThresholdProposal {
  return {
    proposalId: 'proposal-threshold-001',
    queryClass: 'exact_match',
    proposedThresholds: { tResolve: 0.85, tGap: 0.15, tFail: 0.3 },
    currentThresholds: { tResolve: 0.8, tGap: 0.12, tFail: 0.25 },
    expectedUtilityDelta: 0.05,
    evidence: {
      evalCaseCount: 150,
      utilityBefore: 0.78,
      utilityAfter: 0.83,
    },
    status: 'pending',
    ...overrides,
  };
}

function makeSliceMetrics(
  sliceTag: string,
  decisionUtility: number,
  wrongResolveRate: number,
): SliceMetrics {
  return {
    sliceTag,
    caseCount: 50,
    metrics: {
      decisionUtility,
      correctResolveRate: 0.9,
      wrongResolveRate,
      safeAbstainRate: 0.05,
      avoidableAbstainRate: 0.02,
      aurc: 0.1,
      eAurc: 0.05,
      selectiveRiskAtCoverage: new Map(),
      ece: 0.03,
      constraintSatisfactionRate: 0.98,
      anchorPreservationRate: 0.99,
      evidenceCompletenessRate: 0.97,
      evidenceSufficiency: 0.96,
      evidenceComprehensiveness: 0.95,
      admissionViolationRate: 0.0,
      p50LatencyMs: 50,
      p95LatencyMs: 120,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PromotionGate', () => {
  let proposalStore: ProposalStore;
  let adversarialGuard: AdversarialGuardPort;

  beforeEach(() => {
    proposalStore = makeProposalStore();
    adversarialGuard = makeAdversarialGuard(false);
  });

  // 1. Kill switch active → evaluateAliasProposal returns rejected
  it('kill switch active → evaluateAliasProposal returns rejected immediately', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard, { killSwitchActive: true });
    const proposal = makeAliasProposal();

    const decision = await gate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('KILL_SWITCH_ACTIVE');
    expect(decision.newStatus).toBe('rejected');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'rejected',
    );
    // Adversarial guard should NOT be called when kill switch is active
    expect(adversarialGuard.isAdversarial).not.toHaveBeenCalled();
  });

  // 2. Kill switch active → evaluateThresholdProposal returns rejected
  it('kill switch active → evaluateThresholdProposal returns rejected immediately', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard, { killSwitchActive: true });
    const proposal = makeThresholdProposal();

    const decision = await gate.evaluateThresholdProposal(proposal, null, []);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('KILL_SWITCH_ACTIVE');
    expect(decision.newStatus).toBe('rejected');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'rejected',
    );
  });

  // 3. activateKillSwitch / deactivateKillSwitch toggle
  it('activateKillSwitch / deactivateKillSwitch toggle works', () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard);

    expect(gate.isKillSwitchActive()).toBe(false);

    gate.activateKillSwitch();
    expect(gate.isKillSwitchActive()).toBe(true);

    gate.deactivateKillSwitch();
    expect(gate.isKillSwitchActive()).toBe(false);
  });

  // 4. Adversarial guard rejects → proposal rejected
  it('adversarial guard rejects → proposal rejected and updateProposalStatus called', async () => {
    adversarialGuard = makeAdversarialGuard(true);
    const gate = new PromotionGate(proposalStore, adversarialGuard);
    const proposal = makeAliasProposal();

    const decision = await gate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('ADVERSARIAL_GUARD_REJECTED');
    expect(decision.newStatus).toBe('rejected');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'rejected',
    );
  });

  // 5. Min query count not met → rejected
  it('min query count not met → proposal rejected', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard, { aliasMinQueryCount: 10 });
    const proposal = makeAliasProposal({
      evidence: { queryCount: 5, clickThroughRate: 0.85, sessionSuccessRate: 0.9 },
    });

    const decision = await gate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('INSUFFICIENT_QUERY_COUNT');
    expect(decision.newStatus).toBe('rejected');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'rejected',
    );
  });

  // 6. Min CTR not met → rejected
  it('min CTR not met → proposal rejected', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard, { aliasMinCTR: 0.7 });
    const proposal = makeAliasProposal({
      evidence: { queryCount: 20, clickThroughRate: 0.5, sessionSuccessRate: 0.9 },
    });

    const decision = await gate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('INSUFFICIENT_CTR');
    expect(decision.newStatus).toBe('rejected');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'rejected',
    );
  });

  // 7. High confidence alias proposal → auto-approved
  it('high confidence alias proposal → auto-approved', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard, {
      aliasAutoApproveConfidence: 0.9,
    });
    const proposal = makeAliasProposal({ confidence: 0.95 });

    const decision = await gate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(true);
    expect(decision.reasons).toContain('AUTO_APPROVED_HIGH_CONFIDENCE');
    expect(decision.newStatus).toBe('approved');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'approved',
    );
  });

  // 8. evaluateThresholdProposal passes all checks → approved
  it('evaluateThresholdProposal passes all checks → approved', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard);
    const proposal = makeThresholdProposal();
    const shadowMetrics: SliceMetrics[] = [
      makeSliceMetrics('global', 0.85, 0.05),
    ];
    const baselineMetrics: SliceMetrics[] = [
      makeSliceMetrics('global', 0.80, 0.06),
    ];

    const decision = await gate.evaluateThresholdProposal(
      proposal,
      shadowMetrics,
      baselineMetrics,
    );

    expect(decision.approved).toBe(true);
    expect(decision.reasons).toContain('ALL_GATES_PASSED');
    expect(decision.newStatus).toBe('approved');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'approved',
    );
  });

  // 9. Slice regression detected → rejected with DECISIONUTILITY reason code only
  it('slice regression detected → rejected with DECISIONUTILITY reason code', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard);
    const proposal = makeThresholdProposal();
    // Shadow has lower utility than baseline by more than tolerance (0.01).
    // Both wrongResolveRate values are identical so only decisionUtility regresses.
    const shadowMetrics: SliceMetrics[] = [
      makeSliceMetrics('vintage_query', 0.70, 0.05),
    ];
    const baselineMetrics: SliceMetrics[] = [
      makeSliceMetrics('vintage_query', 0.85, 0.05),
    ];

    const decision = await gate.evaluateThresholdProposal(
      proposal,
      shadowMetrics,
      baselineMetrics,
    );

    expect(decision.approved).toBe(false);
    expect(decision.reasons.some((r) => r.includes('REGRESSION') && r.includes('DECISIONUTILITY'))).toBe(true);
    // wrongResolveRate must NOT have triggered a separate regression reason
    expect(decision.reasons.some((r) => r.includes('WRONGRESOLVERATE'))).toBe(false);
    expect(decision.newStatus).toBe('rejected');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'rejected',
    );
  });

  // 10. processPendingAliasProposals with empty store → returns []
  it('processPendingAliasProposals with empty store → returns empty array', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard);

    const results = await gate.processPendingAliasProposals();

    expect(results).toEqual([]);
    expect(proposalStore.getPendingAliasProposals).toHaveBeenCalledOnce();
  });

  // 10b. processPendingAliasProposals with 2 proposals → evaluates and approves each
  it('processPendingAliasProposals with 2 proposals → returns 2 decisions and updates status', async () => {
    const proposal1 = makeAliasProposal({
      proposalId: 'proposal-alias-001',
      surfaceForm: 'cabernet sauvignon',
      confidence: 0.95,
      evidence: { queryCount: 20, clickThroughRate: 0.85, sessionSuccessRate: 0.9 },
    });
    const proposal2 = makeAliasProposal({
      proposalId: 'proposal-alias-002',
      surfaceForm: 'pinot noir',
      confidence: 0.97,
      evidence: { queryCount: 30, clickThroughRate: 0.88, sessionSuccessRate: 0.92 },
    });

    vi.mocked(proposalStore.getPendingAliasProposals).mockResolvedValue([proposal1, proposal2]);
    // Adversarial guard passes for both
    vi.mocked(adversarialGuard.isAdversarial).mockResolvedValue(false);

    const gate = new PromotionGate(proposalStore, adversarialGuard, {
      aliasAutoApproveConfidence: 0.9,
    });

    const results = await gate.processPendingAliasProposals();

    // Both proposals evaluated and returned
    expect(results).toHaveLength(2);
    expect(results[0]?.decision.approved).toBe(true);
    expect(results[1]?.decision.approved).toBe(true);

    // updateProposalStatus called once per approved proposal
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith('proposal-alias-001', 'approved');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith('proposal-alias-002', 'approved');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledTimes(2);
  });

  // Additional: shadow testing required when shadowSliceMetrics is null
  it('evaluateThresholdProposal requires shadow testing when shadowSliceMetrics is null', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard);
    const proposal = makeThresholdProposal();

    const decision = await gate.evaluateThresholdProposal(proposal, null, []);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('SHADOW_TESTING_REQUIRED');
    expect(decision.newStatus).toBe('shadow_testing');
    expect(proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      proposal.proposalId,
      'shadow_testing',
    );
  });

  // Additional: wrongResolveRate regression detected
  it('wrongResolveRate regression → rejected with WRONGRESOLVERATE reason code', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard);
    const proposal = makeThresholdProposal();
    // Shadow has higher wrongResolveRate by more than tolerance (0.005)
    const shadowMetrics: SliceMetrics[] = [
      makeSliceMetrics('short_query', 0.82, 0.15),
    ];
    const baselineMetrics: SliceMetrics[] = [
      makeSliceMetrics('short_query', 0.80, 0.10),
    ];

    const decision = await gate.evaluateThresholdProposal(
      proposal,
      shadowMetrics,
      baselineMetrics,
    );

    expect(decision.approved).toBe(false);
    expect(
      decision.reasons.some((r) => r.includes('REGRESSION') && r.includes('WRONGRESOLVERATE')),
    ).toBe(true);
    expect(decision.newStatus).toBe('rejected');
  });

  // Additional: below confidence threshold → queued for human review
  it('alias proposal below auto-approve confidence → queued for human review', async () => {
    const gate = new PromotionGate(proposalStore, adversarialGuard, {
      aliasAutoApproveConfidence: 0.9,
    });
    const proposal = makeAliasProposal({ confidence: 0.75 });

    const decision = await gate.evaluateAliasProposal(proposal);

    expect(decision.approved).toBe(false);
    expect(decision.reasons).toContain('QUEUED_FOR_HUMAN_REVIEW');
    expect(decision.newStatus).toBe('pending');
    // No status update called for pending-review proposals
    expect(proposalStore.updateProposalStatus).not.toHaveBeenCalled();
  });
});
