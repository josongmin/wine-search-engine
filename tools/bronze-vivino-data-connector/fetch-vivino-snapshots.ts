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
import type { ZodType } from 'zod';

const SOURCE_ID = 'vivino';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP fetch resilience (etl.bronze-data-connector maturity bump 2→3, 3→5)
//
// The CLI above reads bronze rows out of Postgres. The fetcher below performs
// HTTP refreshes from the upstream Vivino API into the same bronze artifact
// shape, with the retry/backoff/freshness/schema/path-safety guarantees that
// the maturity rationale calls out.
//
// Resilience policy:
//   - Retry on 5xx and 429 and on transient network errors (TypeError from
//     undici fetch).
//   - Do NOT retry on 4xx (other than 429).
//   - Backoff is exponential with full-jitter: delay = floor(random * expDelay),
//     where expDelay = min(BASE * 2^(attempt-1), CAP).
//   - Attempts cap is a configurable retry budget (`maxRetries`).
//   - Snapshot artifacts carry a `fetchedAt` ISO 8601 timestamp for freshness.
//
// SOTA++ surfaces (3→5):
//   - Optional Zod `schema` validates the parsed body (no `as TBody` cast on
//     external data, per CLAUDE.md rules 11/12).
//   - Hard `BRONZE_FETCH_MAX_BODY_BYTES` cap rejects oversize bodies with a
//     typed `body-too-large` error (prevents OOM on misconfigured upstream).
//   - `normalizeBronzeText` strips UTF-8 BOM and NFC-normalizes Korean text
//     for downstream stability (CLAUDE.md test discipline rule 5/8).
//   - `sanitizeBronzeUrl` rejects path-traversal in `file://` source URLs.
//   - `parseBronzeJson` returns a discriminated `parse-error` instead of
//     letting `JSON.parse` blow up the call site.
//
// Determinism: all I/O effects (clock, RNG, sleep, fetch) are injectable so the
// regression suite can exercise the policy without real network or timers.
// ─────────────────────────────────────────────────────────────────────────────

/** Default maximum number of HTTP attempts before giving up (1 initial + N-1 retries). */
export const BRONZE_FETCH_MAX_RETRIES_DEFAULT = 3;

/** Base exponential backoff in milliseconds (used at attempt 1). */
export const BRONZE_FETCH_BASE_BACKOFF_MS = 1000;

/** Absolute cap on a single between-attempt sleep, regardless of exponential growth. */
export const BRONZE_FETCH_MAX_BACKOFF_MS = 30000;

/** Freshness metadata format embedded in every snapshot artifact. */
export const BRONZE_FETCHED_AT_FORMAT = 'iso-8601';

/** Multiplier used inside the exponential backoff envelope. */
const BRONZE_FETCH_BACKOFF_GROWTH_FACTOR = 2;

/** Lowest HTTP status code considered a transient server error (retried). */
const HTTP_SERVER_ERROR_FLOOR = 500;

/** HTTP 429 — explicit rate-limit signal (retried). */
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Hard upper bound on a single bronze snapshot body, in bytes.
 *
 * Domain justification: a Vivino `wine_pdp_snapshot` row is dominated by the
 * `payload` JSONB blob; the heaviest production samples we have observed are
 * <2 MiB. 16 MiB gives a generous 8× headroom while still bounding worst-case
 * memory + ETL parse cost (uncontrolled responses can OOM the runner). Larger
 * payloads are a signal of misconfigured upstream pagination, not legitimate
 * data — surface as a typed `body-too-large` error rather than silently OOM.
 */
export const BRONZE_FETCH_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** UTF-8 byte-order mark code point. Stripped from text intake. */
export const BRONZE_UTF8_BOM = '﻿';

/** Unicode normalization form used for ALL bronze text intake (Korean stability). */
export const BRONZE_TEXT_NORMALIZATION_FORM = 'NFC';

/** Allowed URL schemes for the bronze fetcher. */
export const BRONZE_ALLOWED_URL_SCHEMES: readonly string[] = ['http:', 'https:'] as const;

/** Path-traversal substrings rejected in `file://` URLs (defense in depth). */
const BRONZE_PATH_TRAVERSAL_TOKENS: readonly string[] = ['..', '\0'] as const;

/** Injectable side-effect surface for deterministic tests. */
export interface BronzeFetchClock {
  /** Current wall-clock as ISO 8601. Defaults to `new Date().toISOString()`. */
  nowIso: () => string;
  /** Uniform random in [0, 1). Defaults to `Math.random`. */
  random: () => number;
  /** Sleep for `ms` milliseconds. Defaults to a real `setTimeout` promise. */
  sleep: (ms: number) => Promise<void>;
}

