/**
 * Live search test against silver-docquery.ndjson
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createTestContainer } from '../../test/integration/helpers/test-container.js';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Live Search — silver-docquery.ndjson', () => {
  let container: ReturnType<typeof createTestContainer>['container'];
  let searchIndex: ReturnType<typeof createTestContainer>['searchIndex'];

  beforeAll(() => {
    const testContainer = createTestContainer();
    container = testContainer.container;
    searchIndex = testContainer.searchIndex;
    const { blockingAdapter } = testContainer;

    // Load and index wine data
    const dataPath = join(process.cwd(), 'data', 'silver-docquery.ndjson');
    const lines = readFileSync(dataPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    const wines = lines.map((line) => JSON.parse(line));
    console.log(`\n📦 Loaded ${wines.length} wines`);

    // Index first 100 wines for test
    const entityIds: string[] = [];
    for (const wine of wines.slice(0, 100)) {
      entityIds.push(wine.sourceId);
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
        // Optional fields from data
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
    }

    // Register entities with blocking adapter
    blockingAdapter.addEntityIds(entityIds);
    console.log('✅ Indexed 100 wines\n');
  });

  it('should find Napa Cabernet', async () => {
    const result = await container.searchUseCase.execute(
      {
        query: 'Napa Cabernet under $100',
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      'test-napa',
    );

    console.log(`\n🔍 "Napa Cabernet under $100"`);
    console.log(`   Decision: ${result.engineDecision.decisionStatus}`);
    console.log(`   Confidence: ${result.engineDecision.decisionConfidence.toFixed(2)}`);
    console.log(`   Results: ${result.results.length}`);

    if (result.results.length > 0) {
      console.log(`   Top: ${result.results[0].entityId} (${result.results[0].score.toFixed(2)})`);
    }

    expect(result.engineDecision.decisionStatus).toBeDefined();
  });

  it('should find French Burgundy', async () => {
    const result = await container.searchUseCase.execute(
      {
        query: 'French Burgundy Pinot Noir premium',
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      'test-burgundy',
    );

    console.log(`\n🔍 "French Burgundy Pinot Noir premium"`);
    console.log(`   Decision: ${result.engineDecision.decisionStatus}`);
    console.log(`   Confidence: ${result.engineDecision.decisionConfidence.toFixed(2)}`);
    console.log(`   Results: ${result.results.length}`);

    if (result.results.length > 0) {
      console.log(`   Top: ${result.results[0].entityId} (${result.results[0].score.toFixed(2)})`);
    }

    expect(result.engineDecision.decisionStatus).toBeDefined();
  });

  it('should handle Spanish wine search', async () => {
    const result = await container.searchUseCase.execute(
      {
        query: 'Spanish Tempranillo Ribera del Duero',
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      'test-spanish',
    );

    console.log(`\n🔍 "Spanish Tempranillo Ribiera del Duero"`);
    console.log(`   Decision: ${result.engineDecision.decisionStatus}`);
    console.log(`   Confidence: ${result.engineDecision.decisionConfidence.toFixed(2)}`);
    console.log(`   Results: ${result.results.length}`);

    if (result.results.length > 0) {
      console.log(`   Top: ${result.results[0].entityId} (${result.results[0].score.toFixed(2)})`);
    }

    expect(result.engineDecision.decisionStatus).toBeDefined();
  });

  it('should handle price constraint "sweet white wine under $30"', async () => {
    const result = await container.searchUseCase.execute(
      {
        query: 'sweet white wine under $30',
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      'test-sweet-white',
    );

    console.log(`\n🔍 "sweet white wine under $30"`);
    console.log(`   Decision: ${result.engineDecision.decisionStatus}`);
    console.log(`   Confidence: ${result.engineDecision.decisionConfidence.toFixed(2)}`);
    console.log(`   Results: ${result.results.length}`);

    if (result.results.length > 0) {
      console.log(`   Top: ${result.results[0].entityId} (${result.results[0].score.toFixed(2)})`);
    }

    expect(result.engineDecision.decisionStatus).toBeDefined();
  });

  it('should handle ambiguous query with clarification', async () => {
    const result = await container.searchUseCase.execute(
      {
        query: 'red wine',
        options: {
          mode: 'auto',
          explain: false,
          clarification: true,
        },
      },
      'test-red-wine',
    );

    console.log(`\n🔍 "red wine" (with clarification)`);
    console.log(`   Decision: ${result.engineDecision.decisionStatus}`);
    console.log(`   Confidence: ${result.engineDecision.decisionConfidence.toFixed(2)}`);
    console.log(`   Results: ${result.results.length}`);
    console.log(`   Action: ${result.engineDecision.nextAction}`);

    if (result.clarification) {
      console.log(`   Clarification needed: ${result.clarification.type}`);
    }

    expect(result.engineDecision.decisionStatus).toBeDefined();
  });
});
