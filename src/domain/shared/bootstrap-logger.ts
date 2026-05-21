import pino from 'pino';
import { getSafeErrorDiagnostics } from './utils/error-diagnostics.js';

/**
 * PII / secret scrubbing regexes applied to free-form `err.message` and
 * `err.stack` content. Pino's `redact` paths only cover *known field names*;
 * these regexes defend against PII embedded *inside* string values.
 *
 * Categories aligned with GDPR Article 4(1) personal-data examples:
 *  - Email addresses (RFC 5322 simplified, ASCII-safe atext)
 *  - IPv4 addresses (dotted decimal, octet bounds 0..255)
 *  - Authorization Bearer/Basic tokens (HTTP header form)
 *  - Postgres / Redis / Mongo connection-string credentials
 *  - Credit-card-shaped digit groups (Luhn-shape; 13-19 digits)
 *
 * All regexes are anchored to their canonical surrounding context (e.g.
 * `Authorization: Bearer <tok>` rather than bare base64) to keep
 * false-positives low. Per CLAUDE.md rule 23: each regex is paired with at
 * least one false-positive regression case in
 * `test/regression/pino-logger-pii-properties.regression.test.ts`.
 */
const PII_EMAIL_RE: RegExp =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Unicode-aware boundaries (CLAUDE.md rule 8): `\b` is ASCII-only and silently
// fails on Korean/accented Latin. We use `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])`
// with the `/u` flag everywhere.
const PII_IPV4_RE: RegExp =
  /(?<![\p{L}\p{N}])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\p{L}\p{N}])/gu;

const PII_AUTH_HEADER_RE: RegExp =
  /(Authorization[: ]+(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/giu;

// Connection-string credentials: `scheme://user:password@host`. We replace the
// password run with `[REDACTED]`, preserving scheme/user/host for debuggability.
const PII_CONN_STRING_RE: RegExp =
  /(?<![\p{L}\p{N}])(postgres|postgresql|redis|rediss|mongodb|mongodb\+srv|mysql|amqp|amqps|https?):\/\/([^:@\s/]+):([^@\s/]+)@/giu;

// Credit-card-shaped: 4 groups of 4 digits with optional `-` or ` ` separators,
// OR a contiguous 13-19 digit run. Excludes date-like patterns (YYYY-MM-DD-...)
// by requiring the first group to NOT be a year-like 19xx/20xx followed by
// month/day groups.
const PII_CARD_GROUPED_RE: RegExp =
  /(?<![\p{L}\p{N}])(?!(?:19|20)\d{2}[-\s]\d{2}[-\s])\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}(?![\p{L}\p{N}])/gu;
const PII_CARD_CONTIGUOUS_RE: RegExp = /(?<![\p{L}\p{N}])\d{13,19}(?![\p{L}\p{N}])/gu;

// SQL: quoted string literal in WHERE/VALUES — `'value'` after a comparison
// operator (`=`, `<`, `>`, `!=`, `<=`, `>=`), inside `VALUES (...)`, or after
// `,` in a value list. Scrubs only the literal RHS — preserves column names
// and SQL keywords for log debuggability. We do NOT scrub bare quoted strings
// elsewhere (those may be legitimate quoted identifiers in non-SQL text).
// Exported for regression-test assertions (CLAUDE.md rule 15 audit).
export const PII_SQL_QUOTED_LITERAL_RE: RegExp =
  /(?<=[=<>!]=?\s?|VALUES\s*\(\s*|,\s*)'(?:[^'\\]|\\.)*'/giu;
