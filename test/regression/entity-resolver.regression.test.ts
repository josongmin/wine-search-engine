import { describe, it, expect } from 'vitest';
import { resolveEntity } from '../../src/domain/attribute/service/entity-resolver.js';
import type { FuzzyMatcherPort } from '../../src/domain/query/port/fuzzy-matcher.port.js';

describe('RFC-019 regression: entity resolver', () => {
  it.each([
    ['보르도', 'region', 'Bordeaux'],
    ['보졸레누보', 'region', 'Beaujolais'],
    ['샤르도네', 'grape_primary', 'Chardonnay'],
    ['피노 그리지오', 'grape_primary', 'Pinot Gris'],
    ['프랑스', 'country', 'France'],
    ['부르고뉴', 'region', 'Burgundy'],
    ['카베르네 소비뇽', 'grape_primary', 'Cabernet Sauvignon'],
    ['소비뇽 블랑', 'grape_primary', 'Sauvignon Blanc'],
    ['Opus One', 'appellation', 'Opus One'],
    ['오푸스 원', 'appellation', 'Opus One'],
    ['오푸스원', 'appellation', 'Opus One'],
    ['알마비바', 'appellation', 'Almaviva'],
    ['almaviva', 'appellation', 'Almaviva'],
    ['페트뤼스', 'appellation', 'Pétrus'],
    ['샤또 페트뤼스', 'appellation', 'Pétrus'],
    ['샤토 페트루스', 'appellation', 'Pétrus'],
    ['샤또페트뤼스', 'appellation', 'Pétrus'],
    ['티냐넬로', 'appellation', 'Tignanello'],
    ['돔페리뇽', 'appellation', 'Dom Pérignon'],
    ['돔 페리뇽 모엣', 'appellation', 'Dom Pérignon'],
    ['사시카이아', 'appellation', 'Sassicaia'],
    ['사씨카이아', 'appellation', 'Sassicaia'],
    ['사씨까이아', 'appellation', 'Sassicaia'],
    ['사시까이아', 'appellation', 'Sassicaia'],
    ['샤또 마고', 'appellation', 'Château Margaux'],
    ['샤또마고', 'appellation', 'Château Margaux'],
    ['샤토 마고', 'appellation', 'Château Margaux'],
    ['모엣샹동 로제 임페리얼', 'appellation', 'Moët & Chandon Rosé Impérial'],
    ['모엣샹동 핑크', 'appellation', 'Moët & Chandon Rosé Impérial'],
    ['모엣 로제 임페리얼', 'appellation', 'Moët & Chandon Rosé Impérial'],
    ['로마네콩티', 'appellation', 'Domaine de la Romanée-Conti'],
    ['라피트', 'appellation', 'Château Lafite Rothschild'],
    ['라투르', 'appellation', 'Château Latour'],
    ['무통', 'appellation', 'Château Mouton Rothschild'],
    ['슈발블랑', 'appellation', 'Château Cheval Blanc'],
    ['오브리옹', 'appellation', 'Château Haut-Brion'],
    ['크루그', 'appellation', 'Krug'],
    ['루이로드레 크리스탈', 'appellation', 'Louis Roederer Cristal'],
    ['떼땅져', 'appellation', 'Taittinger'],
    ['오르넬라이아', 'appellation', 'Ornellaia'],
    ['케이머스', 'appellation', 'Caymus'],
    ['펜폴즈 그레인지', 'appellation', 'Penfolds Grange'],
    ['루이자도', 'appellation', 'Louis Jadot'],
    ['조셉펠프스 인시그니아', 'appellation', 'Joseph Phelps Insignia'],
  ])('resolves %s → %s:%s', (span, expectedType, expectedValue) => {
    const result = resolveEntity(span);
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe(expectedType);
    expect(result!.canonicalValue).toBe(expectedValue);
    expect(result!.matchedSurface).toBe(span);
  });

  it('returns null for unknown terms', () => {
    expect(resolveEntity('알수없는지역')).toBeNull();
    expect(resolveEntity('')).toBeNull();
    expect(resolveEntity('   ')).toBeNull();
  });

  it('preferEntityOverStyle promotes region over wine_type for 샴페인', () => {
    const result = resolveEntity('샴페인', { preferEntityOverStyle: true });
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe('region');
    expect(result!.canonicalValue).toBe('Champagne');
  });

  it('default priority returns wine_type for 샴페인', () => {
    const result = resolveEntity('champagne');
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe('wine_type');
  });

  it('matches compact Korean alias variants without manual duplicates', () => {
    const result = resolveEntity('나파밸리');
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe('region');
    expect(result!.canonicalValue).toBe('Napa Valley');
  });

  it('keeps 피노 as a context-required alias instead of a direct planner-safe grounding', () => {
    const result = resolveEntity('피노');
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe('grape_primary');
    expect(result!.canonicalValue).toBe('Pinot Noir');
    expect(result!.resolutionMode).toBe('context_required');
    expect(result!.ambiguityHint).toEqual({
      surface: '피노',
      entityType: 'grape_primary',
      retrievalConstraint: {
        attribute: 'grape_family',
        operator: '=',
        value: 'Pinot',
      },
      lexicalExpansions: ['pinot'],
      semanticExpansions: ['pinot noir', 'pinot gris', 'pinot blanc'],
      clarifyOptions: ['Pinot Noir', 'Pinot Gris', 'Pinot Blanc'],
      explorationBranches: [
        {
          label: 'Pinot Noir',
          softConstraint: {
            attribute: 'grape_primary',
            operator: '=',
            value: 'Pinot Noir',
          },
          matchValues: ['Pinot Noir'],
          lexicalExpansions: ['pinot noir'],
          semanticExpansions: ['pinot noir'],
        },
        {
          label: 'Pinot Gris',
          softConstraint: {
            attribute: 'grape_primary',
            operator: '=',
            value: 'Pinot Gris',
          },
          matchValues: ['Pinot Gris', 'Pinot Grigio'],
          lexicalExpansions: ['pinot gris', 'pinot grigio'],
          semanticExpansions: ['pinot gris', 'pinot grigio'],
        },
        {
          label: 'Pinot Blanc',
          softConstraint: {
            attribute: 'grape_primary',
            operator: '=',
            value: 'Pinot Blanc',
          },
          matchValues: ['Pinot Blanc'],
          lexicalExpansions: ['pinot blanc'],
          semanticExpansions: ['pinot blanc'],
        },
      ],
    });
  });

  describe('fuzzy fallback', () => {
    const stubFuzzyMatcher: FuzzyMatcherPort = {
      match(query: string) {
        // Simulates a BK-tree that knows "bordeaux" and returns it for typo "bordeux"
        if (query === 'bordeux') {
          return [{ term: 'bordeaux', editDistance: 1, combinedScore: 0.85 }];
        }
        // Below threshold
        if (query === 'xyzfoo') {
          return [{ term: 'bordeaux', editDistance: 5, combinedScore: 0.3 }];
        }
        // Term not in RESOLVER_INDEX
        if (query === 'typoterm') {
          return [{ term: 'nonexistent_alias_xyz', editDistance: 1, combinedScore: 0.9 }];
        }
        return [];
      },
    };

    it('resolves typo via fuzzy fallback when exact match fails', () => {
      // "bordeux" is not in RESOLVER_INDEX, but fuzzy returns "bordeaux" which is
      const withoutFuzzy = resolveEntity('bordeux');
      expect(withoutFuzzy).toBeNull();

      const withFuzzy = resolveEntity('bordeux', undefined, stubFuzzyMatcher);
      expect(withFuzzy).not.toBeNull();
      expect(withFuzzy!.canonicalValue).toBe('Bordeaux');
      expect(withFuzzy!.matchedSurface).toBe('bordeux');
      expect(withFuzzy!.provenance).toBe('fuzzy_fallback');
      // confidence = 0.85 * 0.85 = 0.7225
      expect(withFuzzy!.confidence).toBeCloseTo(0.85 * 0.85, 4);
    });

    it('does not use fuzzy fallback when exact match succeeds', () => {
      const result = resolveEntity('bordeaux', undefined, stubFuzzyMatcher);
      expect(result).not.toBeNull();
      // Should be exact match, not fuzzy
      expect(result!.provenance).not.toBe('fuzzy_fallback');
    });

    it('rejects fuzzy hits below FUZZY_MIN_CONFIDENCE (0.7)', () => {
      const result = resolveEntity('xyzfoo', undefined, stubFuzzyMatcher);
      expect(result).toBeNull();
    });

    it('rejects fuzzy hits whose term is not in RESOLVER_INDEX', () => {
      const result = resolveEntity('typoterm', undefined, stubFuzzyMatcher);
      expect(result).toBeNull();
    });

    it('returns null without fuzzyMatcher even for near-miss terms', () => {
      const result = resolveEntity('bordeux');
      expect(result).toBeNull();
    });
  });
});
