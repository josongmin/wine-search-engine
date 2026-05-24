/**
 * Regression: silver `transformRow` wine-type fallback chain (Tier 1.3).
 *
 * Pre-fix: only two layers existed —
 *   1. `detectWineType(row.wine_style)`
 *   2. `inferTypeFromGrape(grapePrimary)`
 *
 * But `payload.wine_style.name` is null for 100% of the bronze corpus
 * (0 / 10,469 populated), so layer 1 always returns null. Layer 2 only fires
 * when grape data is present — ~61% varietal coverage. The remaining ~39% of
 * rows that had no grape data were silently dropped at silver even though
 * the wine label ("Champagne", "Riesling", "Sauternes", etc.) was clearly
 * classifiable.
 *
 * New full chain (in order, FIRST NON-NULL WINS):
 *   1. detectWineType(row.wine_style)                    — original
 *   2. inferWineTypeFromDisplayName(row.display_name)    — NEW
 *   3. inferWineTypeFromFlavorProfiles(flavor_profiles)  — NEW
 *   4. inferTypeFromGrape(grapePrimary)                  — original
 *
 * Negative-pin: "Cabernet Sauvignon" in display_name must NOT trigger the
 * white branch (the white branch requires explicit "Sauvignon Blanc" or
 * a different white grape).
 */

import { describe, it, expect } from 'vitest';
import {
  inferWineTypeFromDisplayName,
  inferWineTypeFromFlavorProfiles,
  transformRow,
} from '../../scripts/etl/vivino-to-silver.js';
import type { BronzeRow } from '../../scripts/etl/types.js';

describe('inferWineTypeFromDisplayName — keyword scan over wine label (regression)', () => {
  describe('sparkling (highest specificity — must precede white)', () => {
    it('"Champagne Brut" → sparkling', () => {
      expect(inferWineTypeFromDisplayName('Champagne Brut')).toBe('sparkling');
    });

    it('"Prosecco" → sparkling', () => {
      expect(inferWineTypeFromDisplayName('La Marca Prosecco')).toBe('sparkling');
    });

    it('"Cava" → sparkling', () => {
      expect(inferWineTypeFromDisplayName('Freixenet Cordon Negro Cava')).toBe('sparkling');
    });

    it('"Krug Champagne" → sparkling (NOT misclassified as white via Champagne being white)', () => {
      expect(inferWineTypeFromDisplayName('1996 Krug Champagne')).toBe('sparkling');
    });
  });

  describe('dessert', () => {
    it('"Sauternes" → dessert', () => {
      expect(inferWineTypeFromDisplayName("Château d'Yquem Sauternes")).toBe('dessert');
    });

    it('"Tokaji" → dessert', () => {
      expect(inferWineTypeFromDisplayName('Royal Tokaji Aszú 5 Puttonyos')).toBe('dessert');
    });
  });

  describe('fortified', () => {
    it('"Port" → fortified', () => {
      expect(inferWineTypeFromDisplayName('Taylor Fladgate Vintage Port')).toBe('fortified');
    });

    it('"Sherry" → fortified', () => {
      expect(inferWineTypeFromDisplayName('Lustau Amontillado Sherry')).toBe('fortified');
    });
  });

  describe('white (explicit grapes or "blanc" / "white")', () => {
    it('"Sancerre" → white', () => {
      expect(inferWineTypeFromDisplayName('Henri Bourgeois Sancerre')).toBe('white');
    });

    it('"Riesling" → white', () => {
      expect(inferWineTypeFromDisplayName('Dr Loosen Bernkasteler Lay Riesling')).toBe('white');
    });

    it('"Chardonnay" → white', () => {
      expect(inferWineTypeFromDisplayName('Kistler Vine Hill Chardonnay')).toBe('white');
    });

    it('"Sauvignon Blanc" → white', () => {
      expect(inferWineTypeFromDisplayName('Cloudy Bay Sauvignon Blanc')).toBe('white');
    });

    // ── Negative pin: "Cabernet Sauvignon" MUST NOT trigger white ─────────────
    it('NEGATIVE: "Cabernet Sauvignon" alone does NOT trigger the white branch', () => {
      // Without "Sauvignon Blanc", just "Cabernet Sauvignon" must not be white.
      // We don't care which non-white branch fires — only that it isn't 'white'.
      const result = inferWineTypeFromDisplayName(
        '2015 Caymus Cabernet Sauvignon Napa Valley',
      );
      expect(result).not.toBe('white');
    });
  });

  describe('rosé', () => {
    it('"Rosé" → rosé', () => {
      expect(inferWineTypeFromDisplayName('Whispering Angel Rosé')).toBe('rosé');
    });

    it('"Blush" → rosé', () => {
      expect(inferWineTypeFromDisplayName('Sutter Home White Zinfandel Blush')).toBe('rosé');
    });
  });

  describe('red (lexical anchor — never a default)', () => {
    it('"Red" → red', () => {
      expect(inferWineTypeFromDisplayName('Bodega Catena Zapata Red Blend')).toBe('red');
    });

    it('"Rouge" → red', () => {
      expect(inferWineTypeFromDisplayName('Cuvée Rouge')).toBe('red');
    });
  });

  describe('no match', () => {
    it('"Sassicaia 2018" returns null when there is no lexical anchor', () => {
      // Sassicaia is a Super-Tuscan Bordeaux-blend — its label has no grape
      // or wine-type keyword in display_name. inferWineTypeFromDisplayName
      // must return null and defer to the next fallback (flavor_profiles).
      expect(inferWineTypeFromDisplayName('Sassicaia 2018')).toBeNull();
    });

    it('empty / null / undefined → null', () => {
      expect(inferWineTypeFromDisplayName(undefined)).toBeNull();
      expect(inferWineTypeFromDisplayName(null)).toBeNull();
      expect(inferWineTypeFromDisplayName('')).toBeNull();
      expect(inferWineTypeFromDisplayName('   ')).toBeNull();
    });
  });
});

