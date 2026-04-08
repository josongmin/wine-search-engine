import type { FastifyRequest } from 'fastify';

const abortSignalByRequest = new WeakMap<FastifyRequest, AbortSignal>();

function rawAlreadyAborted(raw: FastifyRequest['raw']): boolean {
  const aborted = (raw as { aborted?: boolean }).aborted;
  return aborted === true;
}

/**
 * Returns a stable {@link AbortSignal} for this HTTP request: aborts when the
 * underlying socket closes or the request is aborted (client disconnect).
 * Cached per {@link FastifyRequest} instance so repeated reads in one handler
 * share the same signal.
 */
export function abortSignalFromFastifyRequest(request: FastifyRequest): AbortSignal {
  const cached = abortSignalByRequest.get(request);
  if (cached !== undefined) {
    return cached;
  }

  const controller = new AbortController();
  const raw = request.raw;

  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (rawAlreadyAborted(raw)) {
    abort();
  } else {
    raw.once('aborted', abort);
    raw.once('close', abort);
  }

  abortSignalByRequest.set(request, controller.signal);
  return controller.signal;
}
