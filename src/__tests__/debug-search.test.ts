/**
 * Debug search index to verify indexing and sparse search
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContainer } from '../../test/integration/helpers/test-container.js';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Debug Search Index', () => {
  let searchIndex: ReturnType<typeof createTestContainer>['searchIndex'];

  beforeAll(() => {
    const testContainer = createTestContainer();
    searchIndex = testContainer.searchIndex;

    const dataPath = join(process.cwd(), 'data', 'silver-docquery.ndjson');
    const lines = readFileSync(dataPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    const wines = lines.map((line) => JSON.parse(line));
    console.log(`\n📦 Loaded ${wines.length} wines`);

    // Index first 10 wines
    for (const wine of wines.slice(0, 10)) {
      searchIndex.upsertDoc({
        entityId: wine.sourceId,
        entityType: 'wine',
        canonicalLabel: wine.canonicalLabel,
        aliasesIdentitySafe: wine.aliases?.identitySafeProjection || [],
        aliasesNoisyRecall: wine.aliases?.noisyRecallProjection || [],
        producer: wine.producer || '',
        region: wine.region || '',
        grapes: wine.grapes || [],
        searchTextKo: '',
        searchTextEn: wine.searchTextEn || '',
        semanticSummary: wine.searchTextEn?.slice(0, 500) || '',
        body: wine.body || 0.5,
        sweetness: wine.sweetness || 0.5,
        style: wine.wineType ? `${wine.wineType} wine` : 'wine',
        priceBand: wine.priceBand || 'value',
        pairing: wine.pairingTags || [],
        occasion: [],
        availability: true,
        popularityScore: wine.popularityScore || 0,
        vintageYear: wine.vintageYear,
        acidity: wine.acidity,
        tannin: wine.tannin,
        wineType: wine.wineType,
        grapePrimary: wine.grapePrimary,
        country: wine.country,
        appellation: wine.appellation,
        priceUsd: wine.priceUsd ? parseFloat(String(wine.priceUsd)) : undefined,
        flavorProfiles: wine.flavorProfiles,
        drinkingWindowStart: wine.drinkingWindow?.drinkingWindowStart,
        drinkingWindowEnd: wine.drinkingWindow?.drinkingWindowEnd,
      });
      console.log(`  Indexed: ${wine.canonicalLabel.substring(0, 40)}`);
    }
    console.log('✅ Indexed 10 wines\n');
  });

  it('should find wines with sparse search', async () => {
    console.log('🔍 Testing sparse search...');
    const hits = await searchIndex.sparseSearch(['Napa', 'Cabernet'], undefined, 10);
    console.log(`Found ${hits.length} hits for ["Napa", "Cabernet"]`);
    for (const hit of hits) {
      console.log(
        `  - ID: ${hit.entityId.substring(0, 20)} (score: ${hit.score.toFixed(2)}, rank: ${hit.rank})`,
      );
    }
    expect(hits.length).toBeGreaterThan(0);
  });

  it('should find wines with single term', async () => {
    console.log('\n🔍 Testing single term search...');
    const hits = await searchIndex.sparseSearch(['wine'], undefined, 10);
    console.log(`Found ${hits.length} hits for ["wine"]`);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('should find Serafin wine', async () => {
    console.log('\n🔍 Testing Serafin search...');
    const hits = await searchIndex.sparseSearch(['Serafin'], undefined, 10);
    console.log(`Found ${hits.length} hits for ["Serafin"]`);
    for (const hit of hits) {
      console.log(
        `  - ID: ${hit.entityId.substring(0, 20)} (score: ${hit.score.toFixed(2)}, rank: ${hit.rank})`,
      );
    }
    expect(hits.length).toBeGreaterThan(0);
  });
});
