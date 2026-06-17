/**
 * T-ELV2-03 regression — ops-published curation proposals must be consumable
 * by snapshot ETL (append-only).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

describe('curation proposal ETL consumption (T-ELV2-03)', () => {
  it('dedicated loader module exists and build-search-snapshot imports it', () => {
    const loader = read('scripts/etl/load-published-curation-proposals.ts');
    expect(loader).toContain('loadPublishedCurationProposals');
    expect(loader).toContain("status = 'published'");
    expect(loader).toContain('ambiguity_proposals');
    expect(loader).toContain('suppression_proposals');

    const snapshot = read('scripts/etl/build-search-snapshot.ts');
    expect(snapshot).toContain('loadPublishedCurationProposals');
    expect(snapshot).toContain('mergePublishedAmbiguityRows');
    expect(snapshot).toContain('applyPublishedSuppressionRules');
  });

  it('ETL no longer relies on promoted-only abbreviation status without published path', () => {
    const loader = read('scripts/etl/load-published-curation-proposals.ts');
    expect(loader).not.toContain("'promoted'");
    expect(loader).toContain("status = 'published'");
  });

  it('ETL marks materialized proposals after canonical publish completes', () => {
    const snapshot = read('scripts/etl/build-search-snapshot.ts');
    const publish = read('scripts/etl/publish-search-snapshot.ts');
    expect(snapshot).toContain('consumedCuration');
    expect(snapshot).not.toContain('await markPublishedCurationProposalsMaterialized');
    expect(publish).toContain('markPublishedCurationProposalsMaterialized');
    expect(publish).toContain('built.consumedCuration');
  });

  it('loader enforces pin alignment and refuses silent PG skip when configured', () => {
    const loader = read('scripts/etl/load-published-curation-proposals.ts');
    expect(loader).toContain('assertConsumedCurationPinsAlignWithSnapshot');
    expect(loader).toContain('CURATION_STAGING_PG_POOL_DISABLED_MESSAGE');
    expect(loader).toContain('openCurationStagingPgPoolOrNull');
    expect(loader).toContain('parseCurationAliasEvidence');
  });

  it('mark and pin guards share the same fail-loud PG pool helper', () => {
    const loader = read('scripts/etl/load-published-curation-proposals.ts');
    const publish = read('scripts/etl/publish-search-snapshot.ts');
    expect(loader).toContain('markPublishedCurationProposalsMaterialized');
    expect(loader.indexOf('openCurationStagingPgPoolOrNull')).toBeLessThan(
      loader.indexOf('markPublishedCurationProposalsMaterialized'),
    );
    expect(publish).toContain('markPublishedCurationProposalsMaterialized');
    const lastVerify = publish.lastIndexOf('verifySearchSnapshotReadiness');
    const markIndex = publish.indexOf('await markPublishedCurationProposalsMaterialized');
    expect(lastVerify).toBeGreaterThan(-1);
    expect(markIndex).toBeGreaterThan(lastVerify);
  });

  it('ops route wires evidence through explicit RFC-014 snake_case mapper', () => {
    const route = read('src/interface/http/routes/entity-lookup-v2-ops.route.ts');
    expect(route).toContain('wireCurationEvidenceFromDomain');
  });

  it('pg curation store canonicalizes evidence on write', () => {
    const store = read('src/infrastructure/curation/pg-curation-store.ts');
    expect(store).toContain('canonicalEvidenceForKind');
    expect(store).toContain('JSON.stringify(evidence)');
    expect(store).not.toContain('JSON.stringify(input.evidence)');
  });

  it('snapshot build enforces pin convergence and post-loop pin alignment', () => {
    const snapshot = read('scripts/etl/build-search-snapshot.ts');
    expect(snapshot).toContain('CURATION_SNAPSHOT_PIN_MAX_PASSES');
    expect(snapshot).toContain('assertConsumedCurationPinsAlignWithSnapshot');
    expect(snapshot).toContain('buildCurationPinConvergenceError');
  });

  it('mark materialized updates published rows only; legacy approved abbreviations stay transitional', () => {
    const loader = read('scripts/etl/load-published-curation-proposals.ts');
    expect(loader).toContain('isPublishedCurationConsumptionStatus');
    expect(loader).toContain("status = 'approved' AND proposed_type = 'abbreviation'");
    const markStart = loader.indexOf('export async function markPublishedCurationProposalsMaterialized');
    const markBody = loader.slice(markStart);
    expect(markBody).toContain("AND status = 'published'");
  });

  it('runbook-curation-materialization documents publish-time mark ordering', () => {
    const runbook = read('docs/runbook-curation-materialization.md');
    expect(runbook).toContain('etl:publish-search-snapshot');
    expect(runbook).toContain('does **not** clear');
  });

  it('migration 033 materialization columns exist with rollback', () => {
    const migration = read('src/infrastructure/db/migrations/033_lookup_v2_curation_materialization.sql');
    expect(migration).toContain('materialized_snapshot_id');
    const rollback = read('src/infrastructure/db/migrations/rollback/033_lookup_v2_curation_materialization_rollback.sql');
    expect(rollback).toContain('materialized_snapshot_id');
  });

  it('coverage-health exposes published awaiting materialization backlog', () => {
    const schema = read('src/interface/http/schemas/entity-lookup-v2-ops.schema.ts');
    expect(schema).toContain('published_awaiting_materialization');
    expect(schema).toContain('legacy_approved_abbreviation_backlog');
    expect(schema).toContain('lookup_runtime');
    const port = read('src/domain/curation/port/curation-store.port.ts');
    expect(port).toContain('publishedAwaitingMaterialization');
    expect(port).toContain('legacyApprovedAbbreviationBacklog');
  });

  it('migration 030 staging tables remain the ops write plane', () => {
    const migration = read('src/infrastructure/db/migrations/030_lookup_v2_curation_write_plane.sql');
    expect(migration).toContain('ambiguity_proposals');
    expect(migration).toContain('suppression_proposals');
    expect(migration).toContain("'published'");
  });

  it('composition root wires curation use case when pg pool is available', () => {
    const usecases = read('src/config/container-usecases.ts');
    expect(usecases).toContain('PgCurationStore');
    expect(usecases).toContain('new CurationUseCase');
    const server = read('src/interface/http/server.ts');
    expect(server).toContain('registerEntityLookupV2OpsCurationRoutes');
  });
});
