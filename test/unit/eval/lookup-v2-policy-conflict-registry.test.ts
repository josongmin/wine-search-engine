import { describe, expect, it } from 'vitest';
import {
  buildLookupPolicyConflictBenchmarkHintOwnerMap,
  buildLookupPolicyConflictBenchmarkHintSet,
  loadLookupPolicyConflictRegistrySync,
} from '../../../scripts/eval/lookup-v2-policy-conflict-registry.js';

describe('lookup-v2-policy-conflict-registry', () => {
  it('loads the reviewed stretch policy-conflict surfaces deterministically', () => {
    const rows = loadLookupPolicyConflictRegistrySync();

    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.surface)).toEqual([
      '라뚜르',
      '그랜지',
      '베가 시실리아',
      '자코모 콘테르노',
      '라피트',
      '무통',
    ]);
    expect(rows.every((row) => row.stretchExpectedStatus === 'ambiguous')).toBe(true);
    expect(rows.every((row) => row.authorityStatus === 'resolved')).toBe(true);
    expect(rows.every((row) => row.authorityEntityId.length > 0)).toBe(true);
    expect(rows.find((row) => row.surface === '라뚜르')?.conflictBenchmarkHints).toEqual(['latour']);
    expect(rows.find((row) => row.surface === '무통')?.conflictBenchmarkHints).toEqual(['mouton']);
    expect(rows.find((row) => row.surface === '베가 시실리아')?.authorityEntityId).toBe('wine-ce-0cf11be6a33dbbc907d31b65c3378baa13f3b51d3dd12bf894a28f61370e8581');
  });

  it('builds deterministic normalized benchmark-hint lookup structures', () => {
    const rows = loadLookupPolicyConflictRegistrySync();
    const hintSet = buildLookupPolicyConflictBenchmarkHintSet(rows);
    const ownerMap = buildLookupPolicyConflictBenchmarkHintOwnerMap(rows);

    expect(hintSet.has('latour')).toBe(true);
    expect(hintSet.has('mouton')).toBe(true);
    expect(ownerMap.get('latour')?.surface).toBe('라뚜르');
    expect(ownerMap.get('mouton')?.surface).toBe('무통');
  });
});
