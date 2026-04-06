import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/__tests__/test-utils';
import { DrinkingWindowBar } from '../drinking-window-bar';

describe('DrinkingWindowBar', () => {
  it('shows "지금 마시기 좋은 시기" when currently drinkable', () => {
    render(
      <DrinkingWindowBar
        window={{
          drinking_window_start: 2020,
          drinking_window_end: 2040,
          currently_drinkable: true,
          confidence: 'high',
        }}
      />,
    );
    expect(screen.getByText('지금 마시기 좋은 시기')).toBeInTheDocument();
  });

  it('shows "숙성 대기" when not currently drinkable', () => {
    render(
      <DrinkingWindowBar
        window={{
          drinking_window_start: 2030,
          drinking_window_end: 2050,
          currently_drinkable: false,
          confidence: 'medium',
        }}
      />,
    );
    expect(screen.getByText('숙성 대기')).toBeInTheDocument();
  });

  it('shows peak year when available', () => {
    render(
      <DrinkingWindowBar
        window={{
          drinking_window_start: 2020,
          drinking_window_end: 2040,
          peak_year: 2030,
          currently_drinkable: true,
          confidence: 'high',
        }}
      />,
    );
    expect(screen.getByText('peak 2030')).toBeInTheDocument();
  });

  it('shows start and end years', () => {
    render(
      <DrinkingWindowBar
        window={{
          drinking_window_start: 2020,
          drinking_window_end: 2040,
          currently_drinkable: true,
          confidence: 'high',
        }}
      />,
    );
    expect(screen.getByText('2020')).toBeInTheDocument();
    expect(screen.getByText('2040')).toBeInTheDocument();
  });
});
