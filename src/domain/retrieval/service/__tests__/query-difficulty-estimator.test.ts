import { describe, it, expect } from 'vitest';
import {
  estimateQueryDifficulty,
  type DifficultyInput,
} from '../query-difficulty-estimator.js';

function baseInput(overrides: Partial<DifficultyInput> = {}): DifficultyInput {
  return {
    normalizedQuery: 'pinot noir',
    tokenCount: 2,
    hasAnchor: false,
    anchorConfidence: 0,
    hasNumericConstraint: false,
    hasNegation: false,
    ...overrides,
  };
}

describe('query-difficulty-estimator', () => {
  it('high anchor confidence short-circuits to easy', () => {
    const result = estimateQueryDifficulty(
      baseInput({
        normalizedQuery: 'sassicaia 2018',
        tokenCount: 2,
        hasAnchor: true,
        anchorConfidence: 0.95,
      }),
    );
    expect(result.difficulty).toBe('easy');
    expect(result.score).toBe(0);
    expect(result.signals.hasAnchor).toBe(true);
  });

  it('long query with negation → hard', () => {
    const result = estimateQueryDifficulty(
      baseInput({
        normalizedQuery:
          'full bodied red wine not from california under fifty dollars',
        tokenCount: 10,
        hasNegation: true,
      }),
    );
    expect(result.difficulty).toBe('hard');
    expect(result.score).toBe(1);
  });

  it('mixed language without anchor → hard', () => {
    const result = estimateQueryDifficulty(
      baseInput({
        normalizedQuery: '프랑스 bordeaux 추천',
        tokenCount: 3,
        hasAnchor: false,
      }),
    );
    expect(result.difficulty).toBe('hard');
    expect(result.signals.languageMix).toBe('mixed');
  });

  it('empty query → easy', () => {
    const result = estimateQueryDifficulty(
      baseInput({ normalizedQuery: '', tokenCount: 0 }),
    );
    expect(result.difficulty).toBe('easy');
    expect(result.score).toBe(0);
  });

  it('mid-range query → medium', () => {
    const result = estimateQueryDifficulty(
      baseInput({
        normalizedQuery: 'light red wine for dinner',
        tokenCount: 5,
        hasAnchor: false,
      }),
    );
    expect(result.difficulty).toBe('medium');
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
  });

  it('numeric constraint increases score within medium band', () => {
    const withoutNumeric = estimateQueryDifficulty(
      baseInput({
        normalizedQuery: 'red wine for dinner tonight',
        tokenCount: 5,
        hasNumericConstraint: false,
      }),
    );
    const withNumeric = estimateQueryDifficulty(
      baseInput({
        normalizedQuery: 'red wine for dinner tonight',
        tokenCount: 5,
        hasNumericConstraint: true,
      }),
    );
    expect(withoutNumeric.difficulty).toBe('medium');
    expect(withNumeric.difficulty).toBe('medium');
    expect(withNumeric.score).toBeGreaterThan(withoutNumeric.score);
    expect(withNumeric.signals.hasNumericConstraint).toBe(true);
  });
});
