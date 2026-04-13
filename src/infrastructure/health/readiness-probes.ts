import { fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ReadinessStatus } from '../../interface/http/routes/health.route.js';

/** Vespa Cloud mTLS handshake + cold start can take ~1.5s; 750ms was too
 *  aggressive and caused permanent "down" status on cloud endpoints. */
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
/** JSON POST probe treats this HTTP status range as dependency healthy. */
const READINESS_PROBE_HTTP_SUCCESS_MIN = 200;
const READINESS_PROBE_HTTP_SUCCESS_MAX_EXCLUSIVE = 300;

export async function withProbeTimeout(
  operation: (signal: AbortSignal) => Promise<ReadinessStatus>,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ReadinessStatus> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch {
    return 'down';
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function probeJsonPostEndpoint(
  url: string,
  payload: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  dispatcher?: Dispatcher,
): Promise<ReadinessStatus> {
  return withProbeTimeout(async (signal) => {
    let response: Response;
    if (dispatcher !== undefined) {
      response = await undiciFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(payload),
        signal,
        dispatcher,
      }) as unknown as Response;
    } else {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(payload),
        signal,
      });
    }

    // Only 2xx counts as up. 401/403 (auth misconfig), 404 (wrong URL),
    // 429 (rate-limited), and 5xx all indicate the dependency cannot serve
    // production traffic. Earlier code accepted any < 500 which silently
    // hid auth/config drift behind a green health page.
    return response.status >= READINESS_PROBE_HTTP_SUCCESS_MIN
      && response.status < READINESS_PROBE_HTTP_SUCCESS_MAX_EXCLUSIVE
      ? 'up'
      : 'down';
  });
}
