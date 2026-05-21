import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/test-utils';
import { WatchlistList } from '../watchlist-list';
import { WatchlistButton } from '../watchlist-button';
import type { WatchlistListResponse } from '@/shared/api';

// ─── Mocks ───
// All watchlist UI traffic flows through `api.watchlist.{list,create,delete}` —
// this is the network boundary we pin per the component test pattern.
const listMock = vi.fn();
const createMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    watchlist: {
      list: (...args: unknown[]) => listMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
    },
  },
}));

// Pin the subject id so the React Query cache key is stable across tests
// (subject id rotation would invalidate the cache between renders).
vi.mock('@/shared/lib/subject', () => ({
  getSubjectId: () => 'test-subject-id',
}));

// Helper to build a deterministic entry. Korean entity_id is intentional —
// the rendered label must preserve NFC composition (rule 5).
function makeEntry(overrides: Partial<WatchlistListResponse['entries'][number]> = {}) {
  return {
    watchlist_id: 'wl-1',
    user_id: 'sub-1',
    entity_id: 'wine:opus-one',
    trigger_conditions: [{ type: 'new_vintage' as const }],
    callback_url: 'https://example.test/hook',
    created_at: '2026-05-21T00:00:00.000Z',
    expires_at: null,
    ...overrides,
  };
}

describe('WatchlistList (watchlist UI component)', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
    deleteMock.mockReset();
  });

  // ─── Render: empty list → empty state ───

  it('renders an empty-state message when the list has zero entries', async () => {
    listMock.mockResolvedValueOnce({ entries: [], total: 0 } satisfies WatchlistListResponse);

    renderWithProviders(<WatchlistList />);

    expect(await screen.findByText('아직 워치리스트가 비어있습니다.')).toBeInTheDocument();
    // The empty-state must NOT render a list role — guards against ghost rows.
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  // ─── Render: N items → list of N entries with canonical labels ───

  it('renders N entries with canonical entity labels', async () => {
    const entries = [
      makeEntry({ watchlist_id: 'wl-1', entity_id: 'wine:opus-one' }),
      makeEntry({ watchlist_id: 'wl-2', entity_id: 'wine:sassicaia' }),
      makeEntry({ watchlist_id: 'wl-3', entity_id: 'wine:dom-perignon' }),
    ];
    listMock.mockResolvedValueOnce({ entries, total: 3 } satisfies WatchlistListResponse);

    renderWithProviders(<WatchlistList />);

    await waitFor(() => {
      expect(screen.getByRole('list', { name: '워치리스트 항목' })).toBeInTheDocument();
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('wine:opus-one')).toBeInTheDocument();
    expect(screen.getByText('wine:sassicaia')).toBeInTheDocument();
    expect(screen.getByText('wine:dom-perignon')).toBeInTheDocument();
  });

  // ─── Korean entity label rendering: NFC preserved (rule 5) ───

  it('renders Korean entity labels verbatim with NFC composition preserved', async () => {
    const koreanLabel = '오푸스 원';
    // NFC composed form — must round-trip through the DOM untouched.
    expect(koreanLabel.normalize('NFC')).toBe(koreanLabel);
    const entries = [makeEntry({ entity_id: koreanLabel })];
    listMock.mockResolvedValueOnce({ entries, total: 1 } satisfies WatchlistListResponse);

    renderWithProviders(<WatchlistList />);

    const labelNode = await screen.findByText(koreanLabel);
    expect(labelNode).toBeInTheDocument();
    expect(labelNode.textContent).toBe(koreanLabel);
    // Delete button's aria-label must also carry the Korean label verbatim.
    expect(
      screen.getByLabelText(`${koreanLabel} 워치리스트에서 삭제`),
    ).toBeInTheDocument();
  });

  // ─── Remove from watchlist click → api.watchlist.delete called with watchlist_id ───

  it('clicking the remove button calls api.watchlist.delete with the watchlist_id', async () => {
    const user = userEvent.setup();
    const entry = makeEntry({ watchlist_id: 'wl-target', entity_id: 'wine:to-remove' });
    listMock.mockResolvedValueOnce({ entries: [entry], total: 1 } satisfies WatchlistListResponse);
    deleteMock.mockResolvedValueOnce(undefined);

    renderWithProviders(<WatchlistList />);

    const removeBtn = await screen.findByLabelText('wine:to-remove 워치리스트에서 삭제');
    await user.click(removeBtn);

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(1);
    });
    expect(deleteMock).toHaveBeenCalledWith('wl-target');
  });

  // ─── Loading state: while pending, no list/empty/error renders ───

  it('shows a loading indicator while the list request is pending', () => {
    // Never-resolving promise → component stays in `isLoading`.
    listMock.mockReturnValueOnce(new Promise(() => {}));

    renderWithProviders(<WatchlistList />);

    expect(screen.getByText('로딩 중...')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // ─── Error state: list query rejects → role="alert" surfaced, no crash ───

  it('renders an error indicator when the list request fails', async () => {
    listMock.mockRejectedValueOnce(new Error('network down'));

    renderWithProviders(<WatchlistList />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('워치리스트를 불러올 수 없습니다.');
    // The Bell empty-state icon must NOT be reused as an error indicator.
    expect(screen.queryByText('아직 워치리스트가 비어있습니다.')).not.toBeInTheDocument();
  });

  // ─── Accessibility regression: every interactive button exposes a non-empty aria-label ───

  it('every rendered button exposes a non-empty aria-label', async () => {
    const entries = [
      makeEntry({ watchlist_id: 'wl-1', entity_id: 'wine:a' }),
      makeEntry({ watchlist_id: 'wl-2', entity_id: 'wine:b' }),
    ];
    listMock.mockResolvedValueOnce({ entries, total: 2 } satisfies WatchlistListResponse);

    renderWithProviders(<WatchlistList />);

    await screen.findByRole('list');
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).toHaveAttribute('aria-label');
      expect(btn.getAttribute('aria-label')?.trim()).not.toBe('');
    }
  });

  // ─── Keyboard activation: Enter on the remove button triggers delete (a11y) ───

  it('activates the remove button via Enter key (keyboard navigation)', async () => {
    const user = userEvent.setup();
    const entry = makeEntry({ watchlist_id: 'wl-kb', entity_id: 'wine:kb' });
    listMock.mockResolvedValueOnce({ entries: [entry], total: 1 } satisfies WatchlistListResponse);
    deleteMock.mockResolvedValueOnce(undefined);

    renderWithProviders(<WatchlistList />);

    const removeBtn = await screen.findByLabelText('wine:kb 워치리스트에서 삭제');
    removeBtn.focus();
    expect(removeBtn).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(1);
    });
    expect(deleteMock).toHaveBeenCalledWith('wl-kb');
  });

  // ─── Keyboard activation: Space on the remove button triggers delete (a11y) ───

  it('activates the remove button via Space key (keyboard navigation)', async () => {
    const user = userEvent.setup();
    const entry = makeEntry({ watchlist_id: 'wl-sp', entity_id: 'wine:sp' });
    listMock.mockResolvedValueOnce({ entries: [entry], total: 1 } satisfies WatchlistListResponse);
    deleteMock.mockResolvedValueOnce(undefined);

    renderWithProviders(<WatchlistList />);

    const removeBtn = await screen.findByLabelText('wine:sp 워치리스트에서 삭제');
    removeBtn.focus();
    await user.keyboard(' ');

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(1);
    });
    expect(deleteMock).toHaveBeenCalledWith('wl-sp');
  });
});

