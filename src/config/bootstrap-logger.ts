import pino from 'pino';

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
  if (err === null || typeof err !== 'object') {
    return { type: typeof err, message: String(err) };
  }
  const e = err as Record<string, unknown>;
  const out: Record<string, unknown> = {
    type: (e['name'] as string | undefined) ?? 'Error',
    message: typeof e['message'] === 'string' ? e['message'] : '<no message>',
  };
  if (typeof e['code'] === 'string' || typeof e['code'] === 'number') {
    out['code'] = e['code'];
  }
  if (typeof e['statusCode'] === 'number') {
    out['statusCode'] = e['statusCode'];
  }
  // Stack: keep but only when explicitly desired (not in production logs).
  if (process.env['LOG_INCLUDE_STACK'] === 'true' && typeof e['stack'] === 'string') {
    out['stack'] = e['stack'];
  }
  return out;
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