describe('inferWineTypeFromFlavorProfiles — Vivino curated taste catalog (regression)', () => {
  it('["black fruit", "oak"] → red', () => {
    expect(inferWineTypeFromFlavorProfiles(['black fruit', 'oak'])).toBe('red');
  });

  it('["earthy", "leather"] → red', () => {
    expect(inferWineTypeFromFlavorProfiles(['earthy', 'leather'])).toBe('red');
  });

  it('["citrus", "tropical"] → white', () => {
    expect(inferWineTypeFromFlavorProfiles(['citrus', 'tropical'])).toBe('white');
  });

  it('["floral", "stone fruit"] → white', () => {
    expect(inferWineTypeFromFlavorProfiles(['floral', 'stone fruit'])).toBe('white');
  });

  it('["toast", "biscuit", "apple"] → sparkling (≥2 of toast/biscuit/apple)', () => {
    expect(inferWineTypeFromFlavorProfiles(['toast', 'biscuit', 'apple'])).toBe('sparkling');
  });

  it('["apple"] alone → NOT sparkling (single hit < min of 2)', () => {
    // Apple alone could be a Riesling — sparkling requires ≥2 co-occurring
    // signatures.
    expect(inferWineTypeFromFlavorProfiles(['apple'])).not.toBe('sparkling');
  });

  it('empty / undefined / null → null', () => {
    expect(inferWineTypeFromFlavorProfiles([])).toBeNull();
    expect(inferWineTypeFromFlavorProfiles(undefined)).toBeNull();
    expect(inferWineTypeFromFlavorProfiles(null)).toBeNull();
  });

  it('unrecognized profiles → null', () => {
    expect(inferWineTypeFromFlavorProfiles(['something', 'unknown'])).toBeNull();
  });
});

