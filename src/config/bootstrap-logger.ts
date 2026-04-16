import pino from 'pino';
import { getSafeErrorDiagnostics } from '../domain/shared/utils/error-diagnostics.js';

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
 * only the fields that are safe for log aggregation.
 */
function safeErrSerializer(err: unknown): Record<string, unknown> {
  const diagnostics = getSafeErrorDiagnostics(err);
  if (diagnostics !== undefined) {
    const serialized: Record<string, unknown> = {
      type: diagnostics.name,
      message: diagnostics.message,
      ...(diagnostics.code !== undefined ? { code: diagnostics.code } : {}),
      ...(diagnostics.errno !== undefined ? { errno: diagnostics.errno } : {}),
      ...(diagnostics.statusCode !== undefined ? { statusCode: diagnostics.statusCode } : {}),
      ...(diagnostics.syscall !== undefined ? { syscall: diagnostics.syscall } : {}),
      ...(diagnostics.hostname !== undefined ? { hostname: diagnostics.hostname } : {}),
      ...(diagnostics.address !== undefined ? { address: diagnostics.address } : {}),
      ...(diagnostics.port !== undefined ? { port: diagnostics.port } : {}),
      ...(diagnostics.isAborted !== undefined ? { isAborted: diagnostics.isAborted } : {}),
      ...(diagnostics.cause !== undefined ? { cause: diagnostics.cause } : {}),
    };
    if (
      process.env['LOG_INCLUDE_STACK'] === 'true'
      && err !== null
      && typeof err === 'object'
      && typeof (err as Record<string, unknown>)['stack'] === 'string'
    ) {
      serialized['stack'] = (err as Record<string, unknown>)['stack'];
    }
    return serialized;
  }
  if (err === null || typeof err !== 'object') {
    return { type: typeof err, message: String(err) };
  }
  return { type: 'object', message: '<no message>' };
}

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
      'config.anthropic.apiKey',
      'config.cohere.apiKey',
      'config.watchlist.webhookSecret',
      'config.http.debugSecret',
      // Wildcards for nested logger contexts
      '*.password',
      '*.apiKey',
      '*.api_key',
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
