import { describe, it, expect } from 'vitest';
import { NLMapper } from '../../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../../src/domain/attribute/port/mapping-table.port.js';
import type { NLMapping } from '../../../src/domain/attribute/model/nl-mapping.js';

// ── Stub MappingTablePort: returns null always (forces built-in fallbacks) ────
class StubMappingTable implements MappingTablePort {
  async findMapping(_phrase: string): Promise<NLMapping | null> {
    return null;
  }
  async findMappingsByAttribute(_attribute: string): Promise<readonly NLMapping[]> {
    return [];
  }
  async getCurrentVersion(): Promise<string> {
    return 'v1.0';
  }
}

const mapper = new NLMapper(new StubMappingTable());

describe('NLMapper', () => {
  it('"묵직한" → body >= 0.7 constraint', async () => {
    const mapping = await mapper.mapPhrase('묵직한');
    expect(mapping).not.toBeNull();
    expect(mapping!.mappedAttribute).toBe('body');
    expect(mapping!.operator).toBe('>=');
    expect(mapping!.value).toBe(0.7);
  });

  it('"드라이" → sweetness <= 0.2 constraint', async () => {
    const mapping = await mapper.mapPhrase('드라이');
    expect(mapping).not.toBeNull();
    expect(mapping!.mappedAttribute).toBe('sweetness');
    expect(mapping!.operator).toBe('<=');
    expect(mapping!.value).toBe(0.2);
  });

  it('"선물용" → occasion in ["gift"] constraint', async () => {
    const mapping = await mapper.mapPhrase('선물용');
    expect(mapping).not.toBeNull();
    expect(mapping!.mappedAttribute).toBe('occasion');
    expect(mapping!.operator).toBe('in');
    expect(mapping!.value).toBe('gift');
  });

  it('"입문용" → price_band = "low" constraint', async () => {
    const mapping = await mapper.mapPhrase('입문용');
    expect(mapping).not.toBeNull();
    expect(mapping!.mappedAttribute).toBe('price_band');
    expect(mapping!.operator).toBe('=');
    expect(mapping!.value).toBe('low');
  });

  it('"적당히 달달한" → sweetness range [0.3, 0.6] constraint', async () => {
    const mapping = await mapper.mapPhrase('적당히 달달한');
    expect(mapping).not.toBeNull();
    expect(mapping!.mappedAttribute).toBe('sweetness');
    expect(mapping!.operator).toBe('range');
    expect(Array.isArray(mapping!.value)).toBe(true);
    const [min, max] = mapping!.value as readonly [number, number];
    expect(min).toBe(0.3);
    expect(max).toBe(0.6);
  });

  it('Unknown phrase → null', async () => {
    const mapping = await mapper.mapPhrase('완전히 모르는 표현');
    expect(mapping).toBeNull();
  });

  it('"풀바디" → body >= 0.7 (alternative phrase)', async () => {
    const mapping = await mapper.mapPhrase('풀바디');
    expect(mapping).not.toBeNull();
    expect(mapping!.mappedAttribute).toBe('body');
    expect(mapping!.operator).toBe('>=');
    expect(mapping!.value).toBe(0.7);
  });

  it('"달지 않은" → sweetness <= 0.2', async () => {
    const mapping = await mapper.mapPhrase('달지 않은');
    expect(mapping).not.toBeNull();
    expect(mapping!.mappedAttribute).toBe('sweetness');
    expect(mapping!.operator).toBe('<=');
  });

  it('mapConstraints converts multiple phrases to normalized constraints', async () => {
    const { constraints } = await mapper.mapConstraints(['묵직한', '드라이']);
    expect(constraints).toHaveLength(2);
    expect(constraints.some((c) => c.attribute === 'body')).toBe(true);
    expect(constraints.some((c) => c.attribute === 'sweetness')).toBe(true);
  });

  it('mapConstraints silently skips unknown phrases', async () => {
    const { constraints } = await mapper.mapConstraints(['묵직한', '존재하지않는표현']);
    expect(constraints).toHaveLength(1);
    expect(constraints[0]!.attribute).toBe('body');
  });

  it('mapConstraints for range phrase produces correct value shape', async () => {
    const { constraints } = await mapper.mapConstraints(['적당히 달달한']);
    expect(constraints).toHaveLength(1);
    const c = constraints[0]!;
    expect(c.attribute).toBe('sweetness');
    expect(c.operator).toBe('range');
    // Value should be {min, max} object
    expect(c.value).toEqual({ min: 0.3, max: 0.6 });
  });

  it('mapConstraints for "in" phrase produces array value', async () => {
    const { constraints } = await mapper.mapConstraints(['선물용']);
    expect(constraints).toHaveLength(1);
    const c = constraints[0]!;
    expect(c.attribute).toBe('occasion');
    expect(c.operator).toBe('in');
    expect(Array.isArray(c.value)).toBe(true);
    expect(c.value).toContain('gift');
  });
});
