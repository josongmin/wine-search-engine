/**
 * Property-based PII scrubbing regression tests for the bootstrap pino logger.
 *
 * Goals (SOTA++):
 *  - GDPR Article 4 PII categories (email, IPv4, phone-like, payment card)
 *    NEVER appear verbatim in serialized error output, even if embedded
 *    inside `error.message`, nested SQL/connection strings, or auth headers.
 *  - Pino best practices: `redact` paths for known structured fields;
 *    serializer scrub for free-form message content.
 *  - Property tests use `fast-check` (numRuns: 100) over arbitrary SQL-like
 *    strings, connection URIs, and bearer tokens.
 *  - Korean error messages preserved verbatim (no over-redaction).
 *  - Idempotence: serialize(serialize(err)) === serialize(err).
 *  - Stack traces preserved when `LOG_INCLUDE_STACK=true` (debuggability).
 *  - Pino integration verified at the actual logger, not just regex utils,
 *    via in-memory Writable destination (no flaky stdout capture).
 *
 * Append-only regression — see CLAUDE.md "Test discipline" rules 5, 15, 23.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { Writable } from 'node:stream';
import pino from 'pino';

// Import the module under test fresh after env mutation
async function loadBootstrapLoggerModule(): Promise<typeof import('../../src/domain/shared/bootstrap-logger.js')> {
  return await import('../../src/domain/shared/bootstrap-logger.js');
}

/**
 * In-memory pino destination — captures every logged line as a JSON object.
 * Avoids flaky stdout capture and gives synchronous assertions.
 */
class MemorySink extends Writable {
  public readonly lines: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.lines.push(chunk.toString('utf8'));
    cb();
  }
  parsedLines(): Array<Record<string, unknown>> {
    return this.lines
      .join('')
      .split('\n')
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  serialized(): string {
    return this.lines.join('');
  }
  clear(): void {
    this.lines.length = 0;
  }
}

/**
 * Build a pino logger that mirrors `bootstrapLogger`'s serializer + redact
 * config but writes to an in-memory sink. This lets us assert on the actual
 * serialized output without monkeypatching stdout.
 *
 * We reuse the *exported* serializer & redact by reading them off
 * `bootstrapLogger`'s internal config via a fresh pino instance with the
 * same options when needed.
 */
async function buildTestLogger(): Promise<{ logger: pino.Logger; sink: MemorySink }> {
  const mod = await loadBootstrapLoggerModule();
  const sink = new MemorySink();
  // Construct a sibling logger using the same options surface so behavior
  // matches production 1:1. The module exports `bootstrapLogger`; we re-use
  // its `[pino.symbols.serializersSym]` is implementation-private, so instead
  // we directly assert against `bootstrapLogger` by swapping its stream via
  // `pino.symbols`. Cleaner approach: child logger writes to same destination
  // when piped via `pino()` constructor on the same config.
  // Use the production logger but route through our sink via child + stream.
  const root = mod.bootstrapLogger;
  // pino exposes `[pino.symbols.streamSym]` but we use a fresh constructor
  // with identical config to avoid private-symbol access.
  // Read configured serializers/redact from the existing instance is brittle;
  // construct a parallel logger with identical options (kept in sync via
  // the same source module).
  const logger = pino(
    {
      name: 'wine-engine',
      level: 'info',
      serializers: {
        err: root[pino.symbols.serializersSym]['err'],
        error: root[pino.symbols.serializersSym]['error'],
      },
      redact: {
        paths: [
          'config.pg.password',
          'config.openai.apiKey',
          'config.openai.apiKeys',
          'config.anthropic.apiKey',
          'config.cohere.apiKey',
          'config.watchlist.webhookSecret',
          'config.http.debugSecret',
          '*.password',
          '*.apiKey',
          '*.apiKeys',
          '*.api_key',
          '*.api_keys',
          '*.webhookSecret',
          '*.webhook_secret',
          '*.debugSecret',
          '*.debug_secret',
          '*.authorization',
          '*.Authorization',
          'config.redis.url',
          '*.redis.url',
          'err.password',
          'err.options.password',
          'err.config.password',
        ],
        censor: '[REDACTED]',
      },
    },
    sink,
  );
  return { logger, sink };
}