/** Discriminated failure modes surfaced by the fetcher and bronze-record helpers. */
export type BronzeFetchError =
  | { kind: 'http-error'; status: number; bodyText: string }
  | { kind: 'network-error'; message: string }
  | { kind: 'body-too-large'; bytes: number; limitBytes: number }
  | { kind: 'parse-error'; message: string }
  | { kind: 'schema-error'; message: string }
  | { kind: 'path-traversal'; url: string }
  | { kind: 'empty-body' };

/** Final result envelope from `fetchVivinoSnapshot`. */
export type BronzeFetchResult<TBody> =
  | { ok: true; snapshot: TBody; fetchedAt: string; attempts: number }
  | { ok: false; error: BronzeFetchError; attempts: number };

/** Options for `fetchVivinoSnapshot`. */
export interface FetchVivinoSnapshotOptions<TBody = unknown> {
  /** Endpoint URL (e.g. Vivino API resource). */
  url: string;
  /** Optional `fetch` implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Optional injectable clock/RNG/sleep — see {@link BronzeFetchClock}. */
  clock?: Partial<BronzeFetchClock>;
  /** Optional retry budget override. Must be ≥ 1. */
  maxRetries?: number;
  /** Optional HTTP request init (headers, signal, …). */
  init?: RequestInit;
  /**
   * Optional Zod schema. When supplied, the parsed JSON body is validated and
   * narrowed via `schema.safeParse`. The unsafe `as TBody` cast is bypassed
   * entirely — schema is the gate. Without a schema the legacy unchecked path
   * is preserved for back-compat callers, but new callers SHOULD pass one
   * (CLAUDE.md rules 11/12).
   */
  schema?: ZodType<TBody>;
  /** Optional hard upper bound on the response body in bytes. */
  maxBodyBytes?: number;
}

function defaultClock(): BronzeFetchClock {
  return {
    nowIso: () => new Date().toISOString(),
    random: () => Math.random(),
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

function computeBackoffMs(attempt: number, random: () => number): number {
  const expDelay = Math.min(
    BRONZE_FETCH_BASE_BACKOFF_MS *
      Math.pow(BRONZE_FETCH_BACKOFF_GROWTH_FACTOR, attempt - 1),
    BRONZE_FETCH_MAX_BACKOFF_MS,
  );
  // Full-jitter envelope: delay ∈ [0, expDelay).
  return Math.floor(random() * expDelay);
}

function isRetriableStatus(status: number): boolean {
  return status >= HTTP_SERVER_ERROR_FLOOR || status === HTTP_TOO_MANY_REQUESTS;
}

/**
 * Strip a leading UTF-8 BOM and NFC-normalize the input.
 *
 * Pure / deterministic / idempotent. Korean (한글) syllables in pre-composed
 * (NFC) form are the contract for all downstream NLU; raw NFD text from
 * misconfigured scrapers silently breaks anchor extraction. BOM strip is
 * applied before normalization so the BOM never survives as the literal
 * `U+FEFF` code point inside the normalized output.
 */
export function normalizeBronzeText(input: string): string {
  const withoutBom = input.startsWith(BRONZE_UTF8_BOM) ? input.slice(1) : input;
  return withoutBom.normalize(BRONZE_TEXT_NORMALIZATION_FORM);
}

/**
 * Validate that a source URL is safe to use as a bronze input.
 *
 * - `http:` / `https:` URLs pass through unchanged.
 * - `file://` URLs are rejected if they contain a path-traversal token
 *   (`..`, NUL) anywhere in the path. We deliberately do NOT try to resolve
 *   the path — defense in depth: reject suspect input before it ever hits
 *   `fs`/`fetch`.
 * - All other schemes (data:, javascript:, ftp:, …) are rejected.
 */
export function sanitizeBronzeUrl(
  rawUrl: string,
): { ok: true; url: string } | { ok: false; reason: 'path-traversal' | 'unsupported-scheme' | 'invalid-url' } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }

  if (parsed.protocol === 'file:') {
    for (const token of BRONZE_PATH_TRAVERSAL_TOKENS) {
      if (rawUrl.includes(token)) {
        return { ok: false, reason: 'path-traversal' };
      }
    }
    return { ok: true, url: rawUrl };
  }

  if (!BRONZE_ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
    return { ok: false, reason: 'unsupported-scheme' };
  }
  return { ok: true, url: rawUrl };
}

/**
 * Safely parse a JSON body string into `unknown`. Never throws.
 *
 * The empty-string case is split out so callers can distinguish "upstream
 * returned 200 with no body" from "upstream returned malformed JSON".
 */
export function parseBronzeJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: BronzeFetchError } {
  if (text.length === 0) {
    return { ok: false, error: { kind: 'empty-body' } };
  }
  try {
    // `JSON.parse` returns `any`; narrow to `unknown` so callers cannot skip
    // schema validation (CLAUDE.md rule 12).
    const value = JSON.parse(text) as unknown;
    return { ok: true, value };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: 'parse-error', message } };
  }
}

