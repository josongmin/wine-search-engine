import { describe, it, expect } from 'vitest';
import { NLMapper } from '../service/nl-mapper.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';
import type { NLMapping } from '../model/nl-mapping.js';

// ── Stub MappingTablePort that always returns null ─────────────────────────────
// Forces fallback to built-in mappings.

class NullMappingTablePort implements MappingTablePort {
  async findMapping(_phrase: string, _version?: string): Promise<NLMapping | null> {
    return null;
  }
  async findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return [];
  }
  async getCurrentVersion(): Promise<string> {
    return 'v1.0';
  }
}

// ── Stub that returns custom mappings ──────────────────────────────────────────

class SlowNullMappingTablePort implements MappingTablePort {
  constructor(private readonly delayMs: number) {}

  async findMapping(_phrase: string, _version?: string): Promise<NLMapping | null> {
    await new Promise((resolve) => {
      setTimeout(resolve, this.delayMs);
    });
    return null;
  }
  async findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return [];
  }
  async getCurrentVersion(): Promise<string> {
    return 'v1.0';
  }
}

class CustomMappingTablePort implements MappingTablePort {
  constructor(private readonly mapping: NLMapping) {}

  async findMapping(phrase: string): Promise<NLMapping | null> {
    if (phrase === this.mapping.phrase) return this.mapping;
    return null;
  }
  async findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return [this.mapping];
  }
  async getCurrentVersion(): Promise<string> {
    return 'v2.0';
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('NLMapper', () => {
  describe('with null MappingTablePort (built-in fallback)', () => {
    const mapper = new NLMapper(new NullMappingTablePort());

    describe('phrase → attribute mapping', () => {
      it('"묵직한" → body >= 0.7', async () => {
        const mapping = await mapper.mapPhrase('묵직한');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('body');
        expect(mapping?.operator).toBe('>=');
        expect(mapping?.value).toBe(0.7);
      });

      it('"드라이" → sweetness <= 0.2', async () => {
        const mapping = await mapper.mapPhrase('드라이');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('sweetness');
        expect(mapping?.operator).toBe('<=');
        expect(mapping?.value).toBe(0.2);
      });

      it('"선물용" → occasion in [gift]', async () => {
        const mapping = await mapper.mapPhrase('선물용');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('occasion');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('gift');
      });

      it('"선물할" → occasion in [gift]', async () => {
        const mapping = await mapper.mapPhrase('선물할');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('occasion');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('gift');
      });

      it('"힐링되는" → occasion in [healing]', async () => {
        const mapping = await mapper.mapPhrase('힐링되는');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('occasion');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('healing');
      });

      it('"소개팅" → occasion in [date_night]', async () => {
        const mapping = await mapper.mapPhrase('소개팅');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('occasion');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('date_night');
      });

      it('"소개팅인데" → occasion in [date_night]', async () => {
        const mapping = await mapper.mapPhrase('소개팅인데');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('occasion');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('date_night');
      });

      it('"부담스럽고" → price_band = value', async () => {
        const mapping = await mapper.mapPhrase('부담스럽고');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('price_band');
        expect(mapping?.operator).toBe('=');
        expect(mapping?.value).toBe('value');
      });

      it('"스크류캡" → style in [screw_cap]', async () => {
        const mapping = await mapper.mapPhrase('스크류캡');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('style');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('screw_cap');
      });

      it('"차갑게 마실 수 있는" → style in [chillable]', async () => {
        const mapping = await mapper.mapPhrase('차갑게 마실 수 있는');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('style');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('chillable');
      });

      it('"실패 없는" → style in [crowd_pleasing]', async () => {
        const mapping = await mapper.mapPhrase('실패 없는');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('style');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('crowd_pleasing');
      });

      it('"crowd_pleasing" → style in [crowd_pleasing]', async () => {
        const mapping = await mapper.mapPhrase('crowd_pleasing');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('style');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('crowd_pleasing');
      });

      it('"입문자" → style in [approachable]', async () => {
        const mapping = await mapper.mapPhrase('입문자');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('style');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('approachable');
      });

      it('"approachable" → style in [approachable]', async () => {
        const mapping = await mapper.mapPhrase('approachable');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('style');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('approachable');
      });

      it('"예쁜 라벨" → style in [presentation_forward]', async () => {
        const mapping = await mapper.mapPhrase('예쁜 라벨');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('style');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('presentation_forward');
      });

      it('"예쁜 라벨이면" → style in [presentation_forward]', async () => {
        const mapping = await mapper.mapPhrase('예쁜 라벨이면');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('style');
        expect(mapping?.operator).toBe('in');
        expect(mapping?.value).toBe('presentation_forward');
      });

      it('"풀바디" → body >= 0.7', async () => {
        const mapping = await mapper.mapPhrase('풀바디');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('body');
        expect(mapping?.operator).toBe('>=');
        expect(mapping?.value).toBe(0.7);
      });

      it('"달달한" → sweetness >= 0.5', async () => {
        const mapping = await mapper.mapPhrase('달달한');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('sweetness');
        expect(mapping?.operator).toBe('>=');
        expect(mapping?.value).toBe(0.5);
      });

      it('"가벼운" → body <= 0.3', async () => {
        const mapping = await mapper.mapPhrase('가벼운');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('body');
        expect(mapping?.operator).toBe('<=');
        expect(mapping?.value).toBe(0.3);
      });

      it('"부드러운" → tannin <= 0.3', async () => {
        const mapping = await mapper.mapPhrase('부드러운');
        expect(mapping).not.toBeNull();
        expect(mapping?.mappedAttribute).toBe('tannin');
        expect(mapping?.operator).toBe('<=');
        expect(mapping?.value).toBe(0.3);
      });

      it('"적당히 달달한" → sweetness range [0.3, 0.6]', async () => {
        const mapping = await mapper.mapPhrase('적당히 달달한');
        expect(mapping).not.toBeNull();
        expect(mapping?.operator).toBe('range');
        expect(Array.isArray(mapping?.value)).toBe(true);
        const [min, max] = mapping?.value as readonly [number, number];
        expect(min).toBe(0.3);
        expect(max).toBe(0.6);
      });
    });

    describe('unknown phrase', () => {
      it('unknown phrase → null', async () => {
        const mapping = await mapper.mapPhrase('알수없는표현xyz');
        expect(mapping).toBeNull();
      });

      it('empty string → null', async () => {
        const mapping = await mapper.mapPhrase('');
        expect(mapping).toBeNull();
      });

      it('whitespace-only → null', async () => {
        const mapping = await mapper.mapPhrase('   ');
        expect(mapping).toBeNull();
      });
    });

    describe('mapConstraints — multiple phrases', () => {
      it('maps multiple valid phrases to multiple constraints', async () => {
        const { constraints } = await mapper.mapConstraints(['묵직한', '드라이', '선물용']);
        expect(constraints).toHaveLength(3);

        const bodyConstraint = constraints.find((c) => c.attribute === 'body');
        const sweetnessConstraint = constraints.find((c) => c.attribute === 'sweetness');
        const occasionConstraint = constraints.find((c) => c.attribute === 'occasion');

        expect(bodyConstraint).toBeDefined();
        expect(sweetnessConstraint).toBeDefined();
        expect(occasionConstraint).toBeDefined();
      });

      it('unknown phrases are silently skipped', async () => {
        const { constraints } = await mapper.mapConstraints(['묵직한', '존재하지않는표현', '드라이']);
        expect(constraints).toHaveLength(2);
      });

      it('empty phrase list returns empty array', async () => {
        const { constraints } = await mapper.mapConstraints([]);
        expect(constraints).toHaveLength(0);
      });

      it('all unknown phrases returns empty array', async () => {
        const { constraints } = await mapper.mapConstraints(['unknown1', 'unknown2']);
        expect(constraints).toHaveLength(0);
      });

      it('mapConstraints throws AbortError when signal aborts between slow phrase lookups', async () => {
        const slowMapper = new NLMapper(new SlowNullMappingTablePort(40));
        const controller = new AbortController();
        const phrases = ['za', 'zb', 'zc', 'zd'];
        const mapped = slowMapper.mapConstraints(phrases, { abortSignal: controller.signal });
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        controller.abort();
        await expect(mapped).rejects.toMatchObject({ name: 'AbortError' });
      });
    });

    describe('constraint shape', () => {
      it('constraint includes source_phrase and confidence', async () => {
        const { constraints } = await mapper.mapConstraints(['묵직한']);
        expect(constraints[0]?.source_phrase).toBe('묵직한');
        expect(constraints[0]?.confidence).toBeGreaterThan(0);
        expect(constraints[0]?.confidence).toBeLessThanOrEqual(1);
      });

      it('occasion constraint converts "in" operator value to array', async () => {
        const { constraints } = await mapper.mapConstraints(['선물용']);
        const c = constraints[0];
        expect(c?.operator).toBe('in');
        // toNormalizedConstraint wraps single string value in array
        expect(Array.isArray(c?.value)).toBe(true);
        expect((c?.value as string[])[0]).toBe('gift');
      });

      it('range operator constraint converts value to {min, max} object', async () => {
        const { constraints } = await mapper.mapConstraints(['적당히 달달한']);
        const c = constraints[0];
        expect(c?.operator).toBe('range');
        expect(typeof c?.value).toBe('object');
        const rangeVal = c?.value as { min: number; max: number };
        expect(rangeVal.min).toBe(0.3);
        expect(rangeVal.max).toBe(0.6);
      });
    });
  });

  describe('repository lookup priority', () => {
    it('repository mapping takes priority over built-in', async () => {
      // Override '묵직한' with different value
      const customMapping: NLMapping = {
        phrase: '묵직한',
        mappedAttribute: 'body',
        operator: '>=',
        value: 0.9, // different from built-in 0.7
        mappingConfidence: 0.99,
        mappingVersion: 'v2.0',
        source: 'custom_curation',
      };
      const mapper = new NLMapper(new CustomMappingTablePort(customMapping));

      const result = await mapper.mapPhrase('묵직한');
      expect(result?.value).toBe(0.9); // custom value takes priority
      expect(result?.mappingVersion).toBe('v2.0');
    });
  });

  describe('Korean predicate variant lookup (연결형→관형형)', () => {
    const mapper = new NLMapper(new NullMappingTablePort());

    it('"산도 높고" → acidity >= 0.7 (via variant "산도 높은")', async () => {
      const { constraints } = await mapper.mapConstraints(['산도 높고']);
      expect(constraints).toHaveLength(1);
      const c = constraints[0];
      expect(c?.attribute).toBe('acidity');
      expect(c?.operator).toBe('>=');
      expect(c?.value).toBe(0.7);
    });

    it('"평점 좋고" → critic_score >= 0.7 (via variant "평점 좋은")', async () => {
      const { constraints } = await mapper.mapConstraints(['평점 좋고']);
      expect(constraints).toHaveLength(1);
      const c = constraints[0];
      expect(c?.attribute).toBe('critic_score');
      expect(c?.operator).toBe('>=');
      expect(c?.value).toBe(0.7);
    });

    it('"평점 높고" → critic_score >= 0.8 (via variant "평점 높은")', async () => {
      const { constraints } = await mapper.mapConstraints(['평점 높고']);
      expect(constraints).toHaveLength(1);
      const c = constraints[0];
      expect(c?.attribute).toBe('critic_score');
      expect(c?.operator).toBe('>=');
      expect(c?.value).toBe(0.8);
    });

    it('"묵직하고" → body >= 0.7 (via variant "묵직한" from 하고→한)', async () => {
      const mapping = await mapper.mapPhrase('묵직하고');
      expect(mapping).not.toBeNull();
      expect(mapping?.mappedAttribute).toBe('body');
      expect(mapping?.operator).toBe('>=');
      expect(mapping?.value).toBe(0.7);
    });

    it('"풍부하며" → body >= 0.7 via "강렬한" is NOT matched; only "풍부한" doesn\'t exist as body — tests variant reach', async () => {
      // "풍부하며" → variant "풍부한" — but 풍부한 is not a DEFAULT_MAPPINGS key
      // (it could be added in the future). This tests that no false match occurs.
      const mapping = await mapper.mapPhrase('풍부하며');
      // 풍부한 is not in DEFAULT_MAPPINGS, so null is correct.
      expect(mapping).toBeNull();
    });

    it('"강렬하고" → body >= 0.8 (via variant "강렬한")', async () => {
      const mapping = await mapper.mapPhrase('강렬하고');
      expect(mapping).not.toBeNull();
      expect(mapping?.mappedAttribute).toBe('body');
      expect(mapping?.operator).toBe('>=');
      expect(mapping?.value).toBe(0.8);
    });

    it('"도수 낮고" → alcohol_pct <= 12 (via variant "도수 낮은")', async () => {
      const { constraints } = await mapper.mapConstraints(['도수 낮고']);
      expect(constraints).toHaveLength(1);
      const c = constraints[0];
      expect(c?.attribute).toBe('alcohol_pct');
      expect(c?.operator).toBe('<=');
      expect(c?.value).toBe(12);
    });

    it('already-adnominal form "산도 높은" still works (exact match, no variant needed)', async () => {
      const { constraints } = await mapper.mapConstraints(['산도 높은']);
      expect(constraints).toHaveLength(1);
      expect(constraints[0]?.attribute).toBe('acidity');
    });

    it('English phrases are unaffected by Korean variant generation', async () => {
      const mapping = await mapper.mapPhrase('low alcohol');
      expect(mapping).not.toBeNull();
      expect(mapping?.mappedAttribute).toBe('alcohol_pct');
    });
  });
});
