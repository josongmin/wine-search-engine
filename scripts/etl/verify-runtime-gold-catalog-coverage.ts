#!/usr/bin/env tsx
/**
 * ADR-007 cutover gate (runtime side):
 *
 * `verify-gold-catalog-coverage.ts` proves the fixture is internally consistent
 * (every non-null target in `target-entity-map.json` exists in
 * `canonical-entities.json`). That gate runs over the fixture only — it cannot
 * detect a publish that promotes a snapshot whose runtime tables are missing
 * a required canonical id.
 *
 * This verifier closes the runtime side: every non-null fixture target MUST
 * exist in BOTH the active snapshot's `entities` plane AND the
 * `canonical_entities` graph plane. Either gap is fail-closed and aborts
 * `publish-search-snapshot` before promotion.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';

import {
  loadGoldCanonicalLookup,
  resolveDefaultFixtureRepoRoot,
} from './snapshot-entity-identity.js';
import { isSourceRecordStylePublicEntityId } from '../../src/domain/shared/constants/public-entity-id-namespace.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { loadConfig } from '../../src/config/env.js';

const TargetMapSchema = z
  .object({
    map: z.record(z.string(), z.string().nullable()),
  })
  .passthrough();

export interface RuntimeGoldCoverageArgs {
  readonly pool: Pool;
  readonly snapshotId: string;
  readonly fixtureRepoRoot: string;
}

export interface RuntimeGoldCoverageResult {
  readonly snapshotId: string;
  readonly requiredCanonicalIds: number;
  readonly runtimePublicIdMatches: number;
  readonly runtimeBenchmarkLinkageMatches: number;
  readonly canonicalPublicIdMatches: number;
  readonly canonicalBenchmarkLinkageMatches: number;
  readonly missingFromEntities: readonly string[];
  readonly missingFromCanonicalEntities: readonly string[];
}

/**
 * Reads the fixture's `target-entity-map.json` and returns the unique set of
 * non-null canonical ids the runtime MUST host for the bench to be meaningful.
 */
export async function loadRequiredFixtureTargetIds(
  fixtureRepoRoot: string,
): Promise<readonly string[]> {
  const mapPath = join(fixtureRepoRoot, 'goldens', 'target-entity-map.json');
  const raw = await readFile(mapPath, 'utf8');
  const parsed = TargetMapSchema.parse(JSON.parse(raw) as unknown);
  const seen = new Set<string>();
  const required: string[] = [];
  for (const [caseId, target] of Object.entries(parsed.map)) {
    if (target == null) {
      continue;
    }
    if (isSourceRecordStylePublicEntityId(target)) {
      throw new Error(
        `target-entity-map references forbidden source-style id for ${caseId}: ${target}`,
      );
    }
    if (!seen.has(target)) {
      seen.add(target);
      required.push(target);
    }
  }
  // Cross-check the fixture's own canonical-entities.json so we never accept
  // a target that is not even declared in the gold catalog.
  const goldLookup = await loadGoldCanonicalLookup(fixtureRepoRoot);
  const goldIds = new Set(goldLookup.values());
  const fixtureMissing = required.filter((id) => !goldIds.has(id));
  if (fixtureMissing.length > 0) {
    throw new Error(
      `Fixture inconsistent: target-entity-map references canonical ids absent from canonical-entities.json:\n${fixtureMissing.join('\n')}`,
    );
  }
  return required;
}

/**
 * Asserts that every fixture-required canonical id is present in BOTH the
 * runtime `entities` table (for the active snapshot) AND the
 * `canonical_entities` graph plane. Throws on any gap.
 */
