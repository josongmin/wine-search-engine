#!/usr/bin/env tsx
/**
 * Upserts ADR-007 canonical graph tables from an existing search snapshot manifest
 * (entities / aliases / ambiguity NDJSON). Intended for repair/backfill or CI after migrations.
 *
 * Usage:
 *   npx tsx scripts/etl/ingest-canonical-entity-graph.ts --manifest path/to/manifest.json
 */

import fs from 'node:fs/promises';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { parseNdjson } from './ndjson.js';
import {
  parseManifest,
  type AliasSnapshotRecord,
  type AmbiguityRegistrySnapshotRow,
  type EntitySnapshotRecord,
  type SearchSnapshotManifest,
} from './search-snapshot-schema.js';
import { applyFullCanonicalGraphSync } from './canonical-entity-graph-sync.js';

interface Args {
  readonly manifestPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  let manifestPath = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest' || arg === '-m') {
      manifestPath = argv[i + 1] ?? '';
      i += 1;
    }
  }
  if (manifestPath.length === 0) {
    throw new Error('--manifest is required');
  }
  return { manifestPath };
}

async function loadManifest(manifestPath: string): Promise<SearchSnapshotManifest> {
  return parseManifest(await fs.readFile(manifestPath, 'utf8'), manifestPath);
}

async function loadEntities(manifest: SearchSnapshotManifest): Promise<readonly EntitySnapshotRecord[]> {
  const raw = await fs.readFile(manifest.artifacts.entitiesNdjson, 'utf8');
  return parseNdjson<EntitySnapshotRecord>(raw, manifest.artifacts.entitiesNdjson).records;
}

async function loadAliases(manifest: SearchSnapshotManifest): Promise<readonly AliasSnapshotRecord[]> {
  const raw = await fs.readFile(manifest.artifacts.aliasesNdjson, 'utf8');
  return parseNdjson<AliasSnapshotRecord>(raw, manifest.artifacts.aliasesNdjson).records;
}

async function loadAmbiguity(
  manifest: SearchSnapshotManifest,
): Promise<readonly AmbiguityRegistrySnapshotRow[]> {
  const raw = await fs.readFile(manifest.artifacts.ambiguityRegistryNdjson, 'utf8');
  return parseNdjson<AmbiguityRegistrySnapshotRow>(raw, manifest.artifacts.ambiguityRegistryNdjson).records;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(args.manifestPath);
  const [entities, aliases, ambiguityRows] = await Promise.all([
    loadEntities(manifest),
    loadAliases(manifest),
    loadAmbiguity(manifest),
  ]);
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required');
  }
  const pool = createPgPool(config.pg);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyFullCanonicalGraphSync(client, {
      entities,
      aliases,
      ambiguityRows,
      searchSnapshotId: manifest.snapshotId,
    });
    await client.query('COMMIT');
    console.log(
      JSON.stringify({
        result: 'passed',
        snapshot_id: manifest.snapshotId,
        canonical_entities_upserted: entities.length,
        canonical_aliases_inserted: aliases.length,
        canonical_ambiguity_rows_inserted: ambiguityRows.length,
      }),
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
