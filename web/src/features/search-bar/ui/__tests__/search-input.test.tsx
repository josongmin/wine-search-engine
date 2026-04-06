import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/test-utils';
import { SearchInput } from '../search-input';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('SearchInput', () => {
  it('renders with placeholder', () => {
    renderWithProviders(<SearchInput />);
    expect(screen.getByPlaceholderText('와인, 무엇이든 물어보세요...')).toBeInTheDocument();
  });

  it('has accessible search role', () => {
    renderWithProviders(<SearchInput />);
    expect(screen.getByRole('search')).toBeInTheDocument();
  });

  it('navigates to search on submit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchInput />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'red wine');
    await user.keyboard('{Enter}');

    expect(pushMock).toHaveBeenCalledWith('/search?q=red%20wine');
  });

  it('shows clear button when input has value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchInput />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'hello');
    expect(screen.getByLabelText('검색어 지우기')).toBeInTheDocument();
  });

  it('clears input on clear button click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchInput />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'hello');
    await user.click(screen.getByLabelText('검색어 지우기'));
    expect(input).toHaveValue('');
  });

  it('does not navigate with empty query', async () => {
    pushMock.mockClear();
    const user = userEvent.setup();
    renderWithProviders(<SearchInput />);

    await user.keyboard('{Enter}');
    expect(pushMock).not.toHaveBeenCalled();
  });
});
