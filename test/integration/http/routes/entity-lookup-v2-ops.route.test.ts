import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { errorHandler } from '../../../../src/interface/http/middleware/error-handler.js';
import { registerRequestContext } from '../../../../src/interface/http/middleware/request-context.js';
import { registerHttpDebugMode } from '../../../../src/interface/http/middleware/http-debug-mode.js';
import { registerHttpOpsWriteMode } from '../../../../src/interface/http/middleware/http-ops-write-mode.js';
import { registerEntityLookupV2OpsCurationRoutes } from '../../../../src/interface/http/routes/entity-lookup-v2-ops.route.js';
import { CurationUseCase } from '../../../../src/application/curation/curation.usecase.js';
import {
  type Proposal,
  type ProposalKind,
} from '../../../../src/domain/curation/model/proposal.js';
import type {
  AliasAuditView,
  CreateAliasProposalInput,
  CreateAmbiguityProposalInput,
  CreateSuppressionProposalInput,
  CurationHealth,
  CurationStorePort,
  ProposalListFilter,
  ProposalTransition,
} from '../../../../src/domain/curation/port/curation-store.port.js';

const DEBUG_SECRET = 'test-debug-secret-1234567890';
const WRITE_SECRET = 'test-ops-write-secret-distinct-09';

/** Minimal in-memory store so the use-case's 404/409 paths run for real. */
class MemStore implements CurationStorePort {
  private readonly byId = new Map<string, Proposal>();
  private seq = 0;
  private id() { this.seq += 1; return `p-${this.seq}`; }

  async createAliasProposal(i: CreateAliasProposalInput) {
    const p: Proposal = {
      kind: 'alias', proposalId: this.id(), status: 'pending', evidence: i.evidence,
      surfaceForm: i.surfaceForm, targetEntityId: i.targetEntityId, proposedType: i.proposedType,
      confidence: i.confidence, createdAt: new Date(0), updatedAt: new Date(0),
    };
    this.byId.set(p.proposalId, p);
    return p;
  }
  async createAmbiguityProposal(i: CreateAmbiguityProposalInput) {
    const p: Proposal = {
      kind: 'ambiguity', proposalId: this.id(), status: 'pending', evidence: i.evidence,
      normalizedForm: i.normalizedForm, memberEntityIds: i.memberEntityIds,
      createdAt: new Date(0), updatedAt: new Date(0),
    };
    this.byId.set(p.proposalId, p);
    return p;
  }
  async createSuppressionProposal(i: CreateSuppressionProposalInput) {
    const p: Proposal = {
      kind: 'suppression', proposalId: this.id(), status: 'pending', evidence: i.evidence,
      surfaceForm: i.surfaceForm, reason: i.reason, createdAt: new Date(0), updatedAt: new Date(0),
    };
    this.byId.set(p.proposalId, p);
    return p;
  }
  async getProposal(_k: ProposalKind, id: string) { return this.byId.get(id) ?? null; }
  async listProposals(_f: ProposalListFilter) { return [...this.byId.values()]; }
  async transitionProposal(_k: ProposalKind, id: string, t: ProposalTransition) {
    const cur = this.byId.get(id);
    if (cur === undefined || cur.status !== t.expectedFrom) return null;
    const next = { ...cur, status: t.to } as Proposal;
    this.byId.set(id, next);
    return next;
  }
  async aliasAudit(entityId: string): Promise<AliasAuditView> {
    return { entityId, aliases: [], relatedProposals: [...this.byId.values()] };
  }
  async getCurationHealth(): Promise<CurationHealth> {
    return {
      queueByStatus: { pending: this.byId.size, approved: 0, rejected: 0, published: 0 },
      queueByKind: { alias: 0, ambiguity: 0, suppression: 0 },
      totalProposals: this.byId.size,
      publishedAwaitingMaterialization: 0,
      legacyApprovedAbbreviationBacklog: 0,
    };
  }
}

function post(app: FastifyInstance, url: string, payload: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload });
}

const aliasSubmit = {
  kind: 'alias', surface_form: 'dom perignon', target_entity_id: 'ent-dp',
  proposed_type: 'misspelling', confidence: 0.9, evidence: {},
};

