import { describe, it, expect } from 'vitest';
import { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../src/domain/attribute/port/mapping-table.port.js';

const nullPort: MappingTablePort = {
  findMapping: async () => null,
  findMappingsByAttribute: async () => [],
  getCurrentVersion: async () => 'v1.0',
};

const mapper = new NLMapper(nullPort);

describe('RFC-019 regression: NL mapper coverage', () => {
  it.each([
    ['레드', 'wine_type', 'red'],
    ['화이트', 'wine_type', 'white'],
    ['스파클링', 'wine_type', 'sparkling'],
  ])('wine_type: %s → %s=%s', async (phrase, attr, value) => {
    const m = await mapper.mapPhrase(phrase);
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe(attr);
    expect(m!.value).toBe(value);
  });

  it.each([
    ['프랑스', 'country', 'France'],
  ])('country: %s → %s=%s', async (phrase, attr, value) => {
    const m = await mapper.mapPhrase(phrase);
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe(attr);
    expect(m!.value).toBe(value);
  });

  it.each([
    ['보르도', 'region', 'Bordeaux'],
  ])('region: %s → %s=%s', async (phrase, attr, value) => {
    const m = await mapper.mapPhrase(phrase);
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe(attr);
    expect(m!.value).toBe(value);
  });

  it.each([
    ['카베르네', 'grape_primary', 'Cabernet Sauvignon'],
    ['피노 그리지오', 'grape_primary', 'Pinot Gris'],
    ['피노 그리', 'grape_primary', 'Pinot Gris'],
  ])('grape: %s → %s=%s', async (phrase, attr, value) => {
    const m = await mapper.mapPhrase(phrase);
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe(attr);
    expect(m!.value).toBe(value);
  });

  it('ambiguous short alias 피노 does not resolve directly in NLMapper', async () => {
    const m = await mapper.mapPhrase('피노');
    expect(m).toBeNull();
  });

  it.each([
    '샤또 마고',
    '샤토 마고',
    '페트뤼스',
    '돔페리뇽',
    '사시카이아',
    '모엣샹동 로제 임페리얼',
  ])('exact wine alias %s stays out of NLMapper hard constraints', async (phrase) => {
    const m = await mapper.mapPhrase(phrase);
    expect(m).toBeNull();
  });

  it.each([
    ['바롤로', 'appellation', 'Barolo'],
    ['브루넬로', 'appellation', 'Brunello di Montalcino'],
  ])('ontology appellation still maps: %s → %s=%s', async (phrase, attr, value) => {
    const m = await mapper.mapPhrase(phrase);
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe(attr);
    expect(m!.value).toBe(value);
  });

  it('unknown phrase returns null', async () => {
    const m = await mapper.mapPhrase('알수없는단어');
    expect(m).toBeNull();
  });
});
