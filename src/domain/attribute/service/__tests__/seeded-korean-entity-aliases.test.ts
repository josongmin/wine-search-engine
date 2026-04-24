import { describe, expect, it } from 'vitest';

import { resolveEntity } from '../entity-resolver.js';

describe('seeded Korean entity aliases', () => {
  it('resolves Whispering Angel Korean aliases through the generated seed catalog', () => {
    const resolved = resolveEntity('위스퍼링 엔젤');

    expect(resolved).toMatchObject({
      canonicalValue: "Château d'Esclans Whispering Angel Rosé 2022",
      entityType: 'appellation',
      provenance: 'seed_catalog',
      resolutionMode: 'direct',
    });
  });

  it('resolves Casillero del Diablo Korean aliases through the generated seed catalog', () => {
    const resolved = resolveEntity('카시예로 델 디아블로');

    expect(resolved).toMatchObject({
      canonicalValue: 'Casillero del Diablo Cabernet Sauvignon 2021',
      entityType: 'appellation',
      provenance: 'seed_catalog',
      resolutionMode: 'direct',
    });
  });

  it('resolves Felton Road Korean aliases through the generated seed catalog', () => {
    const resolved = resolveEntity('펠튼 로드 피노 누아');

    expect(resolved).toMatchObject({
      canonicalValue: 'Felton Road Pinot Noir Block 5 2021',
      entityType: 'appellation',
      provenance: 'seed_catalog',
      resolutionMode: 'direct',
    });
  });
});
