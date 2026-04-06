import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/test-utils';
import { FeedbackButtons } from '../feedback-buttons';

vi.mock('@/shared/api', () => ({
  api: {
    submitFeedback: vi.fn().mockResolvedValue({ signal_id: 's1', accepted: true }),
  },
}));

describe('FeedbackButtons', () => {
  it('renders thumbs up and down buttons', () => {
    renderWithProviders(
      <FeedbackButtons query="red wine" entityId="wine:1" />,
    );
    expect(screen.getByLabelText('도움이 됐어요')).toBeInTheDocument();
    expect(screen.getByLabelText('관련 없어요')).toBeInTheDocument();
  });

  it('has accessible group role', () => {
    renderWithProviders(
      <FeedbackButtons query="red wine" entityId="wine:1" />,
    );
    expect(screen.getByRole('group')).toBeInTheDocument();
  });

  it('disables buttons after clicking', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <FeedbackButtons query="red wine" entityId="wine:1" />,
    );

    const upBtn = screen.getByLabelText('도움이 됐어요');
    await user.click(upBtn);

    // Both buttons should become disabled after click
    expect(screen.getByLabelText('도움이 됐어요')).toBeDisabled();
    expect(screen.getByLabelText('관련 없어요')).toBeDisabled();
  });
});
