import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/__tests__/test-utils';
import { EvidenceSummary } from '../evidence-summary';
import { mockResultItem } from '@/__tests__/fixtures';

describe('EvidenceSummary', () => {
  it('renders top N evidence items sorted by strength', () => {
    render(<EvidenceSummary items={mockResultItem.evidence_items} max={2} />);
    // High strength first
    expect(screen.getByText('+0.42')).toBeInTheDocument();
    expect(screen.getByText('Matched canonical label')).toBeInTheDocument();
    // Medium second
    expect(screen.getByText('+0.20')).toBeInTheDocument();
  });

  it('shows remaining count', () => {
    render(<EvidenceSummary items={mockResultItem.evidence_items} max={2} />);
    expect(screen.getByText('+1 more')).toBeInTheDocument();
  });

  it('renders all when max exceeds count', () => {
    render(<EvidenceSummary items={mockResultItem.evidence_items} max={10} />);
    expect(screen.queryByText(/more/)).not.toBeInTheDocument();
  });

  it('renders empty state gracefully', () => {
    render(<EvidenceSummary items={[]} />);
    expect(screen.getByText('Evidence')).toBeInTheDocument();
  });
});