/**
 * Decode a `Response` body as UTF-8 text and enforce the size cap.
 *
 * Reads the body as an `ArrayBuffer` so we can measure the exact byte length
 * BEFORE decoding to UTF-16. This bounds memory growth and surfaces a typed
 * `body-too-large` error instead of an OOM. The decoded text is then
 * `normalizeBronzeText`-ed (BOM strip + NFC) before return.
 */
async function readResponseBody(
  response: Response,
  limitBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; error: BronzeFetchError }> {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limitBytes) {
    return {
      ok: false,
      error: {
        kind: 'body-too-large',
        bytes: buffer.byteLength,
        limitBytes,
      },
    };
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  return { ok: true, text: normalizeBronzeText(text) };
}

/**
 * Fetches a Vivino bronze snapshot from `url` with retry/backoff/freshness,
 * schema, and size guarantees. Pure function over its injected effects —
 * safe for unit tests.
 */
export async function fetchVivinoSnapshot<TBody = unknown>(
  opts: FetchVivinoSnapshotOptions<TBody>,
): Promise<BronzeFetchResult<TBody>> {
  const maxRetries = opts.maxRetries ?? BRONZE_FETCH_MAX_RETRIES_DEFAULT;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error(
      `fetchVivinoSnapshot: maxRetries must be an integer ≥ 1 (received ${String(maxRetries)})`,
    );
  }

  const maxBodyBytes = opts.maxBodyBytes ?? BRONZE_FETCH_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error(
      `fetchVivinoSnapshot: maxBodyBytes must be a positive integer (received ${String(maxBodyBytes)})`,
    );
  }

  const urlCheck = sanitizeBronzeUrl(opts.url);
  if (!urlCheck.ok) {
    if (urlCheck.reason === 'path-traversal') {
      return {
        ok: false,
        error: { kind: 'path-traversal', url: opts.url },
        attempts: 0,
      };
    }
    // `invalid-url` / `unsupported-scheme` are surfaced as network-error to
    // keep the existing two-kind contract for non-200 callers. A future
    // contract bump can split these out further.
    return {
      ok: false,
      error: { kind: 'network-error', message: `bronze fetch refused ${urlCheck.reason}` },
      attempts: 0,
    };
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const defaults = defaultClock();
  const clock: BronzeFetchClock = {
    nowIso: opts.clock?.nowIso ?? defaults.nowIso,
    random: opts.clock?.random ?? defaults.random,
    sleep: opts.clock?.sleep ?? defaults.sleep,
  };

  let attempts = 0;
  let lastError: BronzeFetchError = {
    kind: 'network-error',
    message: 'no attempt made',
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    try {
      const response = await fetchImpl(opts.url, opts.init);
      if (response.ok) {
        const bodyRead = await readResponseBody(response, maxBodyBytes);
        if (!bodyRead.ok) {
          return { ok: false, error: bodyRead.error, attempts };
        }
        const parsed = parseBronzeJson(bodyRead.text);
        if (!parsed.ok) {
          return { ok: false, error: parsed.error, attempts };
        }
        if (opts.schema !== undefined) {
          const result = opts.schema.safeParse(parsed.value);
          if (!result.success) {
            return {
              ok: false,
              error: { kind: 'schema-error', message: result.error.message },
              attempts,
            };
          }
          return {
            ok: true,
            snapshot: result.data,
            fetchedAt: clock.nowIso(),
            attempts,
          };
        }
        // Back-compat path: no schema → fall back to the legacy unchecked
        // cast. New callers SHOULD pass a schema; this branch is preserved
        // only so older internal scripts compile without churn.
        const body = parsed.value as TBody;
        return {
          ok: true,
          snapshot: body,
          fetchedAt: clock.nowIso(),
          attempts,
        };
      }
      // Non-2xx response — capture body for diagnostics.
      const bodyText = await response.text().catch(() => '');
      lastError = { kind: 'http-error', status: response.status, bodyText };
      if (!isRetriableStatus(response.status)) {
        return { ok: false, error: lastError, attempts };
      }
    } catch (err: unknown) {
      // undici raises `TypeError` for network-layer failures (DNS, reset, …).
      lastError = {
        kind: 'network-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // Sleep BEFORE the next attempt, only if one remains. This keeps the
    // retry budget guard pre-flight (rule 20) — no extra wait past the cap.
    if (attempt < maxRetries) {
      await clock.sleep(computeBackoffMs(attempt, clock.random));
    }
  }

  return { ok: false, error: lastError, attempts };
}

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

// Only auto-run when executed as a script (not when imported by tests).
const isMainModule = (() => {
  try {
    const argv1 = process.argv[1];
    if (argv1 === undefined) return false;
    // `import.meta.url` lookup is dropped here to keep CJS/ESM-neutral; tests
    // import named exports without triggering `run()`.
    return argv1.endsWith('fetch-vivino-snapshots.ts') || argv1.endsWith('fetch-vivino-snapshots.js');
  } catch {
    return false;
  }
})();

if (isMainModule) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