const REDACTED = '[REDACTED]';

// Arbitraries — domain-shaped inputs

const sqlIdent = fc.stringMatching(/^[a-z][a-z_]{0,10}$/);
const sqlValue = fc.oneof(
  fc.integer({ min: 1, max: 999999 }).map(String),
  fc.constantFrom("'admin'", "'42'", "'wine_lover'", "'P@ssw0rd'"),
);

const sqlLike = fc
  .tuple(sqlIdent, sqlValue)
  .map(([col, v]) => `SELECT * FROM wines WHERE ${col} = ${v}`);

const bearerToken = fc.stringMatching(/^[A-Za-z0-9_-]{20,40}$/);

const pgPassword = fc.stringMatching(/^[A-Za-z0-9]{8,20}$/);
const pgConnString = fc
  .tuple(fc.stringMatching(/^[a-z]{3,8}$/), pgPassword, fc.stringMatching(/^[a-z]{3,8}\.host$/))
  .map(([u, p, h]) => `postgres://${u}:${p}@${h}:5432/winedb`);

const koreanMessage = fc.constantFrom(
  '와인 검색 실패: 데이터베이스 연결 끊김',
  '인덱스 누락 — 재시도 필요',
  '한글 오류 메시지 — special chars: 가나다라',
  '쿼리 타임아웃 (5초 초과)',
);

