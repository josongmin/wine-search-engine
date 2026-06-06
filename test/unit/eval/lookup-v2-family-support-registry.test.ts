import { describe, expect, it } from 'vitest';
import {
  assertLookupV2FamilySupportRegistryRowsValid,
  buildLookupV2FamilySupportRegistryMap,
} from '../../../scripts/eval/lookup-v2-family-support-registry.js';

describe('lookup-v2-family-support-registry', () => {
  it('accepts reviewed active-catalog-absent rows with deterministic normalized hints', () => {
    const rows = [{
      benchmarkGoldHint: 'Veuve Clicquot',
      normalizedBenchmarkGoldHint: 'veuve clicquot',
      supportStatus: 'vintage_anchor_absent',
      reviewedBy: 'codex',
      reviewedAt: '2026-06-07T00:05:00.000Z',
      decisionReason: 'family owner exists but the requested vintage anchor is absent in active runtime',
      evidenceClass: 'catalog_support_review',
    }] as const;

    expect(() => assertLookupV2FamilySupportRegistryRowsValid({ rows })).not.toThrow();
    expect(buildLookupV2FamilySupportRegistryMap(rows).get('veuve clicquot')).toEqual(rows[0]);
  });

  it('fails closed on duplicate normalized hints', () => {
    expect(() =>
      assertLookupV2FamilySupportRegistryRowsValid({
        rows: [
          {
            benchmarkGoldHint: 'Salon',
            normalizedBenchmarkGoldHint: 'salon',
            supportStatus: 'active_catalog_absent',
            reviewedBy: 'codex',
            reviewedAt: '2026-06-07T00:05:00.000Z',
            decisionReason: 'first row',
            evidenceClass: 'catalog_support_review',
          },
          {
            benchmarkGoldHint: 'salon',
            normalizedBenchmarkGoldHint: 'salon',
            supportStatus: 'active_catalog_absent',
            reviewedBy: 'codex',
            reviewedAt: '2026-06-07T00:05:00.000Z',
            decisionReason: 'duplicate row',
            evidenceClass: 'catalog_support_review',
          },
        ],
      }),
    ).toThrow(/duplicate normalizedBenchmarkGoldHint/i);
  });

  it('accepts secondary-line-only reviewed support rows', () => {
    const rows = [{
      benchmarkGoldHint: 'ausone',
      normalizedBenchmarkGoldHint: 'ausone',
      supportStatus: 'secondary_line_only',
      reviewedBy: 'codex',
      reviewedAt: '2026-06-07T00:05:00.000Z',
      decisionReason: 'active runtime exposes only a side-label family member for this surface',
      evidenceClass: 'catalog_support_review',
    }] as const;

    expect(() => assertLookupV2FamilySupportRegistryRowsValid({ rows })).not.toThrow();
  });
});
