import type { FastifyInstance } from 'fastify';
import { headerKeysEqualConstantTime } from './http-debug-mode.js';

/**
 * Operator curation write/publish plane authentication (T-ELV2-07).
 *
 * This is the MUTATION counterpart to {@link registerHttpDebugMode}. Read/inspect
 * routes gate on `request.debugRequest` (X-Debug-Key); the curation write plane
 * (submit / review / publish proposals) gates on `request.opsWriteAuthorized`,
 * set here when a request carries `X-Ops-Write-Key` matching `HTTP_OPS_WRITE_SECRET`.
 *
 * The two credentials are deliberately separate (env startup rejects reuse): a
 * leaked read key must not be able to drive staged runtime changes (RFC §5 —
 * runtime-plane direct write 금지; staging→publish 통제).
 */
interface HttpOpsWriteModeOptions {
  /** Shared secret (from `HTTP_OPS_WRITE_SECRET`). When omitted/empty, the write plane is locked (no request authorizes). */
  readonly secret?: string | undefined;
}

export function registerHttpOpsWriteMode(
  app: FastifyInstance,
  options: HttpOpsWriteModeOptions,
): void {
  app.addHook('onRequest', (request, _reply, done) => {
    request.opsWriteAuthorized = false;

    const secret = options.secret?.trim();
    if (secret === undefined || secret.length === 0) {
      // No secret configured → the write plane is closed; every mutation 403s.
      done();
      return;
    }

    const raw = request.headers['x-ops-write-key'];
    const headerValue = Array.isArray(raw) ? raw[0] : raw;
    if (
      headerValue === undefined
      || !headerKeysEqualConstantTime(headerValue, secret)
    ) {
      done();
      return;
    }

    request.opsWriteAuthorized = true;
    done();
  });
}
