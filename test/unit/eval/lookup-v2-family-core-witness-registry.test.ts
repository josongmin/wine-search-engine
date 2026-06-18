import { describe, expect, it } from 'vitest';
import {
  assertLookupV2FamilyCoreWitnessRegistryRowsValid,
  buildLookupV2FamilyCoreWitnessRegistryMap,
} from '../../../scripts/eval/lookup-v2-family-core-witness-registry.js';

describe('lookup-v2-family-core-witness-registry', () => {
  it('allows multiple reviewed rows for the same normalized surface across different entities', () => {
    const rows = [
      {
        surface: 'beaucastel',
        normalizedSurface: 'beaucastel',
        entityId: 'wine-a',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T21:35:00.000Z',
        decisionReason: 'family collision witness',
        evidenceClass: 'family_core_witness_review',
      },
      {
        surface: 'beaucastel',
        normalizedSurface: 'beaucastel',
        entityId: 'wine-b',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T21:35:00.000Z',
        decisionReason: 'family collision witness',
        evidenceClass: 'family_core_witness_review',
      },
    ] as const;

    assertLookupV2FamilyCoreWitnessRegistryRowsValid({
      rows,
      knownEntityIds: new Set(['wine-a', 'wine-b']),
    });

    expect(buildLookupV2FamilyCoreWitnessRegistryMap(rows).get('beaucastel')).toEqual(rows);
  });

  it('fails closed on duplicate normalizedSurface/entityId pairs', () => {
    expect(() =>
      assertLookupV2FamilyCoreWitnessRegistryRowsValid({
        rows: [
          {
            surface: 'beaucastel',
            normalizedSurface: 'beaucastel',
            entityId: 'wine-a',
            reviewedBy: 'codex',
            reviewedAt: '2026-06-06T21:35:00.000Z',
            decisionReason: 'family witness',
            evidenceClass: 'family_core_witness_review',
          },
          {
            surface: 'Beaucastel',
            normalizedSurface: 'beaucastel',
            entityId: 'wine-a',
            reviewedBy: 'codex',
            reviewedAt: '2026-06-06T21:35:00.000Z',
            decisionReason: 'duplicate family witness',
            evidenceClass: 'family_core_witness_review',
          },
        ],
        knownEntityIds: new Set(['wine-a']),
      }),
    ).toThrow(/duplicate normalizedSurface\/entityId/i);
  });
});