export async function verifyRuntimeGoldCatalogCoverage(
  args: RuntimeGoldCoverageArgs,
): Promise<RuntimeGoldCoverageResult> {
  const required = await loadRequiredFixtureTargetIds(args.fixtureRepoRoot);
  if (required.length === 0) {
    return {
      snapshotId: args.snapshotId,
      requiredCanonicalIds: 0,
      runtimePublicIdMatches: 0,
      runtimeBenchmarkLinkageMatches: 0,
      canonicalPublicIdMatches: 0,
      canonicalBenchmarkLinkageMatches: 0,
      missingFromEntities: [],
      missingFromCanonicalEntities: [],
    };
  }

  const requiredSet = new Set(required);
  const [entitiesResult, canonicalResult] = await Promise.all([
    args.pool.query<{ entity_id: string; benchmark_entity_id: string | null }>(
      `SELECT
         entity_id,
         metadata->>'benchmarkEntityId' AS benchmark_entity_id
         FROM entities
        WHERE search_snapshot_id = $1
          AND (
            entity_id = ANY($2::text[])
            OR metadata->>'benchmarkEntityId' = ANY($2::text[])
          )`,
      [args.snapshotId, required],
    ),
    args.pool.query<{ canonical_entity_id: string; benchmark_entity_id: string | null }>(
      `SELECT
         canonical_entity_id,
         source_provenance->>'benchmark_entity_id' AS benchmark_entity_id
         FROM canonical_entities
        WHERE
          search_snapshot_id = $1
          AND (
            canonical_entity_id = ANY($2::text[])
            OR source_provenance->>'benchmark_entity_id' = ANY($2::text[])
          )`,
      [args.snapshotId, required],
    ),
  ]);

  const runtimePublicIdMatches = new Set<string>();
  const runtimeBenchmarkLinkageMatches = new Set<string>();
  for (const row of entitiesResult.rows) {
    if (requiredSet.has(row.entity_id)) {
      runtimePublicIdMatches.add(row.entity_id);
    }
    if (row.benchmark_entity_id != null && requiredSet.has(row.benchmark_entity_id)) {
      runtimeBenchmarkLinkageMatches.add(row.benchmark_entity_id);
    }
  }

  const canonicalPublicIdMatches = new Set<string>();
  const canonicalBenchmarkLinkageMatches = new Set<string>();
  for (const row of canonicalResult.rows) {
    if (requiredSet.has(row.canonical_entity_id)) {
      canonicalPublicIdMatches.add(row.canonical_entity_id);
    }
    if (row.benchmark_entity_id != null && requiredSet.has(row.benchmark_entity_id)) {
      canonicalBenchmarkLinkageMatches.add(row.benchmark_entity_id);
    }
  }

  const runtimePlaneCoverage = new Set<string>([
    ...runtimePublicIdMatches,
    ...runtimeBenchmarkLinkageMatches,
  ]);
  const canonicalPlaneCoverage = new Set<string>([
    ...canonicalPublicIdMatches,
    ...canonicalBenchmarkLinkageMatches,
  ]);

  const missingFromEntities = required.filter((id) => !runtimePlaneCoverage.has(id));
  const missingFromCanonicalEntities = required.filter((id) => !canonicalPlaneCoverage.has(id));

  if (missingFromEntities.length > 0 || missingFromCanonicalEntities.length > 0) {
    const parts: string[] = [];
    if (missingFromEntities.length > 0) {
      parts.push(
        `entities (snapshot=${args.snapshotId}) missing ${missingFromEntities.length} runtime/public-linkage id(s): ${missingFromEntities.slice(0, 10).join(', ')}${missingFromEntities.length > 10 ? ', …' : ''}`,
      );
    }
    if (missingFromCanonicalEntities.length > 0) {
      parts.push(
        `canonical_entities missing ${missingFromCanonicalEntities.length} runtime/public-linkage id(s): ${missingFromCanonicalEntities.slice(0, 10).join(', ')}${missingFromCanonicalEntities.length > 10 ? ', …' : ''}`,
      );
    }
    throw new Error(`Runtime gold coverage failed: ${parts.join(' | ')}`);
  }

  const benchmarkLinkageParityResult = await args.pool.query<{
    entity_id: string;
    runtime_benchmark_entity_id: string | null;
    canonical_benchmark_entity_id: string | null;
  }>(
    `SELECT
       e.entity_id,
       e.metadata->>'benchmarkEntityId' AS runtime_benchmark_entity_id,
       ce.source_provenance->>'benchmark_entity_id' AS canonical_benchmark_entity_id
     FROM entities e
     LEFT JOIN canonical_entities ce
       ON ce.search_snapshot_id = e.search_snapshot_id
      AND ce.canonical_entity_id = e.entity_id
     WHERE e.search_snapshot_id = $1
       AND e.metadata ? 'benchmarkEntityId'`,
    [args.snapshotId],
  );

  const benchmarkLinkageDrift: { entityId: string; runtime: string; canonical: string | null }[] = [];
  for (const row of benchmarkLinkageParityResult.rows) {
    if (row.runtime_benchmark_entity_id == null) {
      continue;
    }
    if (row.canonical_benchmark_entity_id == null) {
      benchmarkLinkageDrift.push({
        entityId: row.entity_id,
        runtime: row.runtime_benchmark_entity_id,
        canonical: null,
      });
      continue;
    }
    if (row.runtime_benchmark_entity_id !== row.canonical_benchmark_entity_id) {
      benchmarkLinkageDrift.push({
        entityId: row.entity_id,
        runtime: row.runtime_benchmark_entity_id,
        canonical: row.canonical_benchmark_entity_id,
      });
    }
  }
  if (benchmarkLinkageDrift.length > 0) {
    const sample = benchmarkLinkageDrift.slice(0, 5).map((d) =>
      `${d.entityId}: runtime benchmarkEntityId=${d.runtime} vs canonical benchmark_entity_id=${d.canonical}`,
    ).join(' | ');
    throw new Error(
      `Benchmark linkage drift: ${benchmarkLinkageDrift.length} entity row(s) disagree on benchmark linkage. ${sample}${benchmarkLinkageDrift.length > 5 ? ' | …' : ''}`,
    );
  }

  // T-011/W3: identity authority parity.
  //
  // For every runtime entity_id in the active snapshot, the matching
  // canonical_identity_authority row must map the SAME identity_signature
  // to the SAME canonical_entity_id. A mismatch means one plane has been
  // re-hashed or re-bound relative to the global authority table — the
  // runtime is serving an id whose identity authority has drifted.
  const parityResult = await args.pool.query<{
    entity_id: string;
    runtime_signature: string;
    authority_signature: string | null;
    authority_entity_id: string | null;
  }>(
    `SELECT
       e.entity_id,
       e.identity_signature AS runtime_signature,
       cia.identity_signature AS authority_signature,
       cia.canonical_entity_id AS authority_entity_id
     FROM entities e
     LEFT JOIN canonical_identity_authority cia
       ON cia.identity_signature = e.identity_signature
     WHERE e.search_snapshot_id = $1`,
    [args.snapshotId],
  );
  const identityDrift: { entityId: string; runtime: string; authoritySignature: string | null; authorityEntityId: string | null }[] = [];
  for (const row of parityResult.rows) {
    if (row.authority_signature == null || row.authority_entity_id == null) {
      identityDrift.push({
        entityId: row.entity_id,
        runtime: row.runtime_signature,
        authoritySignature: row.authority_signature,
        authorityEntityId: row.authority_entity_id,
      });
      continue;
    }
    if (row.runtime_signature !== row.authority_signature || row.entity_id !== row.authority_entity_id) {
      identityDrift.push({
        entityId: row.entity_id,
        runtime: row.runtime_signature,
        authoritySignature: row.authority_signature,
        authorityEntityId: row.authority_entity_id,
      });
    }
  }
  if (identityDrift.length > 0) {
    const sample = identityDrift.slice(0, 5).map((d) =>
      `${d.entityId}: runtime_signature=${d.runtime} vs authority_signature=${d.authoritySignature}, authority_entity_id=${d.authorityEntityId}`,
    ).join(' | ');
    throw new Error(
      `Identity authority drift: ${identityDrift.length} runtime row(s) disagree with canonical_identity_authority. ${sample}${identityDrift.length > 5 ? ' | …' : ''}`,
    );
  }

  return {
    snapshotId: args.snapshotId,
    requiredCanonicalIds: required.length,
    runtimePublicIdMatches: runtimePublicIdMatches.size,
    runtimeBenchmarkLinkageMatches: runtimeBenchmarkLinkageMatches.size,
    canonicalPublicIdMatches: canonicalPublicIdMatches.size,
    canonicalBenchmarkLinkageMatches: canonicalBenchmarkLinkageMatches.size,
    missingFromEntities,
    missingFromCanonicalEntities,
  };
}

