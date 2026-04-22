import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/test-utils';
import { ClarificationCard } from '../clarification-card';
import { mockClarification } from '@/__tests__/fixtures';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

describe('ClarificationCard', () => {
  it('renders similar-result guidance for disambiguation candidates', () => {
    renderWithProviders(<ClarificationCard payload={mockClarification} />);
    expect(screen.getByText('비슷한 검색 결과가 있어요')).toBeInTheDocument();
    expect(
      screen.getByText('입력하신 표현과 가까운 후보입니다. 아래에서 바로 선택할 수 있습니다.'),
    ).toBeInTheDocument();
  });

  it('renders the generic clarification prompt when no candidates are available', () => {
    renderWithProviders(<ClarificationCard payload={{ ...mockClarification, candidates: [] }} />);
    expect(screen.getByText('어떤 걸 찾으시나요?')).toBeInTheDocument();
    expect(screen.getByText('여러 와인이 일치합니다')).toBeInTheDocument();
  });

  it('renders clarification prompt for candidate suggestions', () => {
    renderWithProviders(<ClarificationCard payload={mockClarification} />);
    expect(screen.getByText('비슷한 검색 결과가 있어요')).toBeInTheDocument();
  });

  it('renders all candidates', () => {
    renderWithProviders(<ClarificationCard payload={mockClarification} />);
    expect(screen.getByText('Château Margaux 2018')).toBeInTheDocument();
    expect(screen.getByText('Margaux AOC 와인 전체')).toBeInTheDocument();
  });

  it('renders distinguishing features', () => {
    renderWithProviders(<ClarificationCard payload={mockClarification} />);
    expect(screen.getByText('1er Grand Cru Classé · Bordeaux')).toBeInTheDocument();
  });

  it('navigates on candidate click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ClarificationCard payload={mockClarification} />);

    await user.click(screen.getByText('Château Margaux 2018'));
    expect(pushMock).toHaveBeenCalledWith(
      expect.stringContaining('/wine/'),
    );
  });
});
