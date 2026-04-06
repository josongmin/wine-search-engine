import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/test-utils';
import { ExploreGrid } from '../explore-grid';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe('ExploreGrid', () => {
  it('renders region section', () => {
    renderWithProviders(<ExploreGrid />);
    expect(screen.getByText('산지별 탐색')).toBeInTheDocument();
  });

  it('renders style section', () => {
    renderWithProviders(<ExploreGrid />);
    expect(screen.getByText('스타일별 탐색')).toBeInTheDocument();
  });

  it('renders region items', () => {
    renderWithProviders(<ExploreGrid />);
    expect(screen.getByText('보르도')).toBeInTheDocument();
    expect(screen.getByText('나파 밸리')).toBeInTheDocument();
  });

  it('navigates on item click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExploreGrid />);

    await user.click(screen.getByText('보르도'));
    expect(pushMock).toHaveBeenCalledWith(
      expect.stringContaining('/search?q='),
    );
  });

  it('has accessible section labels', () => {
    renderWithProviders(<ExploreGrid />);
    expect(screen.getByLabelText('산지별 탐색')).toBeInTheDocument();
    expect(screen.getByLabelText('스타일별 탐색')).toBeInTheDocument();
  });
});