interface CliArgs {
  readonly snapshotId: string;
  readonly fixtureRepoRoot: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let snapshotId: string | undefined;
  let fixtureRepoRoot: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--snapshot-id') {
      snapshotId = argv[i + 1];
      i += 1;
    } else if (arg === '--fixture-repo') {
      fixtureRepoRoot = argv[i + 1];
      i += 1;
    }
  }
  if (snapshotId == null || snapshotId.length === 0) {
    throw new Error('--snapshot-id is required');
  }
  const root = resolveFixtureRoot(fixtureRepoRoot);
  return { snapshotId, fixtureRepoRoot: root };
}

function resolveFixtureRoot(explicit: string | undefined): string {
  if (explicit != null && explicit.length > 0) {
    const root = normalize(isAbsolute(explicit) ? explicit : resolve(explicit));
    if (!existsSync(root)) {
      throw new Error(`--fixture-repo path does not exist: ${root}`);
    }
    return root;
  }
  const def = resolveDefaultFixtureRepoRoot();
  if (def == null) {
    throw new Error(
      'Fixture repo not found: set FIXTURE_REPO_PATH or --fixture-repo, or clone wine-engine-fixture as a sibling.',
    );
  }
  return def;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required for runtime gold coverage verification');
  }
  const pool = createPgPool(config.pg);
  try {
    const result = await verifyRuntimeGoldCatalogCoverage({
      pool,
      snapshotId: args.snapshotId,
      fixtureRepoRoot: args.fixtureRepoRoot,
    });
    console.log(
      JSON.stringify({
        result: 'passed',
        snapshot_id: result.snapshotId,
        required_canonical_ids: result.requiredCanonicalIds,
        fixture_root: args.fixtureRepoRoot,
      }),
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
