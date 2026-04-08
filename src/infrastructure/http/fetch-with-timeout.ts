/**
 * Shared `fetch` wrapper with AbortSignal-based timeout for HTTP service adapters.
 */

export { isAbortError } from '../../domain/shared/cooperative-abort.js';

/**
 * `fetch` with a wall-clock timeout. Uses a dedicated `AbortController` and
 * optionally composes with an external `AbortSignal` — the request is cancelled
 * when either the timeout fires or the external signal aborts, whichever comes first.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();

  // If the external signal is ALREADY aborted, abort immediately so fetch
  // never starts. Without this, addEventListener would never fire (event
  // already dispatched) and we'd send the request anyway.
  if (externalSignal?.aborted === true) {
    controller.abort();
  }

  const id = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  // Forward future external aborts to our controller.
  const onExternalAbort = (): void => {
    controller.abort();
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