describe('/v2/entity-lookup/ops/* curation plane (T-ELV2-07)', () => {
  let app: FastifyInstance;
  let store: MemStore;

  beforeEach(async () => {
    app = Fastify();
    registerRequestContext(app);
    registerHttpDebugMode(app, { secret: DEBUG_SECRET });
    registerHttpOpsWriteMode(app, { secret: WRITE_SECRET });
    app.setErrorHandler(errorHandler);
    store = new MemStore();
    registerEntityLookupV2OpsCurationRoutes(app, { curationUseCase: new CurationUseCase(store) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // --- read gate (X-Debug-Key) ---
  it('403s a read without the debug key', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/coverage-health', {});
    expect(res.statusCode).toBe(403);
  });

  it('serves coverage-health with the debug key', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/coverage-health', {}, { 'x-debug-key': DEBUG_SECRET });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('queue_by_status');
    expect(body).toHaveProperty('total_proposals');
    expect(body).toHaveProperty('published_awaiting_materialization');
    expect(body).toHaveProperty('legacy_approved_abbreviation_backlog');
  });

  it('includes lookup_runtime substrate when wired on coverage-health', async () => {
    await app.close();
    app = Fastify();
    registerRequestContext(app);
    registerHttpDebugMode(app, { secret: DEBUG_SECRET });
    registerHttpOpsWriteMode(app, { secret: WRITE_SECRET });
    app.setErrorHandler(errorHandler);
    store = new MemStore();
    registerEntityLookupV2OpsCurationRoutes(app, {
      curationUseCase: new CurationUseCase(store),
      lookupOpsRuntime: {
        searchSnapshotId: 'search-snapshot:v1:test',
        familyGraphEdgeCount: 12,
        ltrSupportStatus: 'unsupported',
        ltrSupportReason: 'lookup_domain_model_absent',
        unwiredSubstrateIds: ['pg_alias_matcher_trigram', 'lookup_ltr_rerank'],
      },
    });
    await app.ready();

    const res = await post(app, '/v2/entity-lookup/ops/coverage-health', {}, { 'x-debug-key': DEBUG_SECRET });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      lookup_runtime?: {
        search_snapshot_id?: string;
        family_graph_edge_count: number;
        unwired_substrate_ids: string[];
      };
    };
    expect(body.lookup_runtime?.search_snapshot_id).toBe('search-snapshot:v1:test');
    expect(body.lookup_runtime?.family_graph_edge_count).toBe(12);
    expect(body.lookup_runtime?.unwired_substrate_ids).toContain('lookup_ltr_rerank');
  });

  it('serves alias-audit with the debug key', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/alias-audit', { entity_id: 'ent-x' }, { 'x-debug-key': DEBUG_SECRET });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { entity_id: string }).entity_id).toBe('ent-x');
  });

  // --- write gate (X-Ops-Write-Key) ---
  it('403s a write with only the debug key (read key cannot mutate)', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/proposals/submit', aliasSubmit, { 'x-debug-key': DEBUG_SECRET });
    expect(res.statusCode).toBe(403);
  });

  it('403s a write with no key at all', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/proposals/submit', aliasSubmit);
    expect(res.statusCode).toBe(403);
  });

  it('submits a proposal with the write key', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/proposals/submit', aliasSubmit, { 'x-ops-write-key': WRITE_SECRET });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { proposal: { status: string; kind: string } };
    expect(body.proposal.status).toBe('pending');
    expect(body.proposal.kind).toBe('alias');
  });

  it('submits legacy ops-console evidence with note key', async () => {
    const res = await post(
      app,
      '/v2/entity-lookup/ops/proposals/submit',
      {
        ...aliasSubmit,
        evidence: { source: 'ops_console', note: 'menu verified' },
      },
      { 'x-ops-write-key': WRITE_SECRET },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { proposal: { evidence: Record<string, unknown> } };
    expect(body.proposal.evidence).toEqual({
      source: 'ops_console',
      operator_note: 'menu verified',
    });
  });

  it('submits RFC-014 snake_case operator_note evidence', async () => {
    const res = await post(
      app,
      '/v2/entity-lookup/ops/proposals/submit',
      {
        ...aliasSubmit,
        evidence: { source: 'ops_console', operator_note: 'wire verified' },
      },
      { 'x-ops-write-key': WRITE_SECRET },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { proposal: { evidence: Record<string, unknown> } };
    expect(body.proposal.evidence).toEqual({
      source: 'ops_console',
      operator_note: 'wire verified',
    });
  });

  it('submits ambiguity proposal with normalized_form and snake_case evidence', async () => {
    const res = await post(
      app,
      '/v2/entity-lookup/ops/proposals/submit',
      {
        kind: 'ambiguity',
        normalized_form: 'Opus One',
        member_entity_ids: ['ent-a', 'ent-b'],
        evidence: { source: 'ops_console', ambiguity_types: ['operator_curation'], severity: 'medium' },
      },
      { 'x-ops-write-key': WRITE_SECRET },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      proposal: { kind: string; normalized_form: string; evidence: Record<string, unknown> };
    };
    expect(body.proposal.kind).toBe('ambiguity');
    expect(body.proposal.normalized_form).toBe('opus one');
    expect(body.proposal.evidence).toEqual({
      source: 'ops_console',
      ambiguity_types: ['operator_curation'],
      severity: 'medium',
    });
  });

  it('submits suppression proposal with scoped target and evidence wire mapping', async () => {
    const res = await post(
      app,
      '/v2/entity-lookup/ops/proposals/submit',
      {
        kind: 'suppression',
        surface_form: 'bad alias',
        target_entity_id: 'ent-x',
        reason: 'operator verified noise',
        evidence: { source: 'ops_console', note: 'menu verified' },
      },
      { 'x-ops-write-key': WRITE_SECRET },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      proposal: { kind: string; surface_form: string; reason: string; evidence: Record<string, unknown> };
    };
    expect(body.proposal.kind).toBe('suppression');
    expect(body.proposal.surface_form).toBe('bad alias');
    expect(body.proposal.reason).toBe('operator verified noise');
    expect(body.proposal.evidence).toEqual({
      source: 'ops_console',
      operator_note: 'menu verified',
    });
  });

  it('runs submit→review reject through the write plane', async () => {
    const submitted = await post(app, '/v2/entity-lookup/ops/proposals/submit', aliasSubmit, { 'x-ops-write-key': WRITE_SECRET });
    const id = (submitted.json() as { proposal: { proposal_id: string } }).proposal.proposal_id;

    const reviewed = await post(app, '/v2/entity-lookup/ops/proposals/review',
      { kind: 'alias', proposal_id: id, decision: 'reject', reviewed_by: 'op', decision_reason: 'bad surface' },
      { 'x-ops-write-key': WRITE_SECRET });
    expect(reviewed.statusCode).toBe(200);
    expect((reviewed.json() as { proposal: { status: string } }).proposal.status).toBe('rejected');
  });

  it('runs submit→review→publish through the write plane', async () => {
    const submitted = await post(app, '/v2/entity-lookup/ops/proposals/submit', aliasSubmit, { 'x-ops-write-key': WRITE_SECRET });
    const id = (submitted.json() as { proposal: { proposal_id: string } }).proposal.proposal_id;

    const reviewed = await post(app, '/v2/entity-lookup/ops/proposals/review',
      { kind: 'alias', proposal_id: id, decision: 'approve', reviewed_by: 'op', decision_reason: 'ok' },
      { 'x-ops-write-key': WRITE_SECRET });
    expect(reviewed.statusCode).toBe(200);
    expect((reviewed.json() as { proposal: { status: string } }).proposal.status).toBe('approved');

    const published = await post(app, '/v2/entity-lookup/ops/proposals/publish',
      { kind: 'alias', proposal_id: id, reviewed_by: 'op', target_snapshot_version: 'snap-1' },
      { 'x-ops-write-key': WRITE_SECRET });
    expect(published.statusCode).toBe(200);
    expect((published.json() as { proposal: { status: string } }).proposal.status).toBe('published');
  });

  it('runs ambiguity submit→review→publish with kind on review/publish', async () => {
    const submitted = await post(
      app,
      '/v2/entity-lookup/ops/proposals/submit',
      {
        kind: 'ambiguity',
        normalized_form: 'opus one',
        member_entity_ids: ['ent-a', 'ent-b'],
        evidence: {},
      },
      { 'x-ops-write-key': WRITE_SECRET },
    );
    const id = (submitted.json() as { proposal: { proposal_id: string } }).proposal.proposal_id;

    const reviewed = await post(
      app,
      '/v2/entity-lookup/ops/proposals/review',
      { kind: 'ambiguity', proposal_id: id, decision: 'approve', reviewed_by: 'op', decision_reason: 'ok' },
      { 'x-ops-write-key': WRITE_SECRET },
    );
    expect(reviewed.statusCode).toBe(200);

    const published = await post(
      app,
      '/v2/entity-lookup/ops/proposals/publish',
      { kind: 'ambiguity', proposal_id: id, reviewed_by: 'op' },
      { 'x-ops-write-key': WRITE_SECRET },
    );
    expect(published.statusCode).toBe(200);
    expect((published.json() as { proposal: { kind: string; status: string } }).proposal).toEqual(
      expect.objectContaining({ kind: 'ambiguity', status: 'published' }),
    );
  });

  it('404s a review of an unknown proposal', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/proposals/review',
      { kind: 'alias', proposal_id: 'nope', decision: 'approve', reviewed_by: 'op', decision_reason: 'x' },
      { 'x-ops-write-key': WRITE_SECRET });
    expect(res.statusCode).toBe(404);
  });

  it('409s publishing a still-pending proposal (illegal transition)', async () => {
    const submitted = await post(app, '/v2/entity-lookup/ops/proposals/submit', aliasSubmit, { 'x-ops-write-key': WRITE_SECRET });
    const id = (submitted.json() as { proposal: { proposal_id: string } }).proposal.proposal_id;
    const res = await post(app, '/v2/entity-lookup/ops/proposals/publish',
      { kind: 'alias', proposal_id: id, reviewed_by: 'op' },
      { 'x-ops-write-key': WRITE_SECRET });
    expect(res.statusCode).toBe(409);
  });

  it('400s a malformed submit body (bad confidence)', async () => {
    const res = await post(app, '/v2/entity-lookup/ops/proposals/submit',
      { ...aliasSubmit, confidence: 2 },
      { 'x-ops-write-key': WRITE_SECRET });
    expect(res.statusCode).toBe(400);
  });
});
