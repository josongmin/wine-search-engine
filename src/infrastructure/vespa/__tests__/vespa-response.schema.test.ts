/**
 * Unit tests for Vespa query response runtime validation schemas.
 *
 * Covers the P1 bug identified in Epic 06 / T06-1: the previous
 * `as unknown as VespaQueryResponse` cast silently accepted hits that
 * were missing the `source` field, producing downstream `undefined`
 * corruption in the ranker. These tests pin the contract.
 */

import { describe, expect, it } from 'vitest';
import {
  VespaHitSchema,
  VespaQueryResponseSchema,
} from '../vespa-response.schema.js';

describe('VespaQueryResponseSchema', () => {
  it('accepts a well-formed query response with children', () => {
    const input = {
      root: {
        id: 'toplevel',
        relevance: 1,
        fields: { totalCount: 2 },
        coverage: {
          coverage: 100,
          documents: 1234,
          full: true,
          nodes: 2,
          results: 2,
          resultsFull: 2,
        },
        children: [
          {
            id: 'index:content/0/abc',
            relevance: 0.873,
            source: 'content',
            fields: { entity_id: 'wine-123', canonical_label: 'Barolo 2015' },
          },
          {
            id: 'index:content/0/def',
            relevance: 0.42,
            source: 'content',
            fields: { entity_id: 'wine-456' },
          },
        ],
      },
      timing: { querytime: 0.012, summaryfetchtime: 0.003, searchtime: 0.015 },
    };

    const result = VespaQueryResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts a response with empty children array', () => {
    const input = {
      root: {
        id: 'toplevel',
        relevance: 1,
        fields: { totalCount: 0 },
        children: [],
      },
    };
    const result = VespaQueryResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.root.children).toEqual([]);
    }
  });

  it('accepts a response with no children key at all', () => {
    const input = { root: { id: 'toplevel', relevance: 1 } };
    const result = VespaQueryResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects a response missing the root field', () => {
    const input = { timing: { querytime: 0.012 } };
    const result = VespaQueryResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('root');
    }
  });

  it('rejects a hit missing the `source` field (P1 bug pin)', () => {
    const input = {
      root: {
        id: 'toplevel',
        relevance: 1,
        children: [
          {
            id: 'index:content/0/abc',
            relevance: 0.5,
            // source intentionally missing — this is the audited P1 gap
            fields: { entity_id: 'wine-123' },
          },
        ],
      },
    };
    const result = VespaQueryResponseSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.endsWith('source'))).toBe(true);
    }
  });

  it('passes through unknown metadata fields on coverage (passthrough)', () => {
    const input = {
      root: {
        relevance: 1,
        coverage: {
          coverage: 100,
          documents: 42,
          // Vespa may add fields we do not model; must not reject.
          degraded: { match_phase: false, timeout: false },
          futureField: 'ok',
        },
        children: [],
      },
    };
    const result = VespaQueryResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('passes through unknown metadata fields on a hit (passthrough)', () => {
    const input = {
      id: 'index:content/0/abc',
      relevance: 0.5,
      source: 'content',
      fields: { entity_id: 'wine-1' },
      // Vespa may add `types`, `label`, etc. — must not reject.
      types: ['summary'],
      label: 'annotated',
    };
    const result = VespaHitSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects a hit with non-finite relevance (NaN)', () => {
    const input = {
      id: 'index:content/0/abc',
      relevance: Number.NaN,
      source: 'content',
    };
    const result = VespaHitSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a hit with non-finite relevance (Infinity)', () => {
    const input = {
      id: 'index:content/0/abc',
      relevance: Number.POSITIVE_INFINITY,
      source: 'content',
    };
    const result = VespaHitSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
