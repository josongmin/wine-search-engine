import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/test-utils';
import { Header } from '../header';

// Mock matchMedia for theme toggle
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

let currentPathname = '/';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => currentPathname,
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

describe('Header', () => {
  it('renders site title', () => {
    currentPathname = '/';
    renderWithProviders(<Header />);
    expect(screen.getByText('Wine Search')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    currentPathname = '/';
    renderWithProviders(<Header />);
    expect(screen.getByText('홈')).toBeInTheDocument();
    expect(screen.getByText('탐색')).toBeInTheDocument();
    expect(screen.getByText('워치리스트')).toBeInTheDocument();
  });

  it('does NOT show search input on home page', () => {
    currentPathname = '/';
    renderWithProviders(<Header />);
    expect(screen.queryByPlaceholderText('와인, 무엇이든 물어보세요...')).not.toBeInTheDocument();
  });

  it('shows search input on non-home pages', () => {
    currentPathname = '/search';
    renderWithProviders(<Header />);
    expect(screen.getByPlaceholderText('와인, 무엇이든 물어보세요...')).toBeInTheDocument();
  });

  it('renders theme toggle', () => {
    currentPathname = '/';
    renderWithProviders(<Header />);
    // Theme toggle renders an icon button with aria-label
    expect(screen.getByLabelText(/모드|설정/)).toBeInTheDocument();
  });
});
