/**
 * Dedicated component test for the wine comparison widget (`ComparisonTable`).
 *
 * Scope: the widget is a pure presentation component that receives a
 * `readonly ResultItem[]` and renders two side-by-side wine panels with an
 * attribute comparison table. Upstream owners (`SearchResultsView`) handle
 * loading/empty/error envelopes; for THIS widget the relevant fallback
 * behaviour is rendering nothing when the input contains fewer than two
 * wines.
 *
 * Mocks: `@/shared/api` is mocked at the boundary even though the widget is
 * a pure render — this keeps the test future-proof if a comparison fetcher
 * is introduced and prevents accidental network access in test runners.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/__tests__/test-utils';
import { mockComparisonResponse, mockResultItem } from '@/__tests__/fixtures';
import { ComparisonTable } from '../comparison-table';
import type { ResultItem } from '@/shared/api';

// ─── Mocks ───
// Keep the network boundary mocked — the widget itself is presentational,
// but mocking here documents the intended boundary and protects future
// fetch-aware revisions of the widget.
vi.mock('@/shared/api', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api')>('@/shared/api');
  return { ...actual };
});

const KOREAN_WINE_A = '샤또 마고 2018';
const KOREAN_WINE_B = '오퍼스 원 2019';

function makeKoreanItem(label: string, entityId: string): ResultItem {
  return {
    ...mockResultItem,
    entity: {
      ...mockResultItem.entity,
      entity_id: entityId,
      canonical_label: label,
    },
  };
}

describe('ComparisonTable (widget component)', () => {
  // ─── Render with 2 wines: both side panels with canonical labels ───

  it('renders both side panels with canonical labels for two wines', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);

    expect(screen.getByText('Château Margaux 2018')).toBeInTheDocument();
    expect(screen.getByText('Opus One 2019')).toBeInTheDocument();

    // Both panels expose a heading — these are the side panels.
    const headings = screen.getAllByRole('heading', { level: 3 });
    expect(headings).toHaveLength(2);
    expect(headings[0]).toHaveTextContent('Château Margaux 2018');
    expect(headings[1]).toHaveTextContent('Opus One 2019');
  });

  // ─── Empty side (one wine missing) → widget treats it as insufficient data ───

  it('renders nothing when only one wine is provided (empty-side fallback)', () => {
    const { container } = render(
      <ComparisonTable items={[mockComparisonResponse.results[0]!]} />,
    );

    // The widget intentionally renders nothing when a comparison cannot be
    // formed. The parent surface (SearchResultsView) is responsible for the
    // user-visible fallback guidance.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('group', { name: '와인 비교' })).not.toBeInTheDocument();
  });

  // ─── Both sides empty → widget renders nothing (parent shows guidance) ───

  it('renders nothing when no wines are provided (both sides empty)', () => {
    const { container } = render(<ComparisonTable items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  // ─── Korean wine labels: NFC preserved on both sides ───

  it('preserves Korean (NFC) wine labels verbatim on both side panels', () => {
    const items = [
      makeKoreanItem(KOREAN_WINE_A, 'wine:ko-1'),
      makeKoreanItem(KOREAN_WINE_B, 'wine:ko-2'),
    ];
    render(<ComparisonTable items={items} />);

    const left = screen.getByText(KOREAN_WINE_A);
    const right = screen.getByText(KOREAN_WINE_B);

    expect(left).toBeInTheDocument();
    expect(right).toBeInTheDocument();

    // Text must round-trip as canonical NFC — no double-decomposition into
    // jamo (which would produce visually identical but byte-different text).
    expect(left.textContent?.normalize('NFC')).toBe(KOREAN_WINE_A);
    expect(right.textContent?.normalize('NFC')).toBe(KOREAN_WINE_B);
  });

  // ─── Attribute comparison table renders rows on both sides ───

  it('renders the attribute comparison table with all rows on both sides', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);

    // Each side panel contains the same five attribute labels.
    for (const label of ['Region', 'Producer', 'Grapes', 'Vintage', 'Price']) {
      expect(screen.getAllByText(label)).toHaveLength(2);
    }

    // Spot-check the right-hand panel renders the value side of "Region".
    const rightPanel = screen.getByRole('article', { name: 'Opus One 2019' });
    expect(within(rightPanel).getByText('Napa Valley')).toBeInTheDocument();
    // And the left-hand panel renders its own region (no cross-contamination).
    const leftPanel = screen.getByRole('article', { name: 'Château Margaux 2018' });
    expect(within(leftPanel).getByText('Margaux, Bordeaux')).toBeInTheDocument();
  });

  // ─── VS divider sits between the two side panels ───

  it('renders the VS divider exactly once between the panels', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);
    expect(screen.getAllByText('VS')).toHaveLength(1);
  });

  // ─── Korean + English mixed: one side Korean, other English ───

  it('renders mixed Korean/English wine labels correctly on each side', () => {
    const items = [
      makeKoreanItem('샤또 마고 2018', 'wine:mix-1'),
      mockComparisonResponse.results[1]!, // Opus One 2019 (English)
    ];
    render(<ComparisonTable items={items} />);

    expect(screen.getByText('샤또 마고 2018')).toBeInTheDocument();
    expect(screen.getByText('Opus One 2019')).toBeInTheDocument();

    // Both panels are siblings of the same comparison group — verifies
    // mixed-language rendering does not collapse a panel.
    const group = screen.getByRole('group', { name: '와인 비교' });
    expect(within(group).getAllByRole('heading', { level: 3 })).toHaveLength(2);
  });

  // ─── Accessibility: group exposes a non-empty aria-label ───

  it('exposes an accessible group label for the comparison region', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);
    const group = screen.getByRole('group');
    expect(group).toHaveAttribute('aria-label');
    expect(group.getAttribute('aria-label')?.trim()).not.toBe('');
  });

  // ─── Accessibility: each side panel exposes its wine label via aria-label ───

  it('exposes per-side aria-labels naming each wine on its panel', () => {
    render(<ComparisonTable items={mockComparisonResponse.results} />);

    // Each side panel is an `article` (or otherwise role-bearing region) whose
    // accessible name is the wine canonical label. Screen-reader users must
    // be able to identify which wine each panel describes without first
    // navigating into the heading.
    expect(
      screen.getByRole('article', { name: 'Château Margaux 2018' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('article', { name: 'Opus One 2019' }),
    ).toBeInTheDocument();
  });

  // ─── Adjacent regression: missing optional fields (no grapes / vintage) ───

  it('renders em-dash placeholders for wines missing optional attributes', () => {
    const sparse = [
      mockComparisonResponse.results[0]!,
      {
        ...mockComparisonResponse.results[1]!,
        entity: {
          ...mockComparisonResponse.results[1]!.entity,
          grapes: undefined,
          vintage: undefined,
          producer: undefined,
        },
      },
    ];
    render(<ComparisonTable items={sparse} />);

    // The sparse panel must still mount (no crash) and at least one em-dash
    // placeholder must appear for the missing attributes.
    expect(screen.getByText('Opus One 2019')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  // ─── Adjacent regression: keyboard tab order traverses both side panels ───

  it('allows keyboard navigation from left panel content to right panel content', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button" data-testid="before">before</button>
        <ComparisonTable items={mockComparisonResponse.results} />
        <button type="button" data-testid="after">after</button>
      </>,
    );

    const before = screen.getByTestId('before');
    const after = screen.getByTestId('after');

    before.focus();
    expect(before).toHaveFocus();

    // Tabbing from the boundary button must eventually reach the trailing
    // boundary button — i.e. the widget does not capture focus or block
    // sequential keyboard traversal across the two side panels.
    for (let i = 0; i < 20 && document.activeElement !== after; i++) {
      await user.tab();
    }
    expect(after).toHaveFocus();
  });
});
