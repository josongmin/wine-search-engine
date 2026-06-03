import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/test-utils';
import { SearchApiView } from '../search-api-view';
import { rawApiCall } from '@/shared/api/client';

vi.mock('@/shared/api/client', () => ({
  rawApiCall: vi.fn(),
}));

const rawMock = vi.mocked(rawApiCall);

describe('SearchApiView', () => {
  beforeEach(() => {
    rawMock.mockReset();
    rawMock.mockResolvedValue({ ok: true, status: 200, durationMs: 7, body: { results: [] } });
  });

  it('defaults to hybrid search with a query template', () => {
    renderWithProviders(<SearchApiView />);
    expect(screen.getByText('POST /v1/search/hybrid')).toBeInTheDocument();
    const body = screen.getByLabelText('request body') as HTMLTextAreaElement;
    expect(body.value).toContain('"query"');
  });

  it('fires hybrid search as a public POST (no auth headers)', async () => {
    renderWithProviders(<SearchApiView />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(rawMock).toHaveBeenCalledWith(
        'POST',
        '/v1/search/hybrid',
        expect.objectContaining({ body: expect.stringContaining('query') }),
      ),
    );
    // public endpoints carry no debug/write key
    const opts = rawMock.mock.calls[0]?.[2] ?? {};
    expect(opts).not.toHaveProperty('debugKey');
    expect(opts).not.toHaveProperty('writeKey');
  });

  it('switches to the agentic endpoint with a messages template', async () => {
    renderWithProviders(<SearchApiView />);
    fireEvent.change(screen.getByLabelText('endpoint'), { target: { value: 'agent' } });

    const body = screen.getByLabelText('request body') as HTMLTextAreaElement;
    expect(body.value).toContain('"messages"');

    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(rawMock).toHaveBeenCalledWith(
        'POST',
        '/v1/agent',
        expect.objectContaining({ body: expect.stringContaining('messages') }),
      ),
    );
  });

  it('renders the response status and body verbatim', async () => {
    rawMock.mockResolvedValue({ ok: true, status: 200, durationMs: 9, body: { results: [{ id: 'w1' }] } });
    renderWithProviders(<SearchApiView />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText('200')).toBeInTheDocument());
    expect(screen.getByText(/"id": "w1"/)).toBeInTheDocument();
  });

  it('blocks invalid JSON before calling the API', async () => {
    renderWithProviders(<SearchApiView />);
    fireEvent.change(screen.getByLabelText('request body'), { target: { value: '{bad' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/invalid json body/i)).toBeInTheDocument());
    expect(rawMock).not.toHaveBeenCalled();
  });
});
