import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

interface HttpDebugModeOptions {
  /**
   * Shared secret (from `HTTP_DEBUG_SECRET`). When omitted or empty, header-based debug is disabled.
   */
  readonly secret?: string | undefined;
}

/**
 * Constant-time comparison that does not leak the length of `secret`.
 * Both inputs are HMAC-hashed to a fixed 32-byte digest before comparison,
 * so timing is independent of input lengths.
 */
/**
 * Exported so other admin endpoints (e.g. `/metrics/agent`) can reuse the
 * same constant-time check instead of re-implementing string `===`, which
 * leaks length and per-character information via timing side channels.
 */
export function headerKeysEqualConstantTime(headerValue: string, secret: string): boolean {
  const hmacKey = 'debug-key-compare';
  const a = createHmac('sha256', hmacKey).update(headerValue).digest();
  const b = createHmac('sha256', hmacKey).update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * When a non-empty secret is configured, requests that send header `X-Debug-Key` matching the
 * secret (constant-time compare) get:
 * - `request.debugRequest === true`
 * - `request.log` replaced with a child logger at level `debug` (bindings include `debug_request: true`)
 * - response header `X-Debug-Active: 1`
 * - Contract routes run with request pipeline debug context so `pipelineDebug()` from
 *   `observability/request-pipeline-debug` emits structured `pipeline_debug` lines through this logger.
 *
 * Register this hook **before** {@link registerRequestContext} so `request_start` / `request_end`
 * respect the per-request log level.
 */
export function registerHttpDebugMode(
  app: FastifyInstance,
  options: HttpDebugModeOptions,
): void {
  app.addHook('onRequest', (request, reply, done) => {
    request.debugRequest = false;

    const secret = options.secret?.trim();
    if (secret === undefined || secret.length === 0) {
      done();
      return;
    }

    const raw = request.headers['x-debug-key'];
    const headerValue = Array.isArray(raw) ? raw[0] : raw;
    if (
      headerValue === undefined
      || !headerKeysEqualConstantTime(headerValue, secret)
    ) {
      done();
      return;
    }

    request.debugRequest = true;
    reply.header('X-Debug-Active', '1');
    request.log = request.log.child(
      { debug_request: true },
      { level: 'debug' },
    );
    done();
  });
}
