import { describe, expect, it } from 'vitest';
import {
  buildLookupV2PolicyFamilyDecisionKey,
  buildLookupV2PolicyFamilyDecisionMap,
  assertLookupV2PolicyFamilyDecisionRegistryRowsValid,
  loadLookupV2PolicyFamilyDecisionRegistrySync,
} from '../../../scripts/eval/lookup-v2-policy-family-decision-registry.js';

describe('lookup-v2-policy-family-decision-registry', () => {
  it('loads the seeded promote-exact policy family defaults deterministically', () => {
    const rows = loadLookupV2PolicyFamilyDecisionRegistrySync(new URL(
      '../../../data/lookup-v2/lookup-policy-family-decision-registry-v1.jsonl',
      import.meta.url,
    ).pathname, new Set([
      'wine-ce-ecff2ce36910240d9c0a7b46dfbe578fcf4fffd2d995ab9d2fc3c3ef06ec8f96',
      'wine-ce-ae3675d0f1a45cc578ba15452d8b0a4af984beaaa20087665e714fd72c03e344',
      'wine-ce-0cf11be6a33dbbc907d31b65c3378baa13f3b51d3dd12bf894a28f61370e8581',
      'wine-ce-7ad85be72e30da173b87702175d8423ebfad6b8834d0b6ff794d2d4a62573e0e',
    ]));

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.policyConflictSurface)).toEqual(['라뚜르', '그랜지', '베가 시실리아', '무통']);
    expect(rows.every((row) => row.decision === 'promote_exact_safe')).toBe(true);
  });

  it('builds a key-addressable decision map', () => {
    const rows = [
      {
        policyConflictSurface: '라뚜르',
        entityId: 'wine-ce-latour',
        decision: 'promote_exact_safe',
        reviewedBy: 'codex',
        reviewedAt: '2026-06-06T00:00:00.000Z',
        decisionReason: 'seed',
      },
    ] as const;
    const map = buildLookupV2PolicyFamilyDecisionMap(rows);
    expect(map.get(buildLookupV2PolicyFamilyDecisionKey('라뚜르', 'wine-ce-latour'))?.decision).toBe('promote_exact_safe');
  });

  it('fails closed on duplicate keys and unknown entities', () => {
    expect(() => assertLookupV2PolicyFamilyDecisionRegistryRowsValid({
      rows: [
        {
          policyConflictSurface: '라뚜르',
          entityId: 'wine-ce-latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'seed',
        },
        {
          policyConflictSurface: ' 라뚜르 ',
          entityId: 'wine-ce-latour',
          decision: 'keep_policy_conflict',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'seed',
        },
      ],
      knownEntityIds: new Set(['wine-ce-latour']),
    })).toThrow(/duplicate key/);

    expect(() => assertLookupV2PolicyFamilyDecisionRegistryRowsValid({
      rows: [
        {
          policyConflictSurface: '라뚜르',
          entityId: 'wine-ce-missing',
          decision: 'promote_exact_safe',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'seed',
        },
      ],
      knownEntityIds: new Set(['wine-ce-latour']),
    })).toThrow(/unknown entityId/);
  });
});
