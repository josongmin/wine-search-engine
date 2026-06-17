import { describe, expect, it } from 'vitest';
import { loadLookupV2BenchmarkGoldHintMapSync } from '../../../scripts/eval/lookup-v2-benchmark-gold-map.js';

describe('lookup-v2-benchmark-gold-map', () => {
  it('loads deterministic unique hint -> entity id mappings from benchmark fixtures', () => {
    const map = loadLookupV2BenchmarkGoldHintMapSync();

    expect(map.get('mouton')).toBe('wine-ce-7ad85be72e30da173b87702175d8423ebfad6b8834d0b6ff794d2d4a62573e0e');
    expect(map.get('lafite')).toBe('wine-ce-88beecab1fcf1424530a384948a89306ae130a95ee37c511e07058e5389b657c');
    expect(map.get('haut brion')).toBe('wine-ce-1d48690df3a585bf2f31f6c7395fabeafd34aad9c07e582dd99bff79a32ac0f7');
    expect(map.get('grange')).toBe('wine-ce-ae3675d0f1a45cc578ba15452d8b0a4af984beaaa20087665e714fd72c03e344');
  });

  it('keys the map by normalized hint form', () => {
    const map = loadLookupV2BenchmarkGoldHintMapSync();

    expect(map.get('Latour')).toBeUndefined();
    expect(map.get('chateau latour')).toBe('wine-ce-ecff2ce36910240d9c0a7b46dfbe578fcf4fffd2d995ab9d2fc3c3ef06ec8f96');
  });
});
