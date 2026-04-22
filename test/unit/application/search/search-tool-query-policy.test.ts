import { describe, expect, it } from 'vitest';
import { buildSearchToolSoftClauses } from '../../../../src/application/search/search-tool-query-policy.js';

describe('buildSearchToolSoftClauses', () => {
  it('does not lexicalize unsupported cellaring soft semantics back into the query text', () => {
    const clauses = buildSearchToolSoftClauses({
      styles: ['ageworthy', 'cellaring', 'cellarworthy'],
      occasion: ['cellaring'],
    });

    expect(clauses).toEqual([]);
  });
});
