import type { ReadinessStatus } from '../interface/http/routes/health.route.js';

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

    return response.status < 500 ? 'up' : 'down';
  });
}
