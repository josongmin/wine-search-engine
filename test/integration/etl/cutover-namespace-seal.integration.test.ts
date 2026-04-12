import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import {
  verifySearchSnapshotRuntimeStateLive,
  type LoadedSearchSnapshotRuntimeState,
} from '../../../src/infrastructure/health/search-snapshot-readiness.js';
import { verifyRuntimeGoldCatalogCoverage } from '../../../scripts/etl/verify-runtime-gold-catalog-coverage.js';
import { hashStableJson, hashText, stableJsonStringify } from '../../../src/shared/utils/stable-json.js';
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../../src/shared/constants/search-snapshot.js';
import { getCurrentFeatureSchemaHash } from '../../../src/domain/ranking/service/feature-parity-hash.js';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Cutover integration test (ADR-007).
 *
 * Goals (only meaningful with a live PG):
 *   1. The 5-plane namespace-seal SQL — including TEXT[] unnest and JSONB
 *      jsonb_array_elements_text — actually compiles and executes correctly
 *      against Postgres, not just the fake-pool unit fixture.
 *   2. Each violation plane (entities, canonical_entities, aliases,
 *      ambiguity_registry, canonical_ambiguity_registry) is detected
 *      independently and reported with its plane name.
 *   3. verifyRuntimeGoldCatalogCoverage finds missing canonical ids in
 *      both runtime planes against a real DB.
 *
 * Skip-when-unavailable: requires PG_TEST_URL. Vespa is intentionally
 * mocked at the fetch boundary so this lane never depends on a Vespa
 * cluster being up — Vespa-backed coverage lives in `test:e2e:vespa`.
 */

const PG_TEST_URL = process.env['PG_TEST_URL'];

const SNAPSHOT_ID = 'snap-cutover-it-1';
const CANONICAL_OPUS = 'opus-one-2018';
const CANONICAL_SASS = 'sassicaia-2017';
const FORBIDDEN_ID = 'vivino-12345';

async function applyMigrations(pool: Pool): Promise<void> {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../src/infrastructure/db/migrations',
  );
  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
  }
}

