import { beforeEach, describe, expect, it } from 'vitest';
import { CurationUseCase } from '../../../src/application/curation/curation.usecase.js';
import {
  IllegalProposalTransitionError,
  type Proposal,
  type ProposalKind,
} from '../../../src/domain/curation/model/proposal.js';
import {
  ProposalConflictError,
  ProposalNotFoundError,
} from '../../../src/domain/curation/model/curation-errors.js';
import type {
  AliasAuditView,
  CreateAliasProposalInput,
  CreateAmbiguityProposalInput,
  CreateSuppressionProposalInput,
  CurationHealth,
  CurationStorePort,
  ProposalListFilter,
  ProposalTransition,
} from '../../../src/domain/curation/port/curation-store.port.js';

/**
 * In-memory CurationStorePort fake. transitionProposal honours the optimistic
 * `expectedFrom` guard so we can exercise the use-case's conflict path. A
 * `forceMissTransition` switch simulates a lost race even when the state matches.
 */
class FakeStore implements CurationStorePort {
  private readonly byId = new Map<string, Proposal>();
  forceMissTransition = false;
  private seq = 0;

  private id(): string {
    this.seq += 1;
    return `p-${this.seq}`;
  }

  async createAliasProposal(input: CreateAliasProposalInput) {
    const p: Proposal = {
      kind: 'alias',
      proposalId: this.id(),
      status: 'pending',
      evidence: input.evidence,
      surfaceForm: input.surfaceForm,
      targetEntityId: input.targetEntityId,
      proposedType: input.proposedType,
      confidence: input.confidence,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    this.byId.set(p.proposalId, p);
    return p;
  }

  async createAmbiguityProposal(input: CreateAmbiguityProposalInput) {
    const p: Proposal = {
      kind: 'ambiguity',
      proposalId: this.id(),
      status: 'pending',
      evidence: input.evidence,
      normalizedForm: input.normalizedForm,
      memberEntityIds: input.memberEntityIds,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    this.byId.set(p.proposalId, p);
    return p;
  }

  async createSuppressionProposal(input: CreateSuppressionProposalInput) {
    const p: Proposal = {
      kind: 'suppression',
      proposalId: this.id(),
      status: 'pending',
      evidence: input.evidence,
      surfaceForm: input.surfaceForm,
      reason: input.reason,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    this.byId.set(p.proposalId, p);
    return p;
  }

  async getProposal(_kind: ProposalKind, proposalId: string) {
    return this.byId.get(proposalId) ?? null;
  }

  async listProposals(_filter: ProposalListFilter) {
    return [...this.byId.values()];
  }

  async transitionProposal(_kind: ProposalKind, proposalId: string, t: ProposalTransition) {
    const cur = this.byId.get(proposalId);
    if (cur === undefined || cur.status !== t.expectedFrom || this.forceMissTransition) {
      return null;
    }
    const next = { ...cur, status: t.to } as Proposal;
    this.byId.set(proposalId, next);
    return next;
  }

  async aliasAudit(entityId: string): Promise<AliasAuditView> {
    return { entityId, aliases: [], relatedProposals: [] };
  }

  async getCurationHealth(): Promise<CurationHealth> {
    return {
      queueByStatus: { pending: 0, approved: 0, rejected: 0, published: 0 },
      queueByKind: { alias: 0, ambiguity: 0, suppression: 0 },
      totalProposals: 0,
      publishedAwaitingMaterialization: 0,
      legacyApprovedAbbreviationBacklog: 0,
    };
  }
}

const aliasInput: CreateAliasProposalInput = {
  surfaceForm: 'dom perignon',
  targetEntityId: 'ent-dp',
  proposedType: 'misspelling',
  confidence: 0.9,
  evidence: {},
};

describe('CurationUseCase', () => {
  let store: FakeStore;
  let uc: CurationUseCase;

  beforeEach(() => {
    store = new FakeStore();
    uc = new CurationUseCase(store, () => new Date(1_000));
  });

  it('submits an alias proposal as pending', async () => {
    const p = await uc.submitAliasProposal(aliasInput);
    expect(p.status).toBe('pending');
  });

  it('accepts legacy ops-console evidence with note key', async () => {
    const p = await uc.submitAliasProposal({
      ...aliasInput,
      evidence: { source: 'ops_console', note: 'menu verified' },
    });
    expect(p.status).toBe('pending');
    expect(p.evidence).toEqual({
      source: 'ops_console',
      operatorNote: 'menu verified',
    });
  });

  it('drops unknown evidence keys before staging write', async () => {
    const p = await uc.submitAliasProposal({
      ...aliasInput,
      evidence: { source: 'ops_console', note: 'ok', extra: true },
    });
    expect(p.evidence).toEqual({
      source: 'ops_console',
      operatorNote: 'ok',
    });
  });

  it('accepts RFC-014 snake_case operator_note before staging write', async () => {
    const p = await uc.submitAliasProposal({
      ...aliasInput,
      evidence: { source: 'ops_console', operator_note: 'wire verified' },
    });
    expect(p.evidence).toEqual({
      source: 'ops_console',
      operatorNote: 'wire verified',
    });
  });

  it('approves a pending proposal and stamps the reviewer', async () => {
    const created = await uc.submitAliasProposal(aliasInput);
    const reviewed = await uc.reviewProposal({
      kind: 'alias',
      proposalId: created.proposalId,
      decision: 'approve',
      reviewedBy: 'op',
      decisionReason: 'verified',
    });
    expect(reviewed.status).toBe('approved');
  });

  it('publishes an approved proposal (staging marker)', async () => {
    const created = await uc.submitAliasProposal(aliasInput);
    await uc.reviewProposal({
      kind: 'alias', proposalId: created.proposalId, decision: 'approve', reviewedBy: 'op', decisionReason: 'ok',
    });
    const published = await uc.publishProposal({
      kind: 'alias', proposalId: created.proposalId, reviewedBy: 'op', targetSnapshotVersion: 'snap-1',
    });
    expect(published.status).toBe('published');
  });

  it('rejects publishing a pending proposal (illegal transition → 409 code)', async () => {
    const created = await uc.submitAliasProposal(aliasInput);
    await expect(
      uc.publishProposal({ kind: 'alias', proposalId: created.proposalId, reviewedBy: 'op' }),
    ).rejects.toBeInstanceOf(IllegalProposalTransitionError);
  });

  it('throws ProposalNotFoundError for an unknown id', async () => {
    await expect(
      uc.reviewProposal({ kind: 'alias', proposalId: 'nope', decision: 'approve', reviewedBy: 'op', decisionReason: 'x' }),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
  });

  it('throws ProposalConflictError when the optimistic transition loses the race', async () => {
    const created = await uc.submitAliasProposal(aliasInput);
    store.forceMissTransition = true;
    await expect(
      uc.reviewProposal({ kind: 'alias', proposalId: created.proposalId, decision: 'approve', reviewedBy: 'op', decisionReason: 'x' }),
    ).rejects.toBeInstanceOf(ProposalConflictError);
  });

  it('cannot re-review a terminal (rejected) proposal', async () => {
    const created = await uc.submitAliasProposal(aliasInput);
    await uc.reviewProposal({
      kind: 'alias', proposalId: created.proposalId, decision: 'reject', reviewedBy: 'op', decisionReason: 'no',
    });
    await expect(
      uc.reviewProposal({ kind: 'alias', proposalId: created.proposalId, decision: 'approve', reviewedBy: 'op', decisionReason: 'x' }),
    ).rejects.toBeInstanceOf(IllegalProposalTransitionError);
  });

  it('normalizes ambiguity normalizedForm before staging write', async () => {
    const p = await uc.submitAmbiguityProposal({
      normalizedForm: 'Opus One',
      memberEntityIds: ['ent-a', 'ent-b'],
      evidence: { severity: 'medium' },
    });
    expect(p.normalizedForm).toBe('opus one');
  });
});
