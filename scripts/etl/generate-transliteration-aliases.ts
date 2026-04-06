#!/usr/bin/env tsx
/**
 * Batch transliteration aliases (RFC-003): reads `entities`, runs the rule-based
 * {@link Transliterator}, and upserts Korean surface forms into `aliases`.
 *
 * Intended for data ingestion / backfill — not query-time (that path uses
 * QueryNormalizer inline rules).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/etl/generate-transliteration-aliases.ts
 *   npx tsx --env-file=.env scripts/etl/generate-transliteration-aliases.ts --dry-run --limit 50
 *   npx tsx --env-file=.env scripts/etl/generate-transliteration-aliases.ts --entity-id chateau-margaux-2015
 *
 * Requires: PG_PASSWORD (and other PG_* vars) for a live database.
 */

import 'dotenv/config';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { PgAliasRepository } from '../../src/infrastructure/adapter/pg-alias-repository.js';
import { Transliterator, type SourceLang } from '../../src/domain/alias/service/transliterator.js';
import { createAlias } from '../../src/domain/alias/model/alias.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

interface Args {
  readonly dryRun: boolean;
  readonly limit: number;
  readonly entityId: string | null;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let limit = 0;
  let entityId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--limit') limit = Math.max(0, Number(argv[++i] ?? '0'));
    else if (a === '--entity-id') entityId = argv[++i] ?? null;
  }
  return { dryRun, limit, entityId };
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

/**
 * Rough heuristic: map catalog geography to a transliteration rule set.
 */
function inferSourceLang(country: string | null, region: string | null): SourceLang {
  const c = (country ?? '').toLowerCase();
  const r = (region ?? '').toLowerCase();
  if (c.includes('italy') || r.includes('tuscany') || r.includes('piemonte') || r.includes('barolo')) {
    return 'it';
  }
  if (c.includes('spain') || r.includes('rioja') || r.includes('ribera')) {
    return 'es';
  }
  if (
    c.includes('united states')
    || c === 'usa'
    || c.includes('australia')
    || c.includes('new zealand')
    || c.includes('chile')
    || c.includes('argentina')
    || c.includes('canada')
  ) {
    return 'en';
  }
  return 'fr';
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
  const repo = new PgAliasRepository(pool);
  const transliterator = new Transliterator();

  let query = `SELECT entity_id, canonical_label, attributes FROM entities`;
  const params: unknown[] = [];
  if (args.entityId !== null) {
    query += ` WHERE entity_id = $1`;
    params.push(args.entityId);
  }
  query += ` ORDER BY entity_id`;

  const result = await pool.query<EntityRow>(query, params);
  const rows = result.rows;

  let processed = 0;
  let inserted = 0;

  for (const row of rows) {
    if (args.limit > 0 && processed >= args.limit) {
      break;
    }
    processed += 1;

    const country = readCountry(row.attributes);
    const region = readRegion(row.attributes);
    const lang = inferSourceLang(country, region);
    const entityId = createEntityId(row.entity_id);

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
        inserted += 1;
        continue;
      }

      await repo.save(alias);
      inserted += 1;
    }
  }

  await pool.end();

  console.log(
    `Done. Entities processed: ${processed}, alias rows ${args.dryRun ? 'would write' : 'written'}: ${inserted}.`,
  );
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
