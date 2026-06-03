import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/test-utils';
import { OpsPlaygroundView } from '../playground-view';
import { rawApiCall } from '@/shared/api/client';

vi.mock('@/shared/api/client', () => ({
  rawApiCall: vi.fn(),
}));

const rawMock = vi.mocked(rawApiCall);

const DEBUG_KEY = 'debug-secret-key';
const WRITE_KEY = 'write-secret-key';

describe('OpsPlaygroundView', () => {
  beforeEach(() => {
    sessionStorage.clear();
    rawMock.mockReset();
    rawMock.mockResolvedValue({ ok: true, status: 200, durationMs: 5, body: { status: 'ok' } });
  });

  it('defaults to the health endpoint (GET, no body editor)', () => {
    renderWithProviders(<OpsPlaygroundView />);
    expect(screen.getByText('GET /health')).toBeInTheDocument();
    expect(screen.queryByLabelText('request body')).not.toBeInTheDocument();
  });

  it('fires the selected endpoint and renders the raw status + body', async () => {
    rawMock.mockResolvedValue({ ok: true, status: 200, durationMs: 12, body: { status: 'ok', uptime: 1 } });
    renderWithProviders(<OpsPlaygroundView />);

    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(rawMock).toHaveBeenCalledWith('GET', '/health', {}));
    expect(screen.getByText('200')).toBeInTheDocument();
    expect(screen.getByText(/"uptime": 1/)).toBeInTheDocument();
  });

  it('loads a JSON template and sends it as the body for POST endpoints', async () => {
    renderWithProviders(<OpsPlaygroundView />);
    fireEvent.change(screen.getByLabelText('endpoint'), { target: { value: 'lookup' } });

    const bodyEl = screen.getByLabelText('request body') as HTMLTextAreaElement;
    expect(bodyEl.value).toContain('"query": "sassicaia"');

    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(rawMock).toHaveBeenCalledWith(
        'POST',
        '/v2/entity-lookup',
        expect.objectContaining({ body: expect.stringContaining('sassicaia') }),
      ),
    );
  });

  it('attaches X-Debug-Key for debug-gated endpoints', async () => {
    sessionStorage.setItem('elv2.ops.debugKey', DEBUG_KEY);
    renderWithProviders(<OpsPlaygroundView />);
    fireEvent.change(screen.getByLabelText('endpoint'), { target: { value: 'inspect' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(rawMock).toHaveBeenCalledWith(
        'POST',
        '/v2/entity-lookup/ops/inspect',
        expect.objectContaining({ debugKey: DEBUG_KEY }),
      ),
    );
  });

  it('attaches BOTH keys for write-gated endpoints', async () => {
    sessionStorage.setItem('elv2.ops.debugKey', DEBUG_KEY);
    sessionStorage.setItem('elv2.ops.writeKey', WRITE_KEY);
    renderWithProviders(<OpsPlaygroundView />);
    fireEvent.change(screen.getByLabelText('endpoint'), { target: { value: 'submit-alias' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(rawMock).toHaveBeenCalledWith(
        'POST',
        '/v2/entity-lookup/ops/proposals/submit',
        expect.objectContaining({ debugKey: DEBUG_KEY, writeKey: WRITE_KEY }),
      ),
    );
  });

  it('warns (but does not block) when a required key is missing', () => {
    renderWithProviders(<OpsPlaygroundView />);
    fireEvent.change(screen.getByLabelText('endpoint'), { target: { value: 'inspect' } });
    expect(screen.getByText(/needs the X-Debug-Key/i)).toBeInTheDocument();
  });

  it('blocks an invalid JSON body before calling the API', async () => {
    renderWithProviders(<OpsPlaygroundView />);
    fireEvent.change(screen.getByLabelText('endpoint'), { target: { value: 'lookup' } });
    fireEvent.change(screen.getByLabelText('request body'), { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText(/invalid json body/i)).toBeInTheDocument());
    expect(rawMock).not.toHaveBeenCalled();
  });

  it('shows a non-2xx response verbatim without treating it as a thrown error', async () => {
    rawMock.mockResolvedValue({
      ok: false,
      status: 403,
      durationMs: 3,
      body: { error: { code: 'POLICY_BLOCKED', message: 'blocked' } },
    });
    sessionStorage.setItem('elv2.ops.debugKey', DEBUG_KEY);
    renderWithProviders(<OpsPlaygroundView />);
    fireEvent.change(screen.getByLabelText('endpoint'), { target: { value: 'inspect' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText('403')).toBeInTheDocument());
    expect(screen.getByText(/POLICY_BLOCKED/)).toBeInTheDocument();
  });
});
