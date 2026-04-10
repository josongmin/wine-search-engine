import type { FastifyRequest } from 'fastify';

const abortSignalByRequest = new WeakMap<FastifyRequest, AbortSignal>();

function rawAlreadyAborted(raw: FastifyRequest['raw']): boolean {
  const r = raw as { aborted?: boolean; destroyed?: boolean };
  return r.aborted === true || r.destroyed === true;
}

/**
 * Returns a stable {@link AbortSignal} for this HTTP request: aborts when the
 * underlying socket closes or the request is aborted (client disconnect).
 * Cached per {@link FastifyRequest} instance so repeated reads in one handler
 * share the same signal.
 *
 * Listens on `raw.socket` 'close' (instead of `raw` 'close') to avoid firing
 * immediately after body parsing in Fastify inject tests, where the request
 * stream is destroyed but the socket remains open.
 */
export function abortSignalFromFastifyRequest(request: FastifyRequest): AbortSignal {
  const cached = abortSignalByRequest.get(request);
  if (cached !== undefined) {
    return cached;
  }

  const controller = new AbortController();
  const raw = request.raw;

  const onAborted = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    // Clean up cross-listeners to avoid double-firing
    const socket = (raw as { socket?: { removeListener?: (event: string, listener: () => void) => void } }).socket;
    if (socket != null && typeof socket.removeListener === 'function') {
      socket.removeListener('close', onSocketClose);
    }
  };

  const onSocketClose = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    // Clean up cross-listeners to avoid double-firing
    raw.removeListener('aborted', onAborted);
  };

  if (rawAlreadyAborted(raw)) {
    controller.abort();
  } else {
    raw.once('aborted', onAborted);
    const socket = (raw as { socket?: { once?: (event: string, listener: () => void) => void } }).socket;
    if (socket != null && typeof socket.once === 'function') {
      socket.once('close', onSocketClose);
    }
  }

  abortSignalByRequest.set(request, controller.signal);
  return controller.signal;
}
