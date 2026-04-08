import type { ReadinessStatus } from '../../interface/http/routes/health.route.js';

const DEFAULT_PROBE_TIMEOUT_MS = 750;

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
): Promise<ReadinessStatus> {
  return withProbeTimeout(async (signal) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

    // Only 2xx counts as up. 401/403 (auth misconfig), 404 (wrong URL),
    // 429 (rate-limited), and 5xx all indicate the dependency cannot serve
    // production traffic. Earlier code accepted any < 500 which silently
    // hid auth/config drift behind a green health page.
    return response.status >= 200 && response.status < 300 ? 'up' : 'down';
  });
}