describe('transformRow wine-type fallback chain — end-to-end (regression)', () => {
  const base: BronzeRow = {
    id: 1,
    external_id: 'wine-type-test',
    display_name: '',
    producer: 'Test Producer',
    vintage_year: 2020,
    region: 'Test Region',
    country: 'Test Country',
    wine_style: null, // mirrors 100% of real bronze rows
    rating: 4.0,
    price: 100,
    currency: 'USD',
    scraped_at: '2024-01-01T00:00:00Z',
    source_url: null,
    payload: null,
  };

  it('layer 2: "Champagne Brut" → sparkling (display_name fallback)', () => {
    const result = transformRow({ ...base, display_name: 'Pol Roger Champagne Brut' });
    expect(result?.wineType).toBe('sparkling');
  });

  it('layer 2: "Sauternes" → dessert (display_name fallback)', () => {
    const result = transformRow({
      ...base,
      display_name: "Château d'Yquem Sauternes 2015",
    });
    expect(result?.wineType).toBe('dessert');
  });

  it('layer 2: "Sancerre" → white (display_name fallback)', () => {
    const result = transformRow({
      ...base,
      display_name: 'Henri Bourgeois Les Baronnes Sancerre 2020',
    });
    expect(result?.wineType).toBe('white');
  });

  it('layer 3: "1987 Opus One Opus One" + flavor_profiles=[black fruit, oak] → red', () => {
    // "Opus One" is not a wine-style keyword; layer 2 returns null. Layer 3
    // recovers the classification from Vivino's curated flavor catalog.
    const result = transformRow({
      ...base,
      external_id: 'opus-one-1987',
      display_name: '1987 Opus One Opus One',
      vintage_year: 1987,
      payload: {
        taste: {
          // extractFlavorProfiles reads payload.taste.flavor[].group and
          // replaces hyphens with spaces. We feed "black-fruit" / "oak" so
          // the run-time vocabulary matches.
          flavor: [
            { group: 'black-fruit' },
            { group: 'oak' },
          ],
        },
      },
    });
    expect(result?.wineType).toBe('red');
  });

  it('NEGATIVE: "Cabernet Sauvignon" in display_name does NOT classify as white', () => {
    // Layer 2 must NOT take the white branch on "Cabernet Sauvignon".
    // With a red-leaning grape primary the chain should land on red (via
    // layer 4 inferTypeFromGrape), NOT white.
    const result = transformRow({
      ...base,
      external_id: 'caymus-test',
      display_name: '2015 Caymus Cabernet Sauvignon Napa Valley',
      payload: {
        varietal: 'Cabernet Sauvignon',
      },
    });
    expect(result?.wineType).not.toBe('white');
    expect(result?.wineType).toBe('red');
  });

  it('Sassicaia: layer 2 returns null, layer 3 (flavor) classifies as red', () => {
    const result = transformRow({
      ...base,
      external_id: 'sassicaia-2018',
      display_name: 'Sassicaia 2018',
      vintage_year: 2018,
      payload: {
        taste: {
          flavor: [
            { group: 'black-fruit' },
            { group: 'oak' },
            { group: 'earthy' },
          ],
        },
      },
    });
    expect(result?.wineType).toBe('red');
  });

  it('layer 4: falls through to grape inference when display_name + flavor are silent', () => {
    const result = transformRow({
      ...base,
      external_id: 'fallback-grape-only',
      display_name: 'Bodega Nameless Wine',
      payload: {
        varietal: 'Riesling',
      },
    });
    expect(result?.wineType).toBe('white');
  });

  it('all 4 layers silent → transformRow drops the record (fails closed)', () => {
    const result = transformRow({
      ...base,
      external_id: 'unclassifiable',
      display_name: 'Bodega Nameless Mystery Cuvée',
      payload: {
        taste: {
          structure: {
            // fizziness below threshold so the sparkling override does not fire
            fizziness: 0,
            acidity: 3,
            tannin: 2,
            sweetness: 1,
            intensity: 3,
          },
        },
      },
    });
    expect(result).toBeNull();
  });
});
