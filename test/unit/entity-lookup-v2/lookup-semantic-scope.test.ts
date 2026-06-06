import { describe, expect, it } from 'vitest';
import {
  buildLookupQuerySemanticProbe,
  buildLookupSemanticScopeFromProbe,
} from '../../../src/domain/resolver/v2/lookup-semantic-scope.js';

describe('lookup semantic scope short-vintage parsing', () => {
  it('promotes a two-digit vintage suffix into a line scope when the descriptor vintage matches', () => {
    const probe = buildLookupQuerySemanticProbe({
      query: '몬텔레나 11',
      locale: 'ko',
    });

    expect(probe.vintage).toBe(2011);

    const scope = buildLookupSemanticScopeFromProbe({
      probe,
      descriptor: {
        familyKey: 'montelena',
        vintage: 2011,
      },
    });

    expect(scope).toEqual({
      semanticScopeKey: 'line::montelena::::::::2011::qualified::ko',
      scopeAxis: 'line',
      familyKey: 'montelena',
      vintage: 2011,
      surfaceFormKind: 'qualified',
      locale: 'ko',
    });
  });

  it('does not treat a bare numeric query as a semantic vintage scope', () => {
    const probe = buildLookupQuerySemanticProbe({
      query: '18',
      locale: 'ko',
    });

    expect(probe.vintage).toBeUndefined();
  });
});
