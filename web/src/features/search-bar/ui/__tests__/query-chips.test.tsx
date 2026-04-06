import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/test-utils';
import { QueryChips } from '../query-chips';
import { EXAMPLE_QUERIES } from '@/shared/config/constants';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe('QueryChips', () => {
  it('renders all example queries', () => {
    renderWithProviders(<QueryChips />);
    for (const { label } of EXAMPLE_QUERIES) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('navigates to search on chip click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<QueryChips />);

    await user.click(screen.getByText(EXAMPLE_QUERIES[0].label));
    expect(pushMock).toHaveBeenCalledWith(
      expect.stringContaining('/search?q='),
    );
  });

  it('has accessible list role', () => {
    renderWithProviders(<QueryChips />);
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});
