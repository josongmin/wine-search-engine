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
    expect(screen.getByText('Cuvée')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    currentPathname = '/';
    renderWithProviders(<Header />);
    expect(screen.getByText('탐색')).toBeInTheDocument();
    expect(screen.getByText('위시리스트')).toBeInTheDocument();
    expect(screen.getByText('에이전트 랩')).toBeInTheDocument();
    // Strangler-fig: the new wine-search lab lives alongside the agent lab.
    expect(screen.getByText('와인 검색 랩')).toBeInTheDocument();
  });

  it('does NOT show search input on home page', () => {
    currentPathname = '/';
    renderWithProviders(<Header />);
    expect(screen.queryByRole('search')).not.toBeInTheDocument();
  });

  it('renders theme toggle', () => {
    currentPathname = '/';
    renderWithProviders(<Header />);
    expect(screen.getByLabelText('시스템 설정')).toBeInTheDocument();
  });
});
