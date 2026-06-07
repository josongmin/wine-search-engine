import { describe, expect, it } from 'vitest';
import {
  assertLookupV2LocalizedSurfaceRegistryRowsValid,
  buildLookupV2ApprovedLocalizedSurfacesByLatinSurfaceMap,
  buildLookupV2LocalizedSurfaceRegistryMap,
  buildLookupV2LocalizedSurfaceRegistryKey,
} from '../../../scripts/archive/lookup-v2-localized-surface-registry.js';

describe('lookup-v2-localized-surface-registry', () => {
  it('accepts approved localized family rows and indexes both local and latin lookups', () => {
    const rows = [
      {
        localSurface: '실버오크',
        normalizedLocalSurface: '실버오크',
        locale: 'ko',
        latinSurface: 'silver oak',
        surfaceClass: 'family',
        decisionStatus: 'approved',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-07T03:15:00.000Z',
        decisionReason: 'localized review',
        evidenceClass: 'localized_surface_review',
      },
      {
        localSurface: '샤또 피숑 라랑드',
        normalizedLocalSurface: '샤또 피숑 라랑드',
        locale: 'ko',
        latinSurface: 'pichon lalande',
        surfaceClass: 'family',
        decisionStatus: 'approved',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-07T03:15:00.000Z',
        decisionReason: 'localized review',
        evidenceClass: 'localized_surface_review',
      },
    ] as const;

    expect(() => assertLookupV2LocalizedSurfaceRegistryRowsValid({ rows })).not.toThrow();
    expect(
      buildLookupV2LocalizedSurfaceRegistryMap(rows).get(
        buildLookupV2LocalizedSurfaceRegistryKey({
          normalizedLocalSurface: '실버오크',
          locale: 'ko',
        }),
      ),
    ).toEqual(rows[0]);
    expect(
      buildLookupV2ApprovedLocalizedSurfacesByLatinSurfaceMap(rows).get('silver oak'),
    ).toEqual([rows[0]]);
  });

  it('fails closed on duplicate localized surface keys', () => {
    expect(() =>
      assertLookupV2LocalizedSurfaceRegistryRowsValid({
        rows: [
          {
            localSurface: '마세토',
            normalizedLocalSurface: '마세토',
            locale: 'ko',
            latinSurface: 'masseto',
            surfaceClass: 'family',
            decisionStatus: 'approved',
            reviewedBy: 'codex',
            reviewedAt: '2026-06-07T03:15:00.000Z',
            decisionReason: 'localized review',
            evidenceClass: 'localized_surface_review',
          },
          {
            localSurface: '마세토',
            normalizedLocalSurface: '마세토',
            locale: 'ko',
            latinSurface: 'masseto',
            surfaceClass: 'family',
            decisionStatus: 'approved',
            reviewedBy: 'codex',
            reviewedAt: '2026-06-07T03:15:00.000Z',
            decisionReason: 'duplicate',
            evidenceClass: 'localized_surface_review',
          },
        ],
      }),
    ).toThrow(/duplicate localized surface key/i);
  });
});
