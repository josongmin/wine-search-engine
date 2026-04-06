import { describe, it, expect } from 'vitest';
import { levenshteinDistance, BKTree } from '../bk-tree.js';

describe('levenshteinDistance', () => {
  it('"kitten" → "sitting" = 3', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('identical strings → 0', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0);
  });

  it('empty vs non-empty → length', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });
});

describe('BKTree', () => {
  it('build + search finds terms within distance', () => {
    const tree = new BKTree();
    const terms = ['book', 'back', 'cook', 'look', 'brick'];
    for (const t of terms) {
      tree.insert(t);
    }

    const results = tree.search('bock', 1);
    const found = results.map((r) => r.term).sort();

    // "book" and "back" are each 1 edit away from "bock".
    expect(found).toContain('book');
    expect(found).toContain('back');

    // "brick" is more than 1 edit away.
    expect(found).not.toContain('brick');
  });

  it('empty tree → no results', () => {
    const tree = new BKTree();
    const results = tree.search('hello', 2);
    expect(results).toEqual([]);
  });

  it('exact match has editDistance 0', () => {
    const tree = new BKTree();
    tree.insert('wine');
    const results = tree.search('wine', 1);
    expect(results).toEqual([{ term: 'wine', editDistance: 0 }]);
  });
});
