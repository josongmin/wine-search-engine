import { describe, expect, it } from 'vitest';
import {
  GIFT_SUITABILITY_SYSTEM_PROMPT,
  buildGiftSuitabilityUserPrompt,
} from '../../scripts/etl/run-track-c-step6-gift-suitability.js';
import type { EnrichedSilverRecord } from '../../scripts/etl/types.js';
import {
  BEGINNER_SUITABILITY_SYSTEM_PROMPT as BEGINNER_PROMPT,
  buildBeginnerSuitabilityUserPrompt as buildBeginnerPrompt,
} from '../../scripts/etl/run-track-c-step7-beginner-suitability.js';

const sampleRecord = {
  canonicalLabel: 'Sample Wine',
  producer: 'Sample Producer',
  country: 'France',
  region: 'Bordeaux',
  wineType: 'red',
  priceBand: 'premium',
  classification: 'Grand Cru Classé',
  producerPrestige: 0.86,
  alcoholPct: 13.5,
  occasion: ['gift'],
  pairingTags: ['cheese'],
  flavorProfiles: ['black-fruit'],
  searchTextEn: 'Elegant red wine with structured tannin and dark fruit notes.',
  body: 0.55,
  sweetness: 0.12,
  acidity: 0.48,
  tannin: 0.61,
  grapePrimary: 'Cabernet Sauvignon',
} as unknown as EnrichedSilverRecord;

describe('track C suitability prompt contract', () => {
  it('gift scorer prompt uses explicit catalog evidence and evidence axes', () => {
    const systemPrompt = GIFT_SUITABILITY_SYSTEM_PROMPT;
    const userPrompt = buildGiftSuitabilityUserPrompt(sampleRecord);

    expect(systemPrompt).toContain('explicit catalog evidence only');
    expect(systemPrompt).toContain('do not invent label aesthetics, packaging, or social prestige');
    expect(systemPrompt).not.toContain('luxury/premium = stronger gift signal');
    expect(systemPrompt).not.toContain('natural visual appeal');
    expect(userPrompt).toContain('"evidence_axes"');
    expect(userPrompt).not.toContain('default baseline');
    expect(userPrompt).not.toContain('price_band');
  });

  it('beginner scorer prompt uses structural catalog signals instead of accessibility proxies', () => {
    const systemPrompt = BEGINNER_PROMPT;
    const userPrompt = buildBeginnerPrompt(sampleRecord);

    expect(systemPrompt).toContain('explicit catalog evidence only');
    expect(systemPrompt).toContain('do not invent accessibility from grape fame or price tier');
    expect(systemPrompt).not.toContain('sweeter wines are generally more beginner-accessible');
    expect(systemPrompt).not.toContain('well-known grapes like Merlot, Chardonnay, Pinot Grigio');
    expect(systemPrompt).not.toContain('price accessibility');
    expect(systemPrompt).not.toContain('sparkling and rosé often favored by beginners');
    expect(userPrompt).toContain('"evidence_axes"');
    expect(userPrompt).not.toContain('default baseline');
    expect(userPrompt).not.toContain('price_band');
  });
});
