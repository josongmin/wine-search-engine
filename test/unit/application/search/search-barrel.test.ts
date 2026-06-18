import { describe, it, expect } from 'vitest';
import { SearchUseCase } from '../../../../src/application/search/index.js';

describe('application/search barrel', () => {
  it('exports production SearchUseCase only (eval rails use build-* factories)', () => {
    expect(typeof SearchUseCase).toBe('function');
  });
});
