/**
 * Bronze Vivino export — reads `wine_pdp_snapshot` rows with `source_id = 'vivino'`.
 *
 * Connection (pick one):
 *   - DATABASE_URL=postgresql://user:pass@host:port/dbname
 *   - PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *
 * RDS: if host contains `rds.amazonaws.com`, uses TLS with `rejectUnauthorized: false`
 * (same idea as typical internal tooling).
 *
 * Usage:
 *   npx tsx --env-file=.env tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts --limit 20
 *   npx tsx --env-file=.env tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts --count
 *   npx tsx --env-file=.env tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts --external-id 3961941
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import pg from 'pg';
import type { PoolConfig } from 'pg';

const SOURCE_ID = 'vivino';

function wantsRdsSsl(host: string): boolean {
  return host.includes('rds.amazonaws.com');
}

function poolFromEnv(): pg.Pool {
  const conn = process.env['DATABASE_URL'];
  if (conn !== undefined && conn.length > 0) {
    let host = '';
    try {
      host = new URL(conn).hostname;
    } catch {
      throw new Error('DATABASE_URL is not a valid URL');
    }
    const ssl = wantsRdsSsl(host) ? { rejectUnauthorized: false as const } : undefined;
    return new pg.Pool({
      connectionString: conn,
      ssl,
      max: 2,
      connectionTimeoutMillis: 20_000,
    });
  }

  const host = process.env['PG_HOST'];
  const port = Number(process.env['PG_PORT'] ?? '5432');
  const database = process.env['PG_DATABASE'];
  const user = process.env['PG_USER'];
  const password = process.env['PG_PASSWORD'];
  if (!host || !database || !user || password === undefined) {
    throw new Error(
      'Set DATABASE_URL or PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD',
    );
  }
  const ssl = wantsRdsSsl(host) ? { rejectUnauthorized: false as const } : undefined;
  const cfg: PoolConfig = {
    host,
    port,
    database,
    user,
    password,
    ssl,
    max: 2,
    connectionTimeoutMillis: 20_000,
  };
  return new pg.Pool(cfg);
}

type Args = {
  limit: number;
  offset: number;
  countOnly: boolean;
  externalId: string | undefined;
  nameContains: string | undefined;
  allColumns: boolean;
  outputPath: string | undefined;
  format: 'json' | 'ndjson';
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    limit: 100,
    offset: 0,
    countOnly: false,
    externalId: undefined,
    nameContains: undefined,
    allColumns: false,
    outputPath: undefined,
    format: 'json',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a === '--count') {
      out.countOnly = true;
      continue;
    }
    if (a === '--all-columns') {
      out.allColumns = true;
      continue;
    }
    if (a === '--limit') {
      out.limit = Math.max(1, Number(argv[++i] ?? '100'));
      continue;
    }
    if (a === '--offset') {
      out.offset = Math.max(0, Number(argv[++i] ?? '0'));
      continue;
    }
    if (a === '--external-id') {
      out.externalId = argv[++i];
      continue;
    }
    if (a === '--name') {
      out.nameContains = argv[++i];
      continue;
    }
    if (a === '--output' || a === '-o') {
      out.outputPath = argv[++i];
      continue;
    }
    if (a === '--format') {
      const f = argv[++i];
      if (f !== 'json' && f !== 'ndjson') {
        throw new Error('--format must be json or ndjson');
      }
      out.format = f;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function printHelp(): void {
  console.log(`
fetch-vivino-snapshots — export Vivino bronze rows from wine_pdp_snapshot

Environment:
  DATABASE_URL=postgresql://...   (preferred for RDS URLs)
  or PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD

Options:
  --count              print row count only (still filtered by source_id = vivino)
  --limit N            max rows (default 100; ignored with --count)
  --offset N           skip rows (default 0)
  --external-id ID     filter external_id = ID
  --name SUBSTRING     display_name ILIKE '%SUBSTRING%' (no wildcards needed)
  --all-columns        SELECT * instead of a fixed column list
  --format json|ndjson default json array; ndjson = one JSON object per line
  -o, --output PATH    write file instead of stdout
  -h, --help           this message
`);
}

function selectList(allColumns: boolean): string {
  if (allColumns) {
    return '*';
  }
  return [
    'id',
    'external_id',
    'display_name',
    'producer',
    'vintage_year',
    'region',
    'country',
    'wine_style',
    'rating',
    'price',
    'currency',
    'scraped_at',
    'source_url',
    'payload',
  ].join(', ');
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const pool = poolFromEnv();
  try {
    const where: string[] = [`source_id = $1`];
    const params: unknown[] = [SOURCE_ID];
    let p = 2;

    if (args.externalId !== undefined) {
      where.push(`external_id = $${String(p)}`);
      params.push(args.externalId);
      p++;
    }
    if (args.nameContains !== undefined) {
      where.push(`display_name ILIKE ('%' || $${String(p)}::text || '%')`);
      params.push(args.nameContains);
      p++;
    }

    const whereSql = where.join(' AND ');

    if (args.countOnly) {
      const q = `SELECT count(*)::bigint AS c FROM wine_pdp_snapshot WHERE ${whereSql}`;
      const r = await pool.query<{ c: string }>(q, params);
      const line = String(r.rows[0]?.c ?? '0');
      if (args.outputPath !== undefined) {
        await fs.writeFile(args.outputPath, `${line}\n`, 'utf8');
      } else {
        console.log(line);
      }
      return;
    }

    const cols = selectList(args.allColumns);
    const limIdx = p;
    const offIdx = p + 1;
    params.push(args.limit, args.offset);
    const q = `
      SELECT ${cols}
      FROM wine_pdp_snapshot
      WHERE ${whereSql}
      ORDER BY scraped_at DESC NULLS LAST
      LIMIT $${String(limIdx)}::int OFFSET $${String(offIdx)}::int
    `;
    const r = await pool.query<Record<string, unknown>>(q, params);
    const rows = r.rows;

    let body: string;
    if (args.format === 'ndjson') {
      body = rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
    } else {
      body = `${JSON.stringify(rows, null, 2)}\n`;
    }

    if (args.outputPath !== undefined) {
      await fs.writeFile(args.outputPath, body, 'utf8');
    } else {
      process.stdout.write(body);
    }
  } finally {
    await pool.end();
  }
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
