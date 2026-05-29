import { describe, it, expect } from 'vitest';
import {
  SearchUseCase,
  BatchSearchUseCase,
} from '../../../../src/application/search/index.js';

describe('application/search barrel', () => {
  it('exports primary use case classes', () => {
    expect(typeof SearchUseCase).toBe('function');
    expect(typeof BatchSearchUseCase).toBe('function');
  });
});
