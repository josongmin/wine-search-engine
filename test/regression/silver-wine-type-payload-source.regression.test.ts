/**
 * Regression: `inferWineTypeFromPayloadType` rescues the no-grape +
 * no-display-keyword + no-flavor cohort from silver drop.
 *
 * Pre-fix (post-RCA Tier 1.3): the wineType chain was
 *   detectWineType(row.wine_style)    [0% populated in Bronze]
 *   → inferWineTypeFromDisplayName    [partial hit rate]
 *   → inferWineTypeFromFlavorProfiles [partial hit rate]
 *   → inferTypeFromGrape              [null for 4042 no-grape rows]
 * → silver dropped 4203 rows as `transform_failed`.
 *
 * Post-fix: probe (2026-05-25) revealed `payload.type` populated for
 * 10411/10469 = 99.4% of Bronze rows (literally always "Red" in this dump).
 * `payload.wine_style` (top-level STRING) populated for ~98% with values
 * like "Burgundy Côte de Nuits Red", "Napa Valley Cabernet Sauvignon".
 * Adding `inferWineTypeFromPayloadType` as the FIRST step in the chain
 * rescues nearly all no-grape rows.
 *
 * Contract pinned:
 *  1. `payload.type` exact case-insensitive map ("Red" → 'red', etc.)
 *  2. `payload.wine_style` token scan (sparkling/rosé/dessert/fortified
 *     checked BEFORE white to avoid mis-classification of "Sparkling White")
 *  3. Unknown payload.type → null (chain proceeds)
 *  4. null payload → null
 */

import { describe, it, expect } from 'vitest';
import { inferWineTypeFromPayloadType } from '../../scripts/etl/vivino-to-silver.js';
import type { VivinoPayload } from '../../scripts/etl/types.js';

function payload(p: Partial<VivinoPayload>): VivinoPayload {
  return p as VivinoPayload;
}

describe('inferWineTypeFromPayloadType (Tier 1.3+ regression)', () => {
  describe('payload.type explicit map', () => {
    it('"Red" → red', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'Red' }))).toBe('red');
    });
    it('"White" → white', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'White' }))).toBe('white');
    });
    it('"Sparkling" → sparkling', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'Sparkling' }))).toBe('sparkling');
    });
    it('"Rosé" → rosé', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'Rosé' }))).toBe('rosé');
    });
    it('"Rose" (no accent) → rosé', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'Rose' }))).toBe('rosé');
    });
    it('"Dessert" → dessert', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'Dessert' }))).toBe('dessert');
    });
    it('"Fortified" → fortified', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'Fortified' }))).toBe('fortified');
    });
    it('"Port" → fortified', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'Port' }))).toBe('fortified');
    });
    it('case-insensitive', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'RED' }))).toBe('red');
      expect(inferWineTypeFromPayloadType(payload({ type: 'red' }))).toBe('red');
    });
    it('unknown label → null', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: 'Mystery' }))).toBeNull();
    });
  });

  describe('payload.wine_style token scan', () => {
    it('"Burgundy Côte de Nuits Red" → red', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Burgundy Côte de Nuits Red' }))).toBe('red');
    });
    it('"Italian Barolo" — no wine-type token → null (falls through to grape inference)', () => {
      // "Barolo" alone isn't in the wine-type token list (it's a region, and
      // type-inference defers to grape/display-name in the chain).
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Italian Barolo' }))).toBeNull();
    });
    it('"Champagne Brut" → sparkling (sparkling-keyword wins via "champagne")', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Champagne Brut' }))).toBe('sparkling');
    });
    it('"Sancerre White" → white', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Sancerre White' }))).toBe('white');
    });
    it('"Provence Rosé" → rosé', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Provence Rosé' }))).toBe('rosé');
    });
    it('"Sauternes" → dessert', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Sauternes' }))).toBe('dessert');
    });
    it('"Vintage Port" → fortified', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Vintage Port' }))).toBe('fortified');
    });
    it('"Sparkling White" → sparkling (NOT white — order matters)', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Sparkling White' }))).toBe('sparkling');
    });
    it('Spanish "Tinto" → red', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Spanish Tinto' }))).toBe('red');
    });
    it('Italian "Rosso" → red', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Italian Rosso' }))).toBe('red');
    });
    it('French "Blanc" → white', () => {
      expect(inferWineTypeFromPayloadType(payload({ wine_style: 'Vin Blanc' }))).toBe('white');
    });
  });

  describe('precedence: type wins over wine_style', () => {
    it('type=Red + wine_style="some white-blend" → red (type explicit)', () => {
      expect(
        inferWineTypeFromPayloadType(payload({ type: 'Red', wine_style: 'Some White Blend' })),
      ).toBe('red');
    });
  });

  describe('edge cases', () => {
    it('null payload → null', () => {
      expect(inferWineTypeFromPayloadType(null)).toBeNull();
    });
    it('empty payload → null', () => {
      expect(inferWineTypeFromPayloadType(payload({}))).toBeNull();
    });
    it('whitespace-only type → null (falls through)', () => {
      expect(inferWineTypeFromPayloadType(payload({ type: '   ' }))).toBeNull();
    });
  });
});