describe('pino-logger PII scrubbing (property tests)', () => {
  let logger: pino.Logger;
  let sink: MemorySink;

  beforeEach(async () => {
    delete process.env['LOG_INCLUDE_STACK'];
    const built = await buildTestLogger();
    logger = built.logger;
    sink = built.sink;
  });

  afterEach(() => {
    sink.clear();
  });

  // --- Property: SQL params stripped from arbitrary SQL-like strings ---
  it('strips raw SQL parameter values from err.message under arbitrary SQL-like input', () => {
    fc.assert(
      fc.property(sqlLike, (sql) => {
        sink.clear();
        const err = Object.assign(new Error(`db failure: ${sql}`), {
          query: sql,
          parameters: ['admin', 'P@ssw0rd'],
          sql,
        });
        logger.error({ err }, 'db error');
        const out = sink.serialized();
        // SQL identifier may legitimately appear (column names are not PII),
        // but raw parameter literals (quoted strings, numeric literals after `=`)
        // must be redacted from message AND removed/redacted from the err object's
        // `query`/`parameters`/`sql` siblings (they are not in the safe diagnostics allowlist).
        expect(out).not.toMatch(/'admin'/);
        expect(out).not.toMatch(/'P@ssw0rd'/);
        // The raw `query`, `parameters`, `sql` fields must not appear as serialized keys
        // (safeErrSerializer only emits allowlisted keys).
        expect(out).not.toContain('"query":');
        expect(out).not.toContain('"parameters":');
        expect(out).not.toContain('"sql":');
      }),
      { numRuns: 100 },
    );
  });

  // --- Property: Authorization Bearer token redacted in any nested message ---
  it('redacts Authorization Bearer tokens embedded in error messages', () => {
    fc.assert(
      fc.property(bearerToken, (tok) => {
        sink.clear();
        const err = new Error(`upstream rejected: Authorization: Bearer ${tok}`);
        logger.error({ err }, 'auth fail');
        const out = sink.serialized();
        expect(out).not.toContain(tok);
        expect(out).toContain(REDACTED);
      }),
      { numRuns: 100 },
    );
  });

  // --- Property: Postgres connection string credentials redacted ---
  it('redacts postgres://user:password@host credentials in error messages', () => {
    fc.assert(
      fc.property(pgConnString, pgPassword, (conn, password) => {
        // Use the password from conn (deterministic): extract.
        const realPassword = conn.split(':')[2]?.split('@')[0] ?? password;
        sink.clear();
        const err = new Error(`connection refused: ${conn}`);
        logger.error({ err }, 'pg error');
        const out = sink.serialized();
        expect(out).not.toContain(realPassword);
        expect(out).toContain(REDACTED);
      }),
      { numRuns: 100 },
    );
  });

  // --- Property: User query field redacted (search query is PII per GDPR) ---
  it('does not serialize user-supplied search query field from pg error envelope', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 3, maxLength: 40 }), (userQuery) => {
        sink.clear();
        const err = Object.assign(new Error('query parse failed'), {
          userQuery,
          query: userQuery,
        });
        logger.error({ err }, 'query error');
        const out = sink.serialized();
        expect(out).not.toContain('"userQuery":');
        expect(out).not.toContain('"query":');
      }),
      { numRuns: 100 },
    );
  });

  // --- Property: idempotence of serializer ---
  it('serializer is idempotent: serialize(serialize(err)) === serialize(err)', async () => {
    const mod = await loadBootstrapLoggerModule();
    const ser = mod.__safeErrSerializerForTest;
    expect(ser).toBeTypeOf('function');
    fc.assert(
      fc.property(
        fc.record({
          message: fc.string({ maxLength: 80 }),
          code: fc.constantFrom('ECONNREFUSED', 'ETIMEDOUT', '23505'),
          stack: fc.string({ maxLength: 200 }),
        }),
        (errLike) => {
          const once = ser(errLike);
          const twice = ser(once);
          expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
        },
      ),
      { numRuns: 100 },
    );
  });

  // --- Property: stack trace preserved when LOG_INCLUDE_STACK=true ---
  it('preserves stack trace when LOG_INCLUDE_STACK=true', async () => {
    process.env['LOG_INCLUDE_STACK'] = 'true';
    // Re-import with fresh env-read (serializer reads env at call-time, not init-time).
    const mod = await loadBootstrapLoggerModule();
    const ser = mod.__safeErrSerializerForTest;
    const err = new Error('boom');
    const out = ser(err);
    expect(out['stack']).toBeTypeOf('string');
    expect(String(out['stack'])).toContain('boom');
    delete process.env['LOG_INCLUDE_STACK'];
  });

  // --- Property: Korean message preserved verbatim ---
  it('preserves Korean error messages verbatim (no over-redaction)', () => {
    fc.assert(
      fc.property(koreanMessage, (msg) => {
        sink.clear();
        const err = new Error(msg);
        logger.error({ err }, 'korean err');
        const out = sink.serialized();
        expect(out).toContain(msg);
      }),
      { numRuns: 100 },
    );
  });
});