describe('WatchlistButton (add-to-watchlist control)', () => {
  beforeEach(() => {
    listMock.mockReset();
    createMock.mockReset();
    deleteMock.mockReset();
  });

  // ─── Add to watchlist click → api.watchlist.create called with the entity_id ───

  it('clicking the add button calls api.watchlist.create with the entity_id', async () => {
    const user = userEvent.setup();
    createMock.mockResolvedValueOnce({
      watchlist_id: 'wl-new',
      user_id: 'sub',
      entity_id: 'wine:42',
      trigger_conditions: [{ type: 'new_vintage' }],
      callback_url: 'https://placeholder.example.com/webhook',
      created_at: '2026-05-21T00:00:00.000Z',
      expires_at: null,
    });

    renderWithProviders(<WatchlistButton entityId="wine:42" />);

    await user.click(screen.getByLabelText('워치리스트에 추가'));

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ entity_id: 'wine:42' });
  });

  // ─── Loading state: while pending, the add button is disabled ───

  it('disables the add button while the create request is pending', async () => {
    const user = userEvent.setup();
    let resolveFn: (v: unknown) => void = () => {};
    createMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );

    renderWithProviders(<WatchlistButton entityId="wine:42" />);
    const btn = screen.getByLabelText('워치리스트에 추가');

    await user.click(btn);
    expect(btn).toBeDisabled();

    // Second click during pending state must not enqueue a second create call.
    await user.click(btn);
    expect(createMock).toHaveBeenCalledTimes(1);

    resolveFn({
      watchlist_id: 'wl-done',
      user_id: 'sub',
      entity_id: 'wine:42',
      trigger_conditions: [{ type: 'new_vintage' }],
      callback_url: 'https://placeholder.example.com/webhook',
      created_at: '2026-05-21T00:00:00.000Z',
      expires_at: null,
    });
    // After success the widget swaps to the "추가됨" confirmation control.
    await waitFor(() => {
      expect(screen.getByLabelText('워치리스트에 추가됨')).toBeInTheDocument();
    });
  });

  // ─── Error state: create rejects → role="alert" with failure message ───

  it('renders an error indicator when the create request fails', async () => {
    const user = userEvent.setup();
    createMock.mockRejectedValueOnce(new Error('boom'));

    renderWithProviders(<WatchlistButton entityId="wine:42" />);
    await user.click(screen.getByLabelText('워치리스트에 추가'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('추가 실패');
    // The button itself must remain mounted so the user can retry.
    expect(screen.getByLabelText('워치리스트에 추가')).toBeInTheDocument();
  });
});
