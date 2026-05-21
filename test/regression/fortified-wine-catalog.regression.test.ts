/**
 * Regression: fortified/aromatized wine vocabulary recognition (S3 — coverage
 * gap, low severity).
 *
 * Background: prior to this expansion, terms like "포트와인", "셰리", "베르무트",
 * "마데이라", "마살라" were unknown to the wine-type alias map. While the off-
 * domain pattern set did not misclassify them as OOD alcohol (good), they also
 * failed to resolve as wine — analyzer produced zero anchors and routed via
 * the unsupported-intent reject path.
 *
 * Invariant 1: each fortified/aromatized term normalizes to a canonical wine
 * type via the SSoT `WINE_TYPE_ALIASES` map in `wine-ontology.ts`.
 *
 * Invariant 2: the existing core wine-type aliases (red/white/rosé/sparkling/
 * dessert/fortified base entry) must continue to normalize unchanged — no
 * regression on the prior surface.
 *
 * Invariant 3 (SSoT, rule 25/30): the only wine-type alias map in production
 * code is `WINE_TYPE_ALIASES`. This regression locks the canonical fortified
 * mappings so a future parallel structure would be caught by a SSoT audit.
 */
import { describe, expect, it } from 'vitest';
import {
  WINE_TYPE_ALIASES,
  normalizeWineType,
} from '../../src/domain/evaluation/service/wine-ontology.js';

describe('Fortified/aromatized wine vocabulary (S3)', () => {
  describe('Korean aliases resolve to canonical fortified type', () => {
    const FORTIFIED_KOREAN: ReadonlyArray<readonly [string, string]> = [
      // Port — Portuguese fortified
      ['포트', 'fortified'],
      ['포트와인', 'fortified'],
      ['포트 와인', 'fortified'],
      // Sherry — Spanish fortified
      ['셰리', 'fortified'],
      ['쉐리', 'fortified'],
      ['세리', 'fortified'],
      // Madeira — Portuguese fortified
      ['마데이라', 'fortified'],
      // Marsala — Italian fortified
      ['마살라', 'fortified'],
      // Vermouth — aromatized
      ['베르무트', 'fortified'],
      ['베르뭇', 'fortified'],
      ['버무스', 'fortified'],
    ];

    for (const [alias, canonical] of FORTIFIED_KOREAN) {
      it(`"${alias}" → "${canonical}"`, () => {
        expect(normalizeWineType(alias)).toBe(canonical);
        expect(WINE_TYPE_ALIASES.get(alias)).toBe(canonical);
      });
    }
  });

  describe('English aliases resolve to canonical fortified type', () => {
    const FORTIFIED_ENGLISH: ReadonlyArray<readonly [string, string]> = [
      ['port', 'fortified'],
      ['sherry', 'fortified'],
      ['madeira', 'fortified'],
      ['marsala', 'fortified'],
      ['vermouth', 'fortified'],
    ];

    for (const [alias, canonical] of FORTIFIED_ENGLISH) {
      it(`"${alias}" → "${canonical}"`, () => {
        expect(normalizeWineType(alias)).toBe(canonical);
        expect(WINE_TYPE_ALIASES.get(alias)).toBe(canonical);
      });
    }
  });

  describe('Tokaji is NOT in WINE_TYPE_ALIASES (appellation-precedence)', () => {
    it('"토카이" is reserved for the gold appellation catalog, not the wine-type map', () => {
      // Gold catalog maps "토카이" → "Royal Tokaji Aszú 6 Puttonyos 2017"
      // (appellation). Adding it to WINE_TYPE_ALIASES would shadow that
      // higher-precision mapping; the gold-korean-entity-alias-catalog
      // regression test enforces this exclusion.
      expect(WINE_TYPE_ALIASES.get('토카이')).toBeUndefined();
      expect(WINE_TYPE_ALIASES.get('tokaji')).toBeUndefined();
    });
  });

  describe('pre-existing aliases unchanged (no regression)', () => {
    const PRE_EXISTING: ReadonlyArray<readonly [string, string]> = [
      ['red', 'red'],
      ['레드', 'red'],
      ['white', 'white'],
      ['화이트', 'white'],
      ['rosé', 'rosé'],
      ['로제', 'rosé'],
      ['sparkling', 'sparkling'],
      ['스파클링', 'sparkling'],
      ['champagne', 'sparkling'],
      ['dessert', 'dessert'],
      ['디저트', 'dessert'],
      ['fortified', 'fortified'],
    ];

    for (const [alias, canonical] of PRE_EXISTING) {
      it(`"${alias}" still → "${canonical}"`, () => {
        expect(normalizeWineType(alias)).toBe(canonical);
      });
    }
  });

  describe('case- and whitespace-tolerant normalization', () => {
    it('uppercase + extra whitespace still resolves', () => {
      expect(normalizeWineType('  PORT  ')).toBe('fortified');
      expect(normalizeWineType('SHERRY')).toBe('fortified');
      expect(normalizeWineType('  포트와인 ')).toBe('fortified');
    });
  });

  describe('SSoT lock (rule 25/30): single map, no duplicates', () => {
    it('WINE_TYPE_ALIASES is a ReadonlyMap with all fortified entries pointing to "fortified"', () => {
      const FORTIFIED_SURFACES = [
        'port', '포트', '포트와인',
        'sherry', '셰리', '쉐리', '세리',
        'madeira', '마데이라',
        'marsala', '마살라',
        'vermouth', '베르무트',
      ];
      for (const surface of FORTIFIED_SURFACES) {
        expect(WINE_TYPE_ALIASES.get(surface)).toBe('fortified');
      }
    });
  });
});
