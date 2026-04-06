import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/__tests__/test-utils';
import { ComparisonTable } from '../comparison-table';
import { mockComparisonResponse } from '@/__tests__/fixtures';

describe('ComparisonTable', () => {
  it('renders two wine names', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);
    expect(screen.getByText('Château Margaux 2018')).toBeInTheDocument();
    expect(screen.getByText('Opus One 2019')).toBeInTheDocument();
  });

  it('renders VS badge', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);
    expect(screen.getByText('VS')).toBeInTheDocument();
  });

  it('renders field labels for both wines', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);
    const regions = screen.getAllByText('Region');
    expect(regions).toHaveLength(2);
  });

  it('returns null with less than 2 items', () => {
    const { container } = render(
      <ComparisonTable items={[mockComparisonResponse.results[0]]} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('has accessible group role', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);
    expect(screen.getByRole('group')).toBeInTheDocument();
  });
});