describe('pino-logger PII scrubbing (specific regression cases)', () => {
  let logger: pino.Logger;
  let sink: MemorySink;

  beforeEach(async () => {
    const built = await buildTestLogger();
    logger = built.logger;
    sink = built.sink;
  });

  it('redacts email addresses (RFC 5322 simplified) in error messages', () => {
    const err = new Error('user lookup failed for user@example.com — not found');
    logger.error({ err }, 'lookup');
    const out = sink.serialized();
    expect(out).not.toContain('user@example.com');
    expect(out).toContain(REDACTED);
  });

  it('redacts IPv4 addresses in error messages', () => {
    const err = new Error('connection refused from 192.168.1.42');
    logger.error({ err }, 'net');
    const out = sink.serialized();
    expect(out).not.toContain('192.168.1.42');
    expect(out).toContain(REDACTED);
  });

  it('redacts credit-card-shaped digit groups in error messages', () => {
    const err = new Error('payment validation failure: 4111-1111-1111-1111');
    logger.error({ err }, 'pay');
    const out = sink.serialized();
    expect(out).not.toContain('4111-1111-1111-1111');
    expect(out).toContain(REDACTED);
  });

  // Adjacent regression cases (CLAUDE.md test discipline #4)

  it('preserves benign error messages verbatim (no false positives)', () => {
    const err = new Error('snapshot version mismatch: expected v17, got v15');
    logger.error({ err }, 'snap');
    const out = sink.serialized();
    expect(out).toContain('snapshot version mismatch: expected v17, got v15');
    expect(out).not.toContain(REDACTED);
  });

  it('handles empty error object gracefully', () => {
    expect(() => logger.error({ err: {} }, 'empty')).not.toThrow();
    const out = sink.serialized();
    expect(out.length).toBeGreaterThan(0);
  });

  it('handles circular references in error.cause without infinite loop', () => {
    const a: Record<string, unknown> = { name: 'A', message: 'a' };
    const b: Record<string, unknown> = { name: 'B', message: 'b', cause: a };
    a['cause'] = b;
    expect(() => logger.error({ err: a }, 'cycle')).not.toThrow();
    const out = sink.serialized();
    expect(out.length).toBeGreaterThan(0);
  });

  it('does not match credit-card-shaped regex on legitimate version numbers', () => {
    // 4-digit groups that are NOT credit-card-shaped (e.g. snapshot timestamps).
    const err = new Error('build version 2026-05-21-1234');
    logger.error({ err }, 'ver');
    const out = sink.serialized();
    expect(out).toContain('2026-05-21-1234');
  });
});

// CLAUDE.md rule 15 (named regex constants) — assert SQL literal scrubbing
// regexes are exported as module-level named consts (not inlined inside
// `scrubPiiFromString`). This guards against regression from the audit finding
// that previously claimed "7 PII regex consts" while one was inline.
describe('pino-logger PII regex constants are named exports (CLAUDE.md rule 15)', () => {
  it('exports PII_SQL_QUOTED_LITERAL_RE as a named const with VALUES/comparison anchoring', async () => {
    const mod = await import('../../src/domain/shared/bootstrap-logger.js');
    expect(mod.PII_SQL_QUOTED_LITERAL_RE).toBeInstanceOf(RegExp);
    // Regex must scrub a quoted literal RHS in a WHERE comparison.
    const before = "SELECT * FROM wines WHERE name = 'admin' AND tier = 'gold'";
    const after = before.replace(mod.PII_SQL_QUOTED_LITERAL_RE, '[REDACTED]');
    expect(after).not.toContain("'admin'");
    expect(after).not.toContain("'gold'");
    // Anchoring tokens present in the regex source (audit guard).
    expect(mod.PII_SQL_QUOTED_LITERAL_RE.source).toContain('VALUES');
    // /giu flags: global + case-insensitive + unicode (CLAUDE.md rule 8).
    expect(mod.PII_SQL_QUOTED_LITERAL_RE.flags).toContain('g');
    expect(mod.PII_SQL_QUOTED_LITERAL_RE.flags).toContain('u');
  });

  it('exports PII_SQL_NUMERIC_LITERAL_RE as a named const that scrubs WHERE id=N patterns', async () => {
    const mod = await import('../../src/domain/shared/bootstrap-logger.js');
    expect(mod.PII_SQL_NUMERIC_LITERAL_RE).toBeInstanceOf(RegExp);
    const before = 'WHERE id = 42';
    const after = before.replace(mod.PII_SQL_NUMERIC_LITERAL_RE, '[REDACTED]');
    expect(after).not.toMatch(/\b42\b/);
    expect(after).toContain('[REDACTED]');
    // Must NOT redact arbitrary numbers in free-form prose (false-positive guard).
    const benign = 'retried 5 times in 250ms';
    expect(benign.replace(mod.PII_SQL_NUMERIC_LITERAL_RE, '[REDACTED]')).toBe(benign);
    expect(mod.PII_SQL_NUMERIC_LITERAL_RE.flags).toContain('u');
  });
});
