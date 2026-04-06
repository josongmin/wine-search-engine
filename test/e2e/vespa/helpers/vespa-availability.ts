async function fetchOk(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, init);
    return response.ok;
  } catch {
    return false;
  }
}

/** True if the HTTP client gets any response (Vespa answered), not necessarily 2xx. */
async function fetchAnyResponse(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const response = await fetch(url, init);
    void response;
    return true;
  } catch {
    return false;
  }
}

/**
 * Optional override: full URL to a health endpoint (or Vespa base; /state/v1/health is appended).
 */
async function probeExplicitHealth(): Promise<boolean> {
  const explicit = process.env['VESPA_HEALTH_URL'];
  if (explicit === undefined || explicit.length === 0) {
    return false;
  }
  const trimmed = explicit.replace(/\/$/, '');
  const url = trimmed.endsWith('/state/v1/health') ? trimmed : `${trimmed}/state/v1/health`;
  return fetchOk(url);
}

/**
 * Same base URL as VespaClient — query/feed container must be reachable, not only the config server.
 */
async function probeVespaHealth(): Promise<boolean> {
  if (await probeExplicitHealth()) {
    return true;
  }

  const vespaUrl = process.env['VESPA_URL'];
  if (vespaUrl === undefined || vespaUrl.length === 0) {
    return false;
  }

  const base = vespaUrl.replace(/\/$/, '');

  if (await fetchOk(`${base}/ApplicationStatus`)) {
    return true;
  }
  if (await fetchOk(`${base}/state/v1/health`)) {
    return true;
  }

  return fetchAnyResponse(`${base}/search/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yql: 'select * from sources * where true limit 1;', hits: 1 }),
  });
}

export const HAS_REACHABLE_VESPA = await probeVespaHealth();
