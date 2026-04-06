import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export interface HttpDebugModeOptions {
  /**
   * Shared secret (from `HTTP_DEBUG_SECRET`). When omitted or empty, header-based debug is disabled.
   */
  readonly secret?: string | undefined;
}

function headerKeysEqualConstantTime(headerValue: string, secret: string): boolean {
  const a = Buffer.from(headerValue, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * When a non-empty secret is configured, requests that send header `X-Debug-Key` matching the
 * secret (constant-time compare) get:
 * - `request.debugRequest === true`
 * - `request.log` replaced with a child logger at level `debug` (bindings include `debug_request: true`)
 * - response header `X-Debug-Active: 1`
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