// SQL: bare numeric literal RHS in a SQL comparison/assignment — `WHERE id=42`.
// Only scrubs when preceded by a SQL-ish keyword (`WHERE|AND|OR|HAVING|ON|SET`
// or `VALUES (`) + identifier + comparison op, so we don't redact arbitrary
// numbers in free-form prose. Exported for regression-test assertions.
export const PII_SQL_NUMERIC_LITERAL_RE: RegExp =
  /(?<=(?:^|[^\p{L}\p{N}])(?:WHERE|AND|OR|HAVING|ON|SET|VALUES\s*\()\s*[a-z_][a-z0-9_]*\s*[=<>!]=?\s*)\d+(?![\p{L}\p{N}])/giu;

const REDACTED_TOKEN = '[REDACTED]';

/**
 * Scrub PII patterns from a free-form string. Applied to error messages and
 * (when included) stack traces. Idempotent: running twice produces the same
 * output because `[REDACTED]` does not match any PII pattern.
 */
export function scrubPiiFromString(input: string): string {
  if (input.length === 0) {
    return input;
  }
  let out = input;
  // Order matters: scrub connection strings BEFORE generic email/IPv4 so the
  // password substring is replaced as a single span, not byte-by-byte.
  out = out.replace(PII_CONN_STRING_RE, (_m, scheme: string, user: string) =>
    `${scheme}://${user}:${REDACTED_TOKEN}@`,
  );
  out = out.replace(PII_AUTH_HEADER_RE, (_m, prefix: string) => `${prefix}${REDACTED_TOKEN}`);
  out = out.replace(PII_EMAIL_RE, REDACTED_TOKEN);
  out = out.replace(PII_CARD_GROUPED_RE, REDACTED_TOKEN);
  // Scrub SQL literals BEFORE the generic contiguous-digit run so quoted/
  // numeric RHS values get the canonical `[REDACTED]` token.
  out = out.replace(PII_SQL_QUOTED_LITERAL_RE, REDACTED_TOKEN);
  out = out.replace(PII_SQL_NUMERIC_LITERAL_RE, REDACTED_TOKEN);
  out = out.replace(PII_CARD_CONTIGUOUS_RE, REDACTED_TOKEN);
  out = out.replace(PII_IPV4_RE, REDACTED_TOKEN);
  return out;
}

/**
 * Custom error serializer that strips fields known to leak PII or secrets.
 *
 * `pg`/Postgres driver errors carry `detail`, `hint`, `where`, `internalQuery`
 * fields that often include parameterized SQL with values interpolated.
 * `axios`/`fetch` errors carry `config`/`request`/`response` with full URLs,
 * headers (Authorization!), and request bodies. Redis errors carry `command`
 * arrays that may include the user query.
 *
 * Default pino `err` serializer dumps all of these. We replace it to keep
 * only the fields that are safe for log aggregation, AND we scrub PII from
 * the surviving `message` / `stack` strings via `scrubPiiFromString`.
 */
function safeErrSerializer(err: unknown): Record<string, unknown> {
  const diagnostics = getSafeErrorDiagnostics(err);
  if (diagnostics !== undefined) {
    const scrubbedCause =
      diagnostics.cause !== undefined
        ? { ...diagnostics.cause, message: scrubPiiFromString(diagnostics.cause.message) }
        : undefined;
    const serialized: Record<string, unknown> = {
      type: diagnostics.name,
      message: scrubPiiFromString(diagnostics.message),
      ...(diagnostics.code !== undefined ? { code: diagnostics.code } : {}),
      ...(diagnostics.errno !== undefined ? { errno: diagnostics.errno } : {}),
      ...(diagnostics.statusCode !== undefined ? { statusCode: diagnostics.statusCode } : {}),
      ...(diagnostics.syscall !== undefined ? { syscall: diagnostics.syscall } : {}),
      ...(diagnostics.hostname !== undefined ? { hostname: diagnostics.hostname } : {}),
      ...(diagnostics.address !== undefined ? { address: diagnostics.address } : {}),
      ...(diagnostics.port !== undefined ? { port: diagnostics.port } : {}),
      ...(diagnostics.isAborted !== undefined ? { isAborted: diagnostics.isAborted } : {}),
      ...(scrubbedCause !== undefined ? { cause: scrubbedCause } : {}),
    };
    if (
      process.env['LOG_INCLUDE_STACK'] === 'true'
      && err !== null
      && typeof err === 'object'
      && typeof (err as Record<string, unknown>)['stack'] === 'string'
    ) {
      serialized['stack'] = scrubPiiFromString((err as Record<string, unknown>)['stack'] as string);
    }
    return serialized;
  }
  if (err === null || typeof err !== 'object') {
    return { type: typeof err, message: scrubPiiFromString(String(err)) };
  }
  return { type: 'object', message: '<no message>' };
}

/**
 * Test-only export of the serializer. Not part of the public API; consumers
 * MUST use the configured `bootstrapLogger`. Exported solely so regression
 * tests can assert idempotence and stack-trace preservation directly.
 */
export const __safeErrSerializerForTest = safeErrSerializer;

/**
 * Logger for wiring paths that run before Fastify exists (container bootstrap, main).
 *
 * Redaction defends against accidental secret/PII logging in any future
 * `logger.info({ config })` or error-object dump (pg / redis errors carry
 * connection options including credentials).
 */
export const bootstrapLogger = pino({
  name: 'wine-engine',
  level: process.env['LOG_LEVEL'] ?? 'info',
  serializers: {
    err: safeErrSerializer,
    error: safeErrSerializer,
  },
  redact: {
    paths: [
      // Top-level config objects
      'config.pg.password',
      'config.openai.apiKey',
      'config.openai.apiKeys',
      'config.anthropic.apiKey',
      'config.cohere.apiKey',
      'config.watchlist.webhookSecret',
      'config.http.debugSecret',
      // Wildcards for nested logger contexts
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
      // Redis URL may contain credentials (redis://:password@host:port)
      'config.redis.url',
      '*.redis.url',
      // pg/redis error objects sometimes carry connection params
      'err.password',
      'err.options.password',
      'err.config.password',
    ],
    censor: '[REDACTED]',
  },
});
