/**
 * Regression: Multi-Query retrieval fan-out invariants.
 *
 * Locks:
 *  - Given query + N rewrites + optional HyDE → emits a deduplicated
 *    semantic-query list.
 *  - Total list is capped at MULTI_QUERY_FANOUT_MAX_QUERIES = 5.
 *  - HyDE null/undefined → returns just query + rewrites (no spurious
 *    entries).
 *  - Original query is always first (when non-empty).
 *  - mergeFanoutWithExisting preserves planner-supplied extras.
 *
 * Append-only per CLAUDE.md regression-test discipline.
 */
import { describe, expect, it } from 'vitest';

import {
  expandSemanticQueriesForFanout,
  mergeFanoutWithExisting,
  MULTI_QUERY_FANOUT_MAX_QUERIES,
} from '../../src/application/search/multi-query-retrieval-fanout.js';

describe('multi-query-retrieval-fanout', () => {
  it('emits original + rewrites + HyDE deduped', () => {
    const result = expandSemanticQueriesForFanout({
      query: 'red wine with steak',
      rewrites: ['steak-pairing red wine', 'tannic red for grilled beef'],
      hydeDocument:
        'A bold Cabernet Sauvignon with firm tannins, blackcurrant, and cedar notes — ideal companion for grilled red meats.',
    });
    expect(result.semanticQueries[0]).toBe('red wine with steak');
    expect(result.semanticQueries).toHaveLength(4);
    expect(result.capped).toBe(false);
  });

  it('caps the total at MULTI_QUERY_FANOUT_MAX_QUERIES', () => {
    const result = expandSemanticQueriesForFanout({
      query: 'q0',
      rewrites: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
      hydeDocument: 'hyde document content',
    });
    expect(result.semanticQueries.length).toBe(MULTI_QUERY_FANOUT_MAX_QUERIES);
    expect(result.semanticQueries[0]).toBe('q0');
    expect(result.capped).toBe(true);
  });

  it('HyDE null → returns just query + rewrites', () => {
    const result = expandSemanticQueriesForFanout({
      query: 'fruity red',
      rewrites: ['juicy easy-drinking red', 'plum-driven Pinot Noir'],
      hydeDocument: null,
    });
    expect(result.semanticQueries).toEqual([
      'fruity red',
      'juicy easy-drinking red',
      'plum-driven Pinot Noir',
    ]);
    expect(result.capped).toBe(false);
  });

  it('HyDE undefined → identical to null behavior', () => {
    const result = expandSemanticQueriesForFanout({
      query: 'fruity red',
      rewrites: ['juicy red'],
    });
    expect(result.semanticQueries).toEqual(['fruity red', 'juicy red']);
  });

  it('dedupes case-insensitively across all inputs', () => {
    const result = expandSemanticQueriesForFanout({
      query: 'Crisp White Wine',
      rewrites: ['crisp white wine', 'CRISP WHITE WINE', 'mineral Riesling'],
      hydeDocument:
        'A bright, mineral-driven Riesling with green apple, lemon zest, and chalky finish.',
    });
    // Original wins for the duplicated key — only 3 entries total
    // (original, mineral Riesling, HyDE).
    expect(result.semanticQueries[0]).toBe('Crisp White Wine');
    expect(result.semanticQueries).toHaveLength(3);
  });

  it('drops whitespace-only rewrites silently', () => {
    const result = expandSemanticQueriesForFanout({
      query: 'red wine',
      rewrites: ['   ', '', 'genuine variant'],
    });
    expect(result.semanticQueries).toEqual(['red wine', 'genuine variant']);
  });

  it('empty query produces empty list (when no other inputs valid)', () => {
    const result = expandSemanticQueriesForFanout({
      query: '   ',
      rewrites: [],
    });
    expect(result.semanticQueries).toEqual([]);
  });

  it('empty query + rewrites yields just the rewrites', () => {
    const result = expandSemanticQueriesForFanout({
      query: '',
      rewrites: ['solo rewrite'],
    });
    expect(result.semanticQueries).toEqual(['solo rewrite']);
  });

  describe('mergeFanoutWithExisting', () => {
    it('preserves planner extras after fanout entries', () => {
      const merged = mergeFanoutWithExisting(
        ['red wine', 'tannic red'],
        ['Cabernet Sauvignon', 'Bordeaux'],
      );
      expect(merged).toEqual(['red wine', 'tannic red', 'Cabernet Sauvignon', 'Bordeaux']);
    });

    it('dedupes when fanout and existing overlap (case-insensitive)', () => {
      const merged = mergeFanoutWithExisting(
        ['Cabernet Sauvignon'],
        ['cabernet sauvignon', 'Bordeaux'],
      );
      expect(merged).toEqual(['Cabernet Sauvignon', 'Bordeaux']);
    });

    it('returns a fresh array (no mutation)', () => {
      const fanout = ['a'];
      const existing = ['b'];
      const merged = mergeFanoutWithExisting(fanout, existing);
      expect(merged).not.toBe(fanout);
      expect(merged).not.toBe(existing);
      expect(fanout).toEqual(['a']);
      expect(existing).toEqual(['b']);
    });

    it('drops empty/whitespace strings on the way through', () => {
      const merged = mergeFanoutWithExisting(['a', '  ', 'b'], ['', 'c']);
      expect(merged).toEqual(['a', 'b', 'c']);
    });
  });
});