async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      canonical_aliases,
      canonical_ambiguity_registry,
      entity_source_links,
      canonical_entities,
      ambiguity_registry,
      aliases,
      entity_snapshots,
      entities,
      ltr_model_registry
    RESTART IDENTITY CASCADE
  `);
}

async function seedHappyState(pool: Pool): Promise<void> {
  // canonical_entities (graph plane) — must mirror runtime entity count
  await pool.query(
    `INSERT INTO canonical_entities (canonical_entity_id, entity_type, canonical_label, identity_signature, attributes, approval_state, source_provenance)
     VALUES
       ($1, 'wine', 'Opus One 2018', 'sig:opus', '{}'::jsonb, 'approved', $3::jsonb),
       ($2, 'wine', 'Sassicaia 2017', 'sig:sass', '{}'::jsonb, 'approved', $3::jsonb)`,
    [CANONICAL_OPUS, CANONICAL_SASS, JSON.stringify({ search_snapshot_id: SNAPSHOT_ID })],
  );

  // entities (runtime plane), bound to the active snapshot
  await pool.query(
    `INSERT INTO entities (entity_id, entity_type, canonical_label, identity_signature, search_snapshot_id)
     VALUES
       ($1, 'wine', 'Opus One 2018', 'sig:opus', $3),
       ($2, 'wine', 'Sassicaia 2017', 'sig:sass', $3)`,
    [CANONICAL_OPUS, CANONICAL_SASS, SNAPSHOT_ID],
  );

  // aliases — entity_id MUST match the canonical id (no source-style)
  await pool.query(
    `INSERT INTO aliases (alias_id, entity_id, alias_type, alias_scope, surface_form, normalized_value, source, source_trust, confidence, search_snapshot_id)
     VALUES
       ('a-opus', $1, 'canonical', 'global', 'Opus One', 'opus one', 'seed', 1.0, 0.95, $3),
       ('a-sass', $2, 'canonical', 'global', 'Sassicaia', 'sassicaia', 'seed', 1.0, 0.95, $3)`,
    [CANONICAL_OPUS, CANONICAL_SASS, SNAPSHOT_ID],
  );

  // ambiguity_registry (TEXT[] entity_ids)
  await pool.query(
    `INSERT INTO ambiguity_registry (registry_id, normalized_form, entity_ids, ambiguity_types, severity, search_snapshot_id)
     VALUES ('amb-1', 'opus', ARRAY[$1, $2]::text[], ARRAY['homonym']::text[], 'low', $3)`,
    [CANONICAL_OPUS, CANONICAL_SASS, SNAPSHOT_ID],
  );

  // canonical_aliases (graph plane) — joined to entities by FK shape; one row per alias
  await pool.query(
    `INSERT INTO canonical_aliases (alias_id, canonical_entity_id, surface_form, normalized_surface, alias_type, scope, approval_state, source, source_trust)
     VALUES
       ('ca-opus', $1, 'Opus One', 'opus one', 'canonical', 'global', 'approved', 'seed', 1.0),
       ('ca-sass', $2, 'Sassicaia', 'sassicaia', 'canonical', 'global', 'approved', 'seed', 1.0)`,
    [CANONICAL_OPUS, CANONICAL_SASS],
  );

  // canonical_ambiguity_registry (JSONB canonical_entity_ids)
  await pool.query(
    `INSERT INTO canonical_ambiguity_registry (registry_id, normalized_form, canonical_entity_ids, ambiguity_types, severity, approval_state)
     VALUES ('camb-1', 'opus', $1::jsonb, '["homonym"]'::jsonb, 'low', 'approved')`,
    [JSON.stringify([CANONICAL_OPUS, CANONICAL_SASS])],
  );

  // ltr_model_registry — at least one active row bound to the snapshot
  const featureHash = getCurrentFeatureSchemaHash();
  await pool.query(
    `INSERT INTO ltr_model_registry (model_id, query_class, model_version, weights, bias, eval_dataset_version, feature_schema_hash, is_active, search_snapshot_id)
     VALUES ('m1', 'retrieve', 1, '{0.1,0.2}'::float8[], 0, 'fixture-v1', $1, TRUE, $2)`,
    [featureHash, SNAPSHOT_ID],
  );
}

function buildRuntimeState(args: {
  readonly nlPath: string;
  readonly nlPayload: unknown;
}): LoadedSearchSnapshotRuntimeState {
  const activeLtrHash = hashStableJson([
    {
      query_class: 'retrieve',
      model_version: 1,
      eval_dataset_version: 'fixture-v1',
      feature_schema_hash: getCurrentFeatureSchemaHash(),
      weights: [0.1, 0.2],
      bias: 0,
    },
  ]);
  return {
    schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
    snapshotId: SNAPSHOT_ID,
    contentHash: 'h',
    publishedAt: '2026-04-12T00:00:00.000Z',
    manifestPath: '/tmp/m.json',
    nlMappingsRuntimePath: args.nlPath,
    allowMissingLtr: false,
    counts: {
      entities: 2,
      aliases: 2,
      ambiguityRegistry: 1,
      nlMappings: 1,
      activeLtrModels: 1,
    },
    hashes: {
      entities: 'e-ignored',
      aliases: 'a-ignored',
      ambiguityRegistry: 'r-ignored',
      nlMappings: hashText(`${stableJsonStringify(args.nlPayload)}\n`),
      activeLtrModels: activeLtrHash,
    },
  };
}

function mockVespa(args?: { snapshotDocCount?: number; sealViolations?: number }) {
  const docs = args?.snapshotDocCount ?? 2;
  const violations = args?.sealViolations ?? 0;
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ root: { fields: { totalCount: docs } } }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ root: { fields: { totalCount: violations } } }), { status: 200 }),
    );
}

describe.skipIf(!PG_TEST_URL)('ADR-007 cutover gates (live PG integration)', () => {
  let pool: Pool;
  let nlDir: string;
  let nlPath: string;
  const nlPayload = { mappings: [{ key: 'a', canonical: 'b' }] };

  beforeAll(async () => {
    pool = new Pool({
      connectionString: PG_TEST_URL,
      max: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
    });
    await applyMigrations(pool);
    nlDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cutover-it-'));
    nlPath = path.join(nlDir, 'nl.json');
    await fs.writeFile(nlPath, JSON.stringify(nlPayload));
  });

  afterAll(async () => {
    await truncateAll(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await seedHappyState(pool);
  });

  it('passes verifySearchSnapshotRuntimeStateLive on a clean canonical seed', async () => {
    const fetchSpy = mockVespa();
    try {
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState: buildRuntimeState({ nlPath, nlPayload }),
          strictHashes: false,
        }),
      ).resolves.toMatchObject({ snapshotId: SNAPSHOT_ID });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('detects entities namespace seal violation', async () => {
    await pool.query(
      `INSERT INTO entities (entity_id, entity_type, canonical_label, identity_signature, search_snapshot_id)
       VALUES ($1, 'wine', 'Legacy Vivino Wine', 'sig:legacy', $2)`,
      [FORBIDDEN_ID, SNAPSHOT_ID],
    );
    const fetchSpy = mockVespa();
    try {
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState: buildRuntimeState({ nlPath, nlPayload }),
        }),
      ).rejects.toThrow(/entities=1/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('detects canonical_entities namespace seal violation', async () => {
    await pool.query(
      `INSERT INTO canonical_entities (canonical_entity_id, entity_type, canonical_label, identity_signature, attributes, approval_state, source_provenance)
       VALUES ($1, 'wine', 'Legacy', 'sig:legacy-c', '{}'::jsonb, 'approved', '{}'::jsonb)`,
      [FORBIDDEN_ID],
    );
    const fetchSpy = mockVespa();
    try {
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState: buildRuntimeState({ nlPath, nlPayload }),
        }),
      ).rejects.toThrow(/canonical_entities=1/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('detects aliases namespace seal violation', async () => {
    await pool.query(
      `INSERT INTO aliases (alias_id, entity_id, alias_type, alias_scope, surface_form, normalized_value, source, source_trust, confidence, search_snapshot_id)
       VALUES ('legacy-alias', $1, 'canonical', 'global', 'Legacy', 'legacy', 'seed', 1, 0.5, $2)`,
      [FORBIDDEN_ID, SNAPSHOT_ID],
    );
    const fetchSpy = mockVespa();
    try {
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState: buildRuntimeState({ nlPath, nlPayload }),
        }),
      ).rejects.toThrow(/aliases=1/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('detects ambiguity_registry TEXT[] namespace seal violation via unnest()', async () => {
    await pool.query(
      `INSERT INTO ambiguity_registry (registry_id, normalized_form, entity_ids, ambiguity_types, severity, search_snapshot_id)
       VALUES ('amb-legacy', 'legacy', ARRAY[$1]::text[], ARRAY['homonym']::text[], 'low', $2)`,
      [FORBIDDEN_ID, SNAPSHOT_ID],
    );
    const fetchSpy = mockVespa();
    try {
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState: buildRuntimeState({ nlPath, nlPayload }),
        }),
      ).rejects.toThrow(/ambiguity_registry=1/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('detects canonical_ambiguity_registry JSONB namespace seal violation via jsonb_array_elements_text()', async () => {
    await pool.query(
      `INSERT INTO canonical_ambiguity_registry (registry_id, normalized_form, canonical_entity_ids, ambiguity_types, severity, approval_state)
       VALUES ('camb-legacy', 'legacy', $1::jsonb, '["homonym"]'::jsonb, 'low', 'approved')`,
      [JSON.stringify([FORBIDDEN_ID])],
    );
    const fetchSpy = mockVespa();
    try {
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState: buildRuntimeState({ nlPath, nlPayload }),
        }),
      ).rejects.toThrow(/canonical_ambiguity_registry=1/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('detects Vespa namespace seal violation via mocked fetch', async () => {
    const fetchSpy = mockVespa({ sealViolations: 4 });
    try {
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState: buildRuntimeState({ nlPath, nlPayload }),
        }),
      ).rejects.toThrow(/Vespa contains 4 document/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  describe('verifyRuntimeGoldCatalogCoverage', () => {
    async function makeFixtureRepo(targets: Record<string, string | null>): Promise<string> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cutover-it-fixture-'));
      const goldensDir = path.join(root, 'goldens');
      await fs.mkdir(goldensDir, { recursive: true });
      await fs.writeFile(
        path.join(goldensDir, 'canonical-entities.json'),
        JSON.stringify({
          entities: [
            { entity_id: CANONICAL_OPUS, canonical_label: 'Opus One', vintage: 2018 },
            { entity_id: CANONICAL_SASS, canonical_label: 'Sassicaia', vintage: 2017 },
          ],
        }),
      );
      await fs.writeFile(path.join(goldensDir, 'target-entity-map.json'), JSON.stringify({ map: targets }));
      return root;
    }

    it('passes when both planes contain every required canonical id', async () => {
      const root = await makeFixtureRepo({ 'case-1': CANONICAL_OPUS, 'case-2': CANONICAL_SASS });
      const result = await verifyRuntimeGoldCatalogCoverage({
        pool,
        snapshotId: SNAPSHOT_ID,
        fixtureRepoRoot: root,
      });
      expect(result.requiredCanonicalIds).toBe(2);
    });

    it('fails when a required id is missing from runtime entities for the active snapshot', async () => {
      const root = await makeFixtureRepo({ 'case-1': CANONICAL_OPUS, 'case-2': CANONICAL_SASS });
      await pool.query('DELETE FROM entities WHERE entity_id = $1', [CANONICAL_OPUS]);
      await expect(
        verifyRuntimeGoldCatalogCoverage({
          pool,
          snapshotId: SNAPSHOT_ID,
          fixtureRepoRoot: root,
        }),
      ).rejects.toThrow(new RegExp(`entities \\(snapshot=${SNAPSHOT_ID}\\) missing 1: ${CANONICAL_OPUS}`));
    });

    it('fails when a required id is missing from canonical_entities graph plane', async () => {
      const root = await makeFixtureRepo({ 'case-1': CANONICAL_OPUS, 'case-2': CANONICAL_SASS });
      await pool.query('DELETE FROM canonical_entities WHERE canonical_entity_id = $1', [CANONICAL_SASS]);
      await expect(
        verifyRuntimeGoldCatalogCoverage({
          pool,
          snapshotId: SNAPSHOT_ID,
          fixtureRepoRoot: root,
        }),
      ).rejects.toThrow(new RegExp(`canonical_entities missing 1: ${CANONICAL_SASS}`));
    });
  });
});
