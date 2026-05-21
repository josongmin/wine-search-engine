import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/test-utils';
import { FeedbackButtons } from '../feedback-buttons';

// ─── Mocks ───
// api.submitFeedback is the network boundary the widget calls via useFeedback.
// We mock it per-test so each scenario can assert call args / promise behavior
// without real network traffic.
const submitFeedbackMock = vi.fn();
vi.mock('@/shared/api', () => ({
  api: {
    submitFeedback: (...args: unknown[]) => submitFeedbackMock(...args),
  },
}));

// Pin session id so we can assert the request payload deterministically.
vi.mock('@/shared/lib', async () => {
  const actual = await vi.importActual<typeof import('@/shared/lib')>('@/shared/lib');
  return {
    ...actual,
    getSessionId: () => 'test-session-id',
  };
});

const QUERY = 'red wine';
const ENTITY_ID = 'wine:42';

describe('FeedbackButtons (widget component)', () => {
  beforeEach(() => {
    submitFeedbackMock.mockReset();
    submitFeedbackMock.mockResolvedValue({ signal_id: 'sig-1', accepted: true });
  });

  // ─── Render ───

  it('renders without crashing given default props', () => {
    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);
    expect(screen.getByRole('group')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  // ─── Korean label rendering (verbatim) ───

  it('renders Korean aria-labels verbatim', () => {
    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);
    expect(screen.getByLabelText('도움이 됐어요')).toBeInTheDocument();
    expect(screen.getByLabelText('관련 없어요')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '검색 결과 피드백' })).toBeInTheDocument();
  });

  // ─── Positive click → signal_type: 'click' ───

  it('positive click submits feedback with signal_type "click"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);

    await user.click(screen.getByLabelText('도움이 됐어요'));

    await waitFor(() => {
      expect(submitFeedbackMock).toHaveBeenCalledTimes(1);
    });
    expect(submitFeedbackMock).toHaveBeenCalledWith({
      query: QUERY,
      entity_id: ENTITY_ID,
      signal_type: 'click',
      session_id: 'test-session-id',
    });
  });

  // ─── Negative click → signal_type: 'dismiss' ───

  it('negative click submits feedback with signal_type "dismiss"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);

    await user.click(screen.getByLabelText('관련 없어요'));

    await waitFor(() => {
      expect(submitFeedbackMock).toHaveBeenCalledTimes(1);
    });
    expect(submitFeedbackMock).toHaveBeenCalledWith({
      query: QUERY,
      entity_id: ENTITY_ID,
      signal_type: 'dismiss',
      session_id: 'test-session-id',
    });
  });

  // ─── No double-submit: both buttons disabled after a click is in-flight & after success ───

  it('disables both buttons after a click to prevent double submission', async () => {
    const user = userEvent.setup();
    // Hold the promise pending so we can observe the in-flight disabled state.
    let resolveFn: (v: { signal_id: string; accepted: true }) => void = () => {};
    submitFeedbackMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );

    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);
    const positive = screen.getByLabelText('도움이 됐어요');
    const negative = screen.getByLabelText('관련 없어요');

    await user.click(positive);

    // In-flight: both buttons must be disabled (loading state).
    expect(positive).toBeDisabled();
    expect(negative).toBeDisabled();

    // A second click while in-flight must not enqueue another submission.
    await user.click(positive);
    await user.click(negative);
    expect(submitFeedbackMock).toHaveBeenCalledTimes(1);

    // Resolve and confirm buttons remain disabled (one-shot widget — `sent` is set).
    resolveFn({ signal_id: 'sig-1', accepted: true });
    await waitFor(() => {
      expect(positive).toBeDisabled();
      expect(negative).toBeDisabled();
    });
    expect(submitFeedbackMock).toHaveBeenCalledTimes(1);
  });

  // ─── Error handling: callback (api) rejects → widget shows error indicator, no crash ───

  it('renders an error indicator when submission fails (graceful recovery)', async () => {
    const user = userEvent.setup();
    submitFeedbackMock.mockRejectedValueOnce(new Error('network down'));

    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);
    await user.click(screen.getByLabelText('관련 없어요'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('전송 실패');
    // Widget still mounted — group survives.
    expect(screen.getByRole('group')).toBeInTheDocument();
  });

  // ─── Adjacent regression: accessibility — both buttons expose aria-label ───

  it('every button exposes an aria-label (accessibility regression)', () => {
    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).toHaveAttribute('aria-label');
      expect(btn.getAttribute('aria-label')?.trim()).not.toBe('');
    }
  });

  // ─── Adjacent regression: keyboard activation (Enter triggers submit) ───

  it('activates positive button via Enter key (keyboard navigation)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);

    const positive = screen.getByLabelText('도움이 됐어요');
    positive.focus();
    expect(positive).toHaveFocus();

    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(submitFeedbackMock).toHaveBeenCalledTimes(1);
    });
    expect(submitFeedbackMock.mock.calls[0]?.[0]).toMatchObject({
      signal_type: 'click',
    });
  });

  // ─── Adjacent regression: keyboard activation (Space triggers submit) ───

  it('activates negative button via Space key (keyboard navigation)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FeedbackButtons query={QUERY} entityId={ENTITY_ID} />);

    const negative = screen.getByLabelText('관련 없어요');
    negative.focus();
    await user.keyboard(' ');

    await waitFor(() => {
      expect(submitFeedbackMock).toHaveBeenCalledTimes(1);
    });
    expect(submitFeedbackMock.mock.calls[0]?.[0]).toMatchObject({
      signal_type: 'dismiss',
    });
  });
});
