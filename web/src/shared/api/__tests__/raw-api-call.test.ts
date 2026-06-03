import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rawApiCall } from '../client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('rawApiCall', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok + parsed body on 2xx', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { status: 'ok' }));
    const res = await rawApiCall('GET', '/health');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns the status + body verbatim on non-2xx WITHOUT throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, { error: { code: 'POLICY_BLOCKED' } }));
    const res = await rawApiCall('POST', '/v2/entity-lookup/ops/inspect', { debugKey: 'k' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'POLICY_BLOCKED' } });
  });

  it('attaches X-Debug-Key / X-Ops-Write-Key headers when provided', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));
    await rawApiCall('POST', '/x', { debugKey: 'dk', writeKey: 'wk', body: '{}' });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Debug-Key']).toBe('dk');
    expect(headers['X-Ops-Write-Key']).toBe('wk');
    expect(init?.body).toBe('{}');
  });

  it('does not attach a body for GET', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));
    await rawApiCall('GET', '/health', { body: '{"x":1}' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('falls back to text when the body is not JSON', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('plain text', { status: 200 }));
    const res = await rawApiCall('GET', '/health');
    expect(res.body).toBe('plain text');
  });

  it('captures network failures as status 0 instead of throwing', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await rawApiCall('GET', '/health');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.body).toEqual({ error: 'ECONNREFUSED' });
  });
});
