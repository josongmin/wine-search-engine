import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/__tests__/test-utils';
import { ConstraintTags } from '../constraint-tags';

describe('ConstraintTags', () => {
  it('renders matched constraints with checkmark', () => {
    render(
      <ConstraintTags constraints={{ matched: ['red wine'], unmet: [], inferred: [] }} />,
    );
    expect(screen.getByText('✓ red wine')).toBeInTheDocument();
  });

  it('renders unmet constraints with cross', () => {
    render(
      <ConstraintTags constraints={{ matched: [], unmet: ['price under 50'], inferred: [] }} />,
    );
    expect(screen.getByText('✗ price under 50')).toBeInTheDocument();
  });

  it('renders inferred constraints with tilde', () => {
    render(
      <ConstraintTags constraints={{ matched: [], unmet: [], inferred: ['premium'] }} />,
    );
    expect(screen.getByText('~ premium')).toBeInTheDocument();
  });

  it('renders all types together', () => {
    render(
      <ConstraintTags
        constraints={{
          matched: ['red'],
          unmet: ['cheap'],
          inferred: ['bold'],
        }}
      />,
    );
    expect(screen.getByText('✓ red')).toBeInTheDocument();
    expect(screen.getByText('✗ cheap')).toBeInTheDocument();
    expect(screen.getByText('~ bold')).toBeInTheDocument();
  });
});
