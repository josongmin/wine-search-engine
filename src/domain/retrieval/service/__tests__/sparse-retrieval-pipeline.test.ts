import { describe, expect, it, vi } from 'vitest';
import {
  annotateAndApplyHardFilters,
  resolveHardForFilter,
  searchAndDedupSparse,
  toSparseFilterTokens,
} from '../sparse-retrieval-pipeline.js';
import { ConstraintFilter } from '../constraint-filter.js';
import type { SearchIndexPort, SparseHit } from '../../port/search-index.port.js';
import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../../shared/types/index.js';
import { createEntityId } from '../../../shared/types/entity-id.js';
import type { HybridCandidate } from '../../model/hybrid-candidate.js';
import { sparseHitsToCandidates } from '../sparse-hit-to-candidate.js';

const emptyConstraints: ConstraintBundle = { hard: [], soft: [], inferred: [] };

function makeHit(id: string, rank: number): SparseHit {
  return {
    entityId: createEntityId(id),
    score: 10 - rank,
    rank,
    matchedFields: ['producer'],
    summary: {
      canonicalLabel: `Wine ${id}`,
      producer: 'Test Producer',
      region: 'Napa',
      style: 'bold red',
      priceBand: 'premium',
      wineType: 'red',
    },
  };
}

function makeClient(hits: readonly SparseHit[]): SearchIndexPort {
  return {
    sparseSearch: vi.fn().mockResolvedValue([...hits]),
    denseSearch: vi.fn().mockResolvedValue([]),
    getDocument: vi.fn().mockResolvedValue(null),
    upsertDocument: vi.fn().mockResolvedValue(undefined),
    bulkUpsert: vi.fn().mockResolvedValue(undefined),
  };
}

describe('sparse-retrieval-pipeline helpers', () => {
  describe('resolveHardForFilter', () => {
    it('returns constraints.hard untouched when graph is undefined', () => {
      const hard: NormalizedConstraint[] = [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 0.9,
        },
      ];
      const bundle: ConstraintBundle = { hard, soft: [], inferred: [] };
      const out = resolveHardForFilter(bundle, undefined);
      expect(out).toBe(hard); // identity — no defensive copy
    });

    it('prefers graph-derived hard constraints when graph is supplied', () => {
      const bundle: ConstraintBundle = {
        hard: [
          {
            attribute: 'wine_type',
            operator: '=',
            value: 'red',
            source_phrase: 'red',
            confidence: 0.9,
          },
        ],
        soft: [],
        inferred: [],
      };
      // An empty graph yields no hard tier constraints; this is enough to
      // verify the branch is taken (return value is NOT bundle.hard).
      const graph = { nodes: [], edges: [] } as never;
      const out = resolveHardForFilter(bundle, graph);
      expect(out).not.toBe(bundle.hard);
      expect(out).toEqual([]);
    });
  });

  describe('toSparseFilterTokens', () => {
    it('returns an empty array for no constraints', () => {
      expect(toSparseFilterTokens([])).toEqual([]);
    });

    it('maps a wine_type equality constraint to a filter token', () => {
      const tokens = toSparseFilterTokens([
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 1,
        },
      ]);
      expect(tokens).toEqual(['wine_type:red']);
    });

    it('returns a fresh array (caller-safe to extend)', () => {
      const tokens = toSparseFilterTokens([]) as string[];
      expect(() => tokens.push('foo')).not.toThrow();
    });
  });

  describe('searchAndDedupSparse', () => {
    it('passes undefined filters when the filter array is empty', async () => {
      const client = makeClient([makeHit('w-1', 1)]);
      await searchAndDedupSparse({
        client,
        queries: ['Opus One'],
        filters: [],
        fetchLimit: 50,
      });
      expect(client.sparseSearch).toHaveBeenCalledWith(['Opus One'], undefined, 50);
    });

    it('passes the filter array through when non-empty', async () => {
      const client = makeClient([makeHit('w-1', 1)]);
      await searchAndDedupSparse({
        client,
        queries: ['Opus One'],
        filters: ['wine_type:red'],
        fetchLimit: 50,
      });
      expect(client.sparseSearch).toHaveBeenCalledWith(
        ['Opus One'],
        ['wine_type:red'],
        50,
      );
    });

    it('dedupes hits by canonical entityId, keeping the first occurrence', async () => {
      const client = makeClient([
        makeHit('w-1', 1),
        makeHit('w-2', 2),
        makeHit('w-1', 3), // duplicate
      ]);
      const out = await searchAndDedupSparse({
        client,
        queries: ['q'],
        filters: [],
        fetchLimit: 10,
      });
      const ids = out.map((h) => h.entityId);
      expect(ids).toEqual([createEntityId('w-1'), createEntityId('w-2')]);
    });
  });

  describe('annotateAndApplyHardFilters', () => {
    it('annotates matched constraints and applies hard-filter rejection', () => {
      const candidates: readonly HybridCandidate[] = sparseHitsToCandidates(
        [makeHit('w-1', 1)],
        {
          retrievalProfile: 'producer_browse',
          lexicalQueries: ['q'],
          filtersApplied: ['wine_type:red'],
          candidateSources: ['sparse_bm25', 'browse_producer'],
        },
      );
      const constraints: ConstraintBundle = {
        hard: [
          {
            attribute: 'wine_type',
            operator: '=',
            value: 'red',
            source_phrase: 'red',
            confidence: 1,
          },
        ],
        soft: [],
        inferred: [],
      };
      const out = annotateAndApplyHardFilters({
        candidates,
        constraints,
        graph: undefined,
        constraintFilter: new ConstraintFilter(),
        hardForFilter: constraints.hard,
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.matchedConstraints).toContain('wine_type');
    });

    it('passes candidates through unchanged when there are no hard constraints', () => {
      const candidates = sparseHitsToCandidates([makeHit('w-1', 1)], {
        retrievalProfile: 'producer_browse',
        lexicalQueries: ['q'],
        filtersApplied: [],
        candidateSources: ['sparse_bm25', 'browse_producer'],
      });
      const out = annotateAndApplyHardFilters({
        candidates,
        constraints: emptyConstraints,
        graph: undefined,
        constraintFilter: new ConstraintFilter(),
        hardForFilter: [],
      });
      expect(out).toHaveLength(1);
      expect(out[0]?.entityId).toBe(createEntityId('w-1'));
    });
  });

  describe('purity', () => {
    it('toSparseFilterTokens does not mutate its input', () => {
      const input: NormalizedConstraint[] = [
        {
          attribute: 'wine_type',
          operator: '=',
          value: 'red',
          source_phrase: 'red',
          confidence: 1,
        },
      ];
      const snapshot = JSON.stringify(input);
      toSparseFilterTokens(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    });

    it('resolveHardForFilter does not mutate its input bundle', () => {
      const bundle: ConstraintBundle = {
        hard: [
          {
            attribute: 'wine_type',
            operator: '=',
            value: 'red',
            source_phrase: 'red',
            confidence: 1,
          },
        ],
        soft: [],
        inferred: [],
      };
      const snapshot = JSON.stringify(bundle);
      resolveHardForFilter(bundle, undefined);
      expect(JSON.stringify(bundle)).toBe(snapshot);
    });
  });
});
