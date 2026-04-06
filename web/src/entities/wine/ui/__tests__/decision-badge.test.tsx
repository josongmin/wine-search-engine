import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/__tests__/test-utils';
import { DecisionBadge } from '../decision-badge';

describe('DecisionBadge', () => {
  it('displays score as percentage', () => {
    render(<DecisionBadge score={0.85} />);
    expect(screen.getByText('85%')).toBeInTheDocument();
  });

  it('shows resolved status variant', () => {
    render(<DecisionBadge status="resolved" score={0.9} />);
    const badge = screen.getByText('90%');
    expect(badge).toBeInTheDocument();
  });

  it('handles missing status gracefully', () => {
    render(<DecisionBadge score={0.5} />);
    expect(screen.getByText('50%')).toBeInTheDocument();
  });
});
