import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/test-utils';
import { SearchInput } from '../search-input';

const navigationState = vi.hoisted(() => ({
  pushMock: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigationState.pushMock }),
  useSearchParams: () => navigationState.searchParams,
}));

describe('SearchInput', () => {
  it('renders with placeholder', () => {
    renderWithProviders(<SearchInput size="lg" />);
    expect(screen.getByPlaceholderText('와인, 무엇이든 물어보세요...')).toBeTruthy();
  });

  it('has accessible search role', () => {
    renderWithProviders(<SearchInput />);
    expect(screen.getByRole('search')).toBeTruthy();
  });

  it('navigates to search on submit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchInput />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'red wine');
    await user.keyboard('{Enter}');

    expect(navigationState.pushMock).toHaveBeenCalledWith('/search?q=red%20wine');
  });

  it('shows clear button when input has value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchInput />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'hello');
    expect(screen.getByLabelText('검색어 지우기')).toBeTruthy();
  });

  it('clears input on clear button click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SearchInput />);

    const input = screen.getByRole('textbox');
    await user.type(input, 'hello');
    await user.click(screen.getByLabelText('검색어 지우기'));
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('does not navigate with empty query', async () => {
    navigationState.pushMock.mockClear();
    const user = userEvent.setup();
    renderWithProviders(<SearchInput />);

    await user.keyboard('{Enter}');
    expect(navigationState.pushMock).not.toHaveBeenCalled();
  });

  it('syncs the input value when the URL query changes', async () => {
    navigationState.searchParams = new URLSearchParams('q=old-query');
    const { rerender } = renderWithProviders(<SearchInput />);

    const input = screen.getByRole('textbox');
    expect((input as HTMLInputElement).value).toBe('old-query');

    navigationState.searchParams = new URLSearchParams('q=new-query');
    rerender(<SearchInput />);

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('new-query');
    });
  });
});
