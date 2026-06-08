import { describe, expect, it } from 'vitest';
import {
  buildLookupQuerySemanticProbe,
  buildLookupSemanticScopeFromProbe,
  resolveLookupSemanticLocale,
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

  it('does not force an unmatched lineKey into a vintage-only qualified scope', () => {
    const probe = buildLookupQuerySemanticProbe({
      query: '솔라이아 2018',
      locale: 'ko',
    });

    const scope = buildLookupSemanticScopeFromProbe({
      probe,
      descriptor: {
        familyKey: 'solaia',
        lineKey: 'antinori tenuta tignanello solaia',
        vintage: 2018,
      },
    });

    expect(scope).toEqual({
      semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
      scopeAxis: 'line',
      familyKey: 'solaia',
      vintage: 2018,
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

  it('infers ko semantic locale from Hangul queries when locale is omitted', () => {
    expect(resolveLookupSemanticLocale({ query: '솔라이아 2018' })).toBe('ko');
    expect(resolveLookupSemanticLocale({ query: 'Solaia 2018' })).toBe('global');
    expect(resolveLookupSemanticLocale({ query: 'Solaia 2018', locale: 'ko-KR' })).toBe('ko');
  });
});
