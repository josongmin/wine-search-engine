import { describe, expect, it } from 'vitest';

import type { AmbiguityDictionary } from '../../port/ambiguity-dictionary.port.js';
import {
  FallbackAmbiguityDictionary,
  StaticAmbiguityDictionary,
} from '../static-ambiguity-dictionary.js';

const noAmbiguityDict: AmbiguityDictionary = {
  isKnownAmbiguous: async () => false,
  getAmbiguityInfo: async () => null,
  getAmbiguityInfoBatch: async () => new Map(),
};

describe('StaticAmbiguityDictionary', () => {
  it('marks high-risk Korean broad surfaces as known ambiguous', async () => {
    const dictionary = new StaticAmbiguityDictionary();

    await expect(dictionary.isKnownAmbiguous('펜폴즈')).resolves.toBe(true);
    await expect(dictionary.isKnownAmbiguous('안티노리')).resolves.toBe(true);
    await expect(dictionary.isKnownAmbiguous('토카이')).resolves.toBe(true);
    await expect(dictionary.isKnownAmbiguous('샤블리')).resolves.toBe(true);
  });

  it('returns normalized ambiguity metadata', async () => {
    const dictionary = new StaticAmbiguityDictionary();

    await expect(dictionary.getAmbiguityInfo('  크리스탈 ')).resolves.toEqual({
      types: ['common_noun', 'entity'],
      severity: 'high',
    });
  });
});

describe('FallbackAmbiguityDictionary', () => {
  it('uses static fallback when the primary dictionary misses', async () => {
    const dictionary = new FallbackAmbiguityDictionary(
      noAmbiguityDict,
      new StaticAmbiguityDictionary(),
    );

    await expect(dictionary.isKnownAmbiguous('펜폴즈')).resolves.toBe(true);
    await expect(dictionary.getAmbiguityInfo('펜폴즈')).resolves.toEqual({
      types: ['producer', 'entity'],
      severity: 'high',
    });
  });

  it('preserves primary ambiguity info over fallback defaults', async () => {
    const primary: AmbiguityDictionary = {
      isKnownAmbiguous: async (surface) => surface === '펜폴즈',
      getAmbiguityInfo: async (surface) => (
        surface === '펜폴즈'
          ? { types: ['custom_runtime'], severity: 'medium' }
          : null
      ),
      getAmbiguityInfoBatch: async (surfaces) => {
        const m = new Map<string, { types: string[]; severity: 'low' | 'medium' | 'high' }>();
        for (const s of surfaces) {
          if (s === '펜폴즈') {
            m.set(s, { types: ['custom_runtime'], severity: 'medium' });
          }
        }
        return m;
      },
    };

    const dictionary = new FallbackAmbiguityDictionary(
      primary,
      new StaticAmbiguityDictionary(),
    );

    await expect(dictionary.getAmbiguityInfo('펜폴즈')).resolves.toEqual({
      types: ['custom_runtime'],
      severity: 'medium',
    });
  });
});
