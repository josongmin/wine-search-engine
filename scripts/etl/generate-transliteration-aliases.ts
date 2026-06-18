#!/usr/bin/env tsx
/**
 * Batch transliteration aliases (RFC-003): reads `entities` from the ACTIVE
 * snapshot, runs the rule-based {@link Transliterator}, and **emits NDJSON**
 * of AliasSnapshotRecord rows for the next snapshot build to consume.
 *
 * This script used to write directly into the runtime `aliases` table via
 * PgAliasRepository.save(). Migration 016 collapses runtime writes to a single
 * authority (publish-runtime-substrates.ts), so this script now produces a
 * snapshot-build artifact instead. The next snapshot build merges the
 * emitted NDJSON into `aliases.ndjson`; publish-runtime-substrates writes it
 * into the composite-PK runtime plane.
 *
 * Usage:
 *   pnpm exec tsx scripts/etl/generate-transliteration-aliases.ts --out data/transliteration-aliases.ndjson
 *   pnpm exec tsx scripts/etl/generate-transliteration-aliases.ts --dry-run --limit 50
 *   pnpm exec tsx scripts/etl/generate-transliteration-aliases.ts --entity-id chateau-margaux-2015
 *
 * Output format: one JSON object per line matching AliasSnapshotRecord.
 *
 * Requires: PG_PASSWORD (and other PG_* vars) for a live database + active
 * snapshot pointer row.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { Transliterator, type SourceLang } from '../../src/domain/alias/service/transliterator.js';
import { createAlias } from '../../src/domain/alias/model/alias.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import { resolveActiveSnapshot } from '../../src/infrastructure/db/active-snapshot-resolver.js';
import { inferTransliterationSourceLang } from './transliteration-helpers.js';
import type { AliasSnapshotRecord } from './search-snapshot-schema.js';
import { computeAliasPhoneticKeys } from '../../src/domain/alias/service/alias-phonetic-keys.js';

const DEFAULT_OUT_PATH = 'data/transliteration-aliases.ndjson';

interface Args {
  readonly dryRun: boolean;
  readonly limit: number;
  readonly entityId: string | null;
  readonly outPath: string;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let limit = 0;
  let entityId: string | null = null;
  let outPath = DEFAULT_OUT_PATH;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--limit') limit = Math.max(0, Number(argv[++i] ?? '0'));
    else if (a === '--entity-id') entityId = argv[++i] ?? null;
    else if (a === '--out' || a === '-o') outPath = argv[++i] ?? DEFAULT_OUT_PATH;
  }
  return { dryRun, limit, entityId, outPath };
}

function readCountry(attributes: unknown): string | null {
  if (attributes === null || typeof attributes !== 'object') {
    return null;
  }
  const rec = attributes as Record<string, unknown>;
  const c = rec['country'];
  if (typeof c === 'string') {
    return c;
  }
  if (c !== null && typeof c === 'object' && 'name' in c && typeof (c as { name: unknown }).name === 'string') {
    return (c as { name: string }).name;
  }
  return null;
}

function readRegion(attributes: unknown): string | null {
  if (attributes === null || typeof attributes !== 'object') {
    return null;
  }
  const rec = attributes as Record<string, unknown>;
  const r = rec['region'];
  return typeof r === 'string' ? r : null;
}

interface EntityRow {
  readonly entity_id: string;
  readonly canonical_label: string;
  readonly attributes: unknown;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (!shouldUsePgPool(config.pg)) {
     
    console.error('PG_PASSWORD is required to connect to Postgres.');
    process.exit(1);
  }

  const pool = createPgPool(config.pg);
  const transliterator = new Transliterator();

  // Snapshot-scoped read (migration 016): reading across all snapshots would
  // produce aliases for stale entity states.
  const { activeSnapshotId } = await resolveActiveSnapshot(pool);

  let query = `SELECT entity_id, canonical_label, attributes
               FROM entities
               WHERE search_snapshot_id = $1`;
  const params: unknown[] = [activeSnapshotId];
  if (args.entityId !== null) {
    query += ` AND entity_id = $2`;
    params.push(args.entityId);
  }
  query += ` ORDER BY entity_id`;

  const result = await pool.query<EntityRow>(query, params);
  const rows = result.rows;

  const emittedRecords: AliasSnapshotRecord[] = [];
  let processed = 0;

  for (const row of rows) {
    if (args.limit > 0 && processed >= args.limit) {
      break;
    }
    processed += 1;

    const country = readCountry(row.attributes);
    const region = readRegion(row.attributes);
    const lang: SourceLang = inferTransliterationSourceLang(country, region);
    const entityId = createCanonicalEntityId(row.entity_id);

    const variants = transliterator.generateAliases(row.canonical_label, lang);

    for (const v of variants) {
      const alias = createAlias({
        entityId,
        value: v.value,
        type: v.type,
        confidencePrior: v.confidence,
        source: 'etl:transliterator_v1',
        scope: 'locale_ko',
      });

      if (args.dryRun) {
         
        console.log(`[dry-run] ${row.entity_id} (${lang}) → ${v.value} [${v.type}]`);
        emittedRecords.push(toAliasSnapshotRecord(alias));
        continue;
      }

      emittedRecords.push(toAliasSnapshotRecord(alias));
    }
  }

  await pool.end();

  if (!args.dryRun) {
    const absOut = path.isAbsolute(args.outPath)
      ? args.outPath
      : path.resolve(process.cwd(), args.outPath);
    await fs.mkdir(path.dirname(absOut), { recursive: true });
    const body = emittedRecords.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await fs.writeFile(absOut, body, 'utf-8');
  }

   
  console.log(
    `Done. Entities processed: ${processed}, alias records ${args.dryRun ? 'would emit' : `emitted to ${args.outPath}`}: ${emittedRecords.length}.`,
  );
}

function toAliasSnapshotRecord(alias: {
  readonly aliasId: string;
  readonly entityId: string;
  readonly value: string;
  readonly normalizedValue: string;
  readonly type: string;
  readonly scope: string;
  readonly source: string;
  readonly confidencePrior: number;
}): AliasSnapshotRecord {
  const phoneticKeys = computeAliasPhoneticKeys(alias.normalizedValue);
  return {
    aliasId: alias.aliasId,
    entityId: alias.entityId,
    value: alias.value,
    normalizedValue: alias.normalizedValue,
    type: alias.type,
    scope: alias.scope,
    source: alias.source,
    sourceTrust: 1.0,
    confidencePrior: alias.confidencePrior,
    ...(phoneticKeys.length > 0 ? { phoneticKeys } : {}),
  };
}

void main().catch((err: unknown) => {
   
  console.error(err);
  process.exit(1);
});
