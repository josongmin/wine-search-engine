/**
 * Shared {@link AbortSignal} helpers for domain + application layers.
 */

/**
 * True for cooperative cancellation (`fetch` / `AbortController`, Node `DOMException`).
 */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  return (
    typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && error.name === 'AbortError'
  );
}

export function abortError(message: string, cause?: unknown): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  if (cause instanceof Error) {
    error.cause = cause;
  }
  return error;
}

/**
 * Throws an `AbortError`-named {@link Error} when the signal is already aborted.
 */
export function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted === true) {
    throw abortError(message);
  }
}
