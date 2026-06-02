/**
 * PgCurationStore — live PostgreSQL integration (T-ELV2-07).
 *
 * Skip-when-unavailable: requires PG_TEST_URL (the nightly lane points it at a
 * disposable Postgres; local RDS runs skip). Verifies the staged review→publish
 * lifecycle, the optimistic transition guard, queue health, alias audit, and the
 * JSONB-corruption rejection path (CLAUDE.md rule 11 — never trust raw JSONB).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgCurationStore } from '../../../src/infrastructure/curation/pg-curation-store.js';

const PG_TEST_URL = process.env['PG_TEST_URL'];

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/infrastructure/db/migrations',
);

async function applyMigrations(pool: Pool): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  for (const file of files) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

async function truncate(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE alias_proposals, ambiguity_proposals, suppression_proposals, aliases',
  );
}

describe.skipIf(!PG_TEST_URL)('PgCurationStore (live PG integration)', () => {
  let pool: Pool;
  let store: PgCurationStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_TEST_URL, max: 2, connectionTimeoutMillis: 5_000 });
    await applyMigrations(pool);
    store = new PgCurationStore(pool);
  });

  afterAll(async () => {
    await truncate(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await truncate(pool);
  });

  it('creates an alias proposal as pending with a UUID and preserved evidence', async () => {
    const p = await store.createAliasProposal({
      surfaceForm: 'dom perignon',
      targetEntityId: 'ent-dp',
      proposedType: 'misspelling',
      confidence: 0.9,
      evidence: { reason: 'hot-entity coverage hole', source: 'coverage-report' },
      proposedBy: 'operator-1',
    });
    expect(p.kind).toBe('alias');
    expect(p.status).toBe('pending');
    expect(p.proposalId).toMatch(/[0-9a-f-]{36}/);
    expect(p.evidence).toEqual({ reason: 'hot-entity coverage hole', source: 'coverage-report' });
    expect(p.proposedBy).toBe('operator-1');
  });

  it('runs the full review→publish lifecycle with an optimistic guard', async () => {
    const created = await store.createAliasProposal({
      surfaceForm: 'opus one',
      targetEntityId: 'ent-opus',
      proposedType: 'observed_query_alias',
      confidence: 0.8,
      evidence: { k: 'v' },
    });

    // approve (pending → approved)
    const approved = await store.transitionProposal('alias', created.proposalId, {
      expectedFrom: 'pending',
      to: 'approved',
      reviewedBy: 'reviewer-1',
      reviewedAt: new Date(),
      decisionReason: 'verified exact alias',
    });
    expect(approved?.status).toBe('approved');
    expect(approved?.reviewedBy).toBe('reviewer-1');

    // optimistic guard: re-approving from pending now fails (row is approved)
    const stale = await store.transitionProposal('alias', created.proposalId, {
      expectedFrom: 'pending',
      to: 'approved',
    });
    expect(stale).toBeNull();

    // publish (approved → published)
    const published = await store.transitionProposal('alias', created.proposalId, {
      expectedFrom: 'approved',
      to: 'published',
      publishedAt: new Date(),
      targetSnapshotVersion: 'snap-2026-06-02',
    });
    expect(published?.status).toBe('published');
    expect(published?.publishedAt).toBeInstanceOf(Date);
    expect(published?.targetSnapshotVersion).toBe('snap-2026-06-02');
  });

  it('lists proposals across kinds and filters by status', async () => {
    await store.createAliasProposal({
      surfaceForm: 'a', targetEntityId: 'e1', proposedType: 'misspelling', confidence: 0.5, evidence: {},
    });
    await store.createSuppressionProposal({
      surfaceForm: 'trap', reason: 'wrong-positive trap', evidence: {},
    });
    const all = await store.listProposals({ limit: 50 });
    expect(all.map((p) => p.kind).sort()).toEqual(['alias', 'suppression']);

    const pendingOnly = await store.listProposals({ status: 'pending', limit: 50 });
    expect(pendingOnly).toHaveLength(2);
    const aliasOnly = await store.listProposals({ kind: 'alias', limit: 50 });
    expect(aliasOnly).toHaveLength(1);
    expect(aliasOnly[0]?.kind).toBe('alias');
  });

  it('reports queue health grouped by status and kind', async () => {
    await store.createAliasProposal({
      surfaceForm: 'a', targetEntityId: 'e1', proposedType: 'misspelling', confidence: 0.5, evidence: {},
    });
    await store.createAmbiguityProposal({
      normalizedForm: 'tignanello', memberEntityIds: ['e1', 'e2'], evidence: {},
    });
    const health = await store.getCurationHealth();
    expect(health.totalProposals).toBe(2);
    expect(health.queueByStatus.pending).toBe(2);
    expect(health.queueByKind.alias).toBe(1);
    expect(health.queueByKind.ambiguity).toBe(1);
  });

  it('alias audit surfaces live aliases and proposals touching the entity', async () => {
    await pool.query(
      `INSERT INTO aliases
         (alias_id, entity_id, alias_type, alias_scope, surface_form, normalized_value, source)
       VALUES ('al-1', 'ent-x', 'canonical', 'global', 'Château X', 'chateau x', 'curated')`,
    );
    await store.createAliasProposal({
      surfaceForm: 'chateau ex', targetEntityId: 'ent-x', proposedType: 'misspelling', confidence: 0.7, evidence: {},
    });
    const audit = await store.aliasAudit('ent-x');
    expect(audit.entityId).toBe('ent-x');
    expect(audit.aliases).toHaveLength(1);
    expect(audit.aliases[0]?.surfaceForm).toBe('Château X');
    expect(audit.relatedProposals).toHaveLength(1);
    expect(audit.relatedProposals[0]?.kind).toBe('alias');
  });

  it('rejects a corrupted JSONB evidence row instead of trusting it (rule 11)', async () => {
    // Directly insert a row whose evidence is a JSON ARRAY, not an object.
    const id = 'corrupt-1';
    await pool.query(
      `INSERT INTO alias_proposals
         (proposal_id, surface_form, target_entity_id, proposed_type, confidence, evidence, status)
       VALUES ($1, 's', 'e', 'misspelling', 0.5, '[1,2,3]'::jsonb, 'pending')`,
      [id],
    );
    await expect(store.getProposal('alias', id)).rejects.toThrow();
  });
});
