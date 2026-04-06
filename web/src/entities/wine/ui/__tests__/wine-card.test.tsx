import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/test-utils';
import { mockResultItem } from '@/__tests__/fixtures';
import { WineCard } from '../wine-card';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/search',
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

describe('WineCard', () => {
  it('renders wine name and region', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    expect(screen.getByText('Château Margaux 2018')).toBeInTheDocument();
    expect(screen.getByText('Margaux, Bordeaux')).toBeInTheDocument();
  });

  it('renders producer', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    expect(screen.getByText('Château Margaux')).toBeInTheDocument();
  });

  it('renders rank when provided', () => {
    renderWithProviders(<WineCard item={mockResultItem} rank={1} />);
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders grapes', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    expect(screen.getByText('Cabernet Sauvignon, Merlot')).toBeInTheDocument();
  });

  it('renders vintage', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    expect(screen.getByText('2018')).toBeInTheDocument();
  });

  it('renders price band', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    expect(screen.getByText('$$$$$')).toBeInTheDocument();
  });

  it('renders relevance score', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    expect(screen.getByText('92%')).toBeInTheDocument();
  });

  it('renders constraint tags', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    expect(screen.getByText('✓ red wine')).toBeInTheDocument();
    expect(screen.getByText('✗ under 50000')).toBeInTheDocument();
    expect(screen.getByText('~ premium')).toBeInTheDocument();
  });

  it('renders drinking window when available', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    expect(screen.getByText('지금 마시기 좋은 시기')).toBeInTheDocument();
  });

  it('renders detail link', () => {
    renderWithProviders(<WineCard item={mockResultItem} />);
    const link = screen.getByText('상세보기 →');
    expect(link.closest('a')).toHaveAttribute('href', '/wine/wine%3Aabc123');
  });

  it('renders actions slot', () => {
    renderWithProviders(
      <WineCard item={mockResultItem} actions={<button>Custom Action</button>} />,
    );
    expect(screen.getByText('Custom Action')).toBeInTheDocument();
  });
});
