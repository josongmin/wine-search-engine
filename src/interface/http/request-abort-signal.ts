import type { FastifyReply, FastifyRequest } from 'fastify';
import { abortError } from '../../domain/shared/cooperative-abort.js';
import { HTTP_DEFAULT_REQUEST_TIMEOUT_MS } from './constants.js';

const abortSignalByRequest = new WeakMap<FastifyRequest, AbortSignal>();
const REQUEST_TIMEOUT_ABORT_CUSHION_MS = 1_000;
const REQUEST_LIFECYCLE_TIMEOUT_MS = HTTP_DEFAULT_REQUEST_TIMEOUT_MS;

function rawAlreadyAborted(raw: FastifyRequest['raw']): boolean {
  const r = raw as { aborted?: boolean; destroyed?: boolean; complete?: boolean };
  if (r.aborted === true) {
    return true;
  }
  // `IncomingMessage.destroyed` flips to true in some post-body-consumption
  // states even when the client is still awaiting the response. Only treat a
  // destroyed request stream as already-aborted when the request itself was
  // not fully received.
  return r.destroyed === true && r.complete !== true;
}

function shouldAbortOnSocketClose(raw: FastifyRequest['raw']): boolean {
  const r = raw as { aborted?: boolean; complete?: boolean };
  // After the full request has been received (`complete === true`), a later
  // socket close can be server-initiated (request timeout, graceful drain,
  // reply-side transport shutdown). In that phase, only an explicit
  // `raw.aborted` signal is authoritative for client cancellation.
  return r.aborted === true || r.complete !== true;
}

interface RequestAbortSignalOptions {
  readonly requestTimeoutMs?: number;
}

function resolveLifecycleTimeoutMs(options?: RequestAbortSignalOptions): number | undefined {
  const configuredTimeoutMs = options?.requestTimeoutMs ?? REQUEST_LIFECYCLE_TIMEOUT_MS;
  if (
    typeof configuredTimeoutMs !== 'number'
    || !Number.isFinite(configuredTimeoutMs)
    || configuredTimeoutMs <= 0
  ) {
    return undefined;
  }
  return Math.max(1, configuredTimeoutMs - REQUEST_TIMEOUT_ABORT_CUSHION_MS);
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
export function abortSignalFromFastifyRequest(
  request: FastifyRequest,
  reply?: FastifyReply,
  options?: RequestAbortSignalOptions,
): AbortSignal {
  const cached = abortSignalByRequest.get(request);
  if (cached !== undefined) {
    return cached;
  }

  const controller = new AbortController();
  const raw = request.raw;
  const replyRaw = reply?.raw as
    | { once?: (event: string, listener: () => void) => void; removeListener?: (event: string, listener: () => void) => void }
    | undefined;
  const socket = (raw as {
    socket?: {
      once?: (event: string, listener: () => void) => void;
      removeListener?: (event: string, listener: () => void) => void;
    };
  }).socket;
  const timeoutMs = resolveLifecycleTimeoutMs(options);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let replyFinished = false;

  const cleanup = (): void => {
    raw.removeListener('aborted', onAborted);
    if (socket != null && typeof socket.removeListener === 'function') {
      socket.removeListener('close', onSocketClose);
    }
    if (replyRaw != null && typeof replyRaw.removeListener === 'function') {
      replyRaw.removeListener('finish', onReplyFinish);
      replyRaw.removeListener('close', onReplyClose);
    }
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  const onAborted = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    cleanup();
  };

  const onSocketClose = (): void => {
    if (!shouldAbortOnSocketClose(raw)) {
      cleanup();
      return;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
    cleanup();
  };

  const onReplyFinish = (): void => {
    replyFinished = true;
    cleanup();
  };

  const onReplyClose = (): void => {
    if (replyFinished) {
      cleanup();
      return;
    }
    if (!controller.signal.aborted) {
      controller.abort();
    }
    cleanup();
  };

  const onTimeout = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
    cleanup();
  };

  if (rawAlreadyAborted(raw)) {
    controller.abort();
  } else {
    raw.once('aborted', onAborted);
    if (socket != null && typeof socket.once === 'function') {
      socket.once('close', onSocketClose);
    }
    if (replyRaw != null && typeof replyRaw.once === 'function') {
      replyRaw.once('finish', onReplyFinish);
      replyRaw.once('close', onReplyClose);
    }
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(onTimeout, timeoutMs);
    }
  }

  abortSignalByRequest.set(request, controller.signal);
  return controller.signal;
}

export async function raceWithRequestAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (signal === undefined) {
    return await operation;
  }
  if (signal.aborted) {
    throw abortError(message);
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(abortError(message));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
