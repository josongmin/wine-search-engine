import { describe, expect, it } from 'vitest';
import {
  buildLookupV2FamilyTargetApprovedMap,
  assertLookupV2FamilyTargetRegistryRowsValid,
  loadLookupV2FamilyTargetRegistrySync,
} from '../../../scripts/eval/lookup-v2-family-target-registry.js';

describe('lookup-v2-family-target-registry', () => {
  it('loads the reviewed family target registry deterministically', () => {
    const rows = loadLookupV2FamilyTargetRegistrySync(new URL(
      '../../../data/lookup-v2/lookup-family-target-registry-v1.jsonl',
      import.meta.url,
    ).pathname, new Set(['wine-ce-156223aa9aac66ffa459cb8d7485445a919c310eee6b6b7eeda9477663175ab5']));

    expect(rows).toEqual([
      {
        benchmarkGoldHint: 'petrus',
        normalizedBenchmarkGoldHint: 'petrus',
        entityId: 'wine-ce-156223aa9aac66ffa459cb8d7485445a919c310eee6b6b7eeda9477663175ab5',
        decisionStatus: 'approved',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'fixture exact gold provides a unique reviewed target for the petrus family hint',
        evidenceClass: 'fixture_exact',
      },
    ]);
  });

  it('builds an approved target map keyed by normalized benchmark hint', () => {
    const map = buildLookupV2FamilyTargetApprovedMap([
      {
        benchmarkGoldHint: 'petrus',
        normalizedBenchmarkGoldHint: 'petrus',
        entityId: 'wine-ce-petrus',
        decisionStatus: 'approved',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'fixture exact',
        evidenceClass: 'fixture_exact',
      },
      {
        benchmarkGoldHint: 'salon',
        normalizedBenchmarkGoldHint: 'salon',
        decisionStatus: 'rejected',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'no safe single target',
        evidenceClass: 'manual_target_family_review',
      },
    ]);

    expect(map.size).toBe(1);
    expect(map.get('petrus')?.entityId).toBe('wine-ce-petrus');
    expect(map.has('salon')).toBe(false);
  });

  it('fails closed on duplicate normalized hints and unknown entity ids', () => {
    expect(() => assertLookupV2FamilyTargetRegistryRowsValid({
      rows: [
        {
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          entityId: 'wine-ce-a',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'a',
          evidenceClass: 'fixture_exact',
        },
        {
          benchmarkGoldHint: 'Petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          entityId: 'wine-ce-b',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'b',
          evidenceClass: 'fixture_exact',
        },
      ],
      knownEntityIds: new Set(['wine-ce-a', 'wine-ce-b']),
    })).toThrow(/duplicate normalizedBenchmarkGoldHint/);

    expect(() => assertLookupV2FamilyTargetRegistryRowsValid({
      rows: [
        {
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          entityId: 'wine-ce-missing',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'a',
          evidenceClass: 'fixture_exact',
        },
      ],
      knownEntityIds: new Set(['wine-ce-a']),
    })).toThrow(/unknown entityId/);
  });
});
