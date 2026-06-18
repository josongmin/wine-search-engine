import { describe, expect, it } from 'vitest';
import {
  assertLookupExactSafeRegistryVintageConsistency,
  collectLookupExactSafeRegistryVintageIssues,
  pruneLookupExactSafeRegistryRowsByVintageConsistency,
  type LookupExactSafeRegistryRow,
} from '../../../scripts/etl/lookup-exact-safe-registry.js';

function makeRow(surface: string, entityId: string): LookupExactSafeRegistryRow {
  return {
    surface,
    entityId,
    promotionClass: 'exact_safe',
    locale: 'ko',
    sourceEvidence: 'test row',
    reviewedAt: '2026-06-08T00:00:00.000Z',
  };
}

describe('lookup exact-safe registry vintage consistency', () => {
  it('accepts a two-digit vintage surface when it matches the snapshot entity vintage', () => {
    expect(() => assertLookupExactSafeRegistryVintageConsistency({
      rows: [makeRow('라뚜르 09', 'latour-2009')],
      entityVintagesById: new Map([
        ['latour-2009', [2009]],
      ]),
    })).not.toThrow();
  });

  it('rejects a vintage-bearing surface when the snapshot entity vintage differs', () => {
    expect(() => assertLookupExactSafeRegistryVintageConsistency({
      rows: [makeRow('라뚜르 2009', 'latour-1996')],
      entityVintagesById: new Map([
        ['latour-1996', [1996]],
      ]),
    })).toThrow(/lookup exact-safe registry vintage mismatch.*라뚜르 2009/u);
  });

  it('collects only rows whose surface vintage conflicts with snapshot vintages', () => {
    expect(collectLookupExactSafeRegistryVintageIssues({
      rows: [
        makeRow('라뚜르', 'latour-1996'),
        makeRow('라뚜르 1996', 'latour-1996'),
        makeRow('라뚜르 2009', 'latour-1996'),
      ],
      entityVintagesById: new Map([
        ['latour-1996', [1996]],
      ]),
    })).toEqual([
      expect.objectContaining({
        row: expect.objectContaining({ surface: '라뚜르 2009', entityId: 'latour-1996' }),
        surfaceVintage: 2009,
        entityVintages: [1996],
        reason: 'entity_vintage_mismatch',
      }),
    ]);
  });

  it('prunes only the vintage-inconsistent rows and preserves non-vintage family aliases', () => {
    const result = pruneLookupExactSafeRegistryRowsByVintageConsistency({
      rows: [
        makeRow('라뚜르', 'latour-1996'),
        makeRow('라뚜르 1996', 'latour-1996'),
        makeRow('라뚜르 2009', 'latour-1996'),
      ],
      entityVintagesById: new Map([
        ['latour-1996', [1996]],
      ]),
    });

    expect(result.keptRows).toEqual([
      expect.objectContaining({ surface: '라뚜르', entityId: 'latour-1996' }),
      expect.objectContaining({ surface: '라뚜르 1996', entityId: 'latour-1996' }),
    ]);
    expect(result.removedIssues).toEqual([
      expect.objectContaining({
        row: expect.objectContaining({ surface: '라뚜르 2009', entityId: 'latour-1996' }),
      }),
    ]);
  });
});
