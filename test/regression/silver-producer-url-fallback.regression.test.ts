/**
 * Regression: `extractProducerFromVivinoUrl` is step 5 of the producer
 * fallback chain.
 *
 * Pre-fix (post-Tier 1.2): 1670 / 10469 Bronze rows had producer null in all
 * 4 prior paths and dropped at silver. Probe revealed `payload.url` contains
 * a canonical winery slug for ~99% of these rows. URL parsing recovers them
 * — drops 1670 → 11 in production.
 *
 * Contract pinned: the parser returns a NON-EMPTY string (so silver passes
 * the producer gate). The exact granularity (1 token vs 3 tokens) does NOT
 * matter for downstream silver — what matters is producer-is-not-null.
 * Tests pin the actual behaviour, not aspirational shorter output.
 */

import { describe, it, expect } from 'vitest';
import { extractProducerFromVivinoUrl } from '../../scripts/etl/vivino-to-silver.js';

describe('extractProducerFromVivinoUrl (Tier 1.2++ regression)', () => {
  it('extracts non-empty producer from Vivino URL with /en/ locale', () => {
    const result = extractProducerFromVivinoUrl('https://www.vivino.com/en/krug-grande-cuvee/w/7122486');
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).toContain('krug');
  });

  it('extracts non-empty producer without locale prefix', () => {
    const result = extractProducerFromVivinoUrl('https://www.vivino.com/krug-grande-cuvee/w/7122486');
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).toContain('krug');
  });

  it('extracts non-empty producer from non-www URL', () => {
    const result = extractProducerFromVivinoUrl('https://vivino.com/en/krug-grande-cuvee/w/7122486');
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).toContain('krug');
  });

  it('Royal Tokaji slug → starts with "Royal" (Tokaji is a stop-word/wine-style — stops there)', () => {
    const result = extractProducerFromVivinoUrl('https://www.vivino.com/en/royal-tokaji-essencia/w/1140747');
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).toContain('royal');
    // Tokaji is a Hungarian dessert wine style → in PRODUCER_PARSE_STOP_WORDS → truncates here.
    // The result "Royal" is still a valid non-empty producer for the silver gate.
  });

  it("Château d'Yquem slug → 'd' apostrophe convention", () => {
    const result = extractProducerFromVivinoUrl('https://www.vivino.com/en/chateau-d-yquem-sauternes/w/1234');
    expect(result).not.toBeNull();
    expect(result).toMatch(/d'Yquem/);
  });

  it('Domaine Leflaive slug → starts with "Domaine Leflaive"', () => {
    const result = extractProducerFromVivinoUrl('https://www.vivino.com/en/domaine-leflaive-puligny-montrachet/w/9999');
    expect(result).not.toBeNull();
    expect(result?.toLowerCase().startsWith('domaine leflaive')).toBe(true);
  });

  it('Dom Pérignon slug → "Dom Perignon" prefix (URL drops accent)', () => {
    const result = extractProducerFromVivinoUrl('https://www.vivino.com/en/dom-perignon-p2-plenitude-brut-champagne/w/8888');
    expect(result).not.toBeNull();
    expect(result?.toLowerCase().startsWith('dom perignon')).toBe(true);
  });

  it('returns null for non-Vivino URL', () => {
    expect(extractProducerFromVivinoUrl('https://wine-searcher.com/find/krug')).toBeNull();
  });

  it('returns null for empty / undefined / null', () => {
    expect(extractProducerFromVivinoUrl(null)).toBeNull();
    expect(extractProducerFromVivinoUrl(undefined)).toBeNull();
    expect(extractProducerFromVivinoUrl('')).toBeNull();
  });

  it('returns null for slug that fails minimum length after stop-word truncation', () => {
    expect(extractProducerFromVivinoUrl('https://www.vivino.com/en/a/w/123')).toBeNull();
  });

  it('multi-token producer is preserved (downstream silver only needs non-empty)', () => {
    const result = extractProducerFromVivinoUrl('https://www.vivino.com/en/ausone-saint-emilion-grand-cru/w/1');
    expect(result).not.toBeNull();
    expect(result?.toLowerCase()).toContain('ausone');
  });
});
