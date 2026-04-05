/**
 * Trace pipeline execution with detailed logging
 */

import { describe, it, beforeAll } from 'vitest';
import { createTestContainer } from '../../test/integration/helpers/test-container.js';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Pipeline Tracing', () => {
  let container: ReturnType<typeof createTestContainer>['container'];
  let searchIndex: ReturnType<typeof createTestContainer>['searchIndex'];
  let blockingAdapter: ReturnType<typeof createTestContainer>['blockingAdapter'];

  beforeAll(() => {
    const testContainer = createTestContainer();
    container = testContainer.container;
    searchIndex = testContainer.searchIndex;
    blockingAdapter = testContainer.blockingAdapter;

    const dataPath = join(process.cwd(), 'data', 'silver-docquery.ndjson');
    const lines = readFileSync(dataPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    const wines = lines.map((line) => JSON.parse(line));
    console.log(`\n📦 Loaded ${wines.length} wines`);

    const entityIds: string[] = [];
    for (const wine of wines.slice(0, 20)) {
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
    blockingAdapter.addEntityIds(entityIds);
    console.log(`✅ Indexed 20 wines, registered ${entityIds.length} entity IDs\n`);
  });

  it('should trace "David Arthur Cabernet"', async () => {
    const query = 'David Arthur Cabernet 2014';
    console.log(`\n🔍 Query: "${query}"`);

    try {
      // Step 1: Plan
      console.log('\n📋 Step 1: Query Planning');
      const plan = await container.queryPlanner.plan(query);
      console.log(`  plan exists: ${plan !== null && plan !== undefined}`);
      console.log(`  queryClass: ${plan?.queryClass}`);
      console.log(`  query_class (snake): ${(plan as any)?.query_class}`);
      console.log(`  All fields: ${Object.keys(plan || {}).join(', ')}`);
      console.log(`  policy: ${plan?.policy}`);
      console.log(`  constraints.hard: ${plan?.constraints?.hard?.length || 0}`);
      console.log(`  constraints.soft: ${plan?.constraints?.soft?.length || 0}`);

      // Step 2: Candidate pool (sparse search)
      console.log('\n🔎 Step 2: Candidate Pool');
      const candidates = await container.candidatePool.generate(plan);
      console.log(`  Total candidates from pool: ${candidates.length}`);
      if (candidates.length > 0) {
        console.log(`  Top 3:`);
        for (const cand of candidates.slice(0, 3)) {
          console.log(`    - ${cand.entityId.substring(0, 20)} (score: ${cand.score.toFixed(2)})`);
        }
      }

      // Step 3: Resolve
      console.log('\n🎯 Step 3: Entity Resolver');
      const resolved = await container.entityResolver.resolve(candidates, plan);
      console.log(`  selectedEntity: ${resolved.selectedEntity?.entityId || 'none'}`);
      console.log(`  confidenceC: ${resolved.calibratedConfidenceC.toFixed(2)}`);
      console.log(`  ambiguityFlag: ${resolved.ambiguityFlag}`);
      console.log(`  candidates returned: ${resolved.candidates.length}`);

      // Step 4: Ranking
      console.log('\n⭐ Step 4: Ranking');
      if (resolved.candidates.length > 0) {
        const ranked = await container.ranker.rank(resolved.candidates);
        console.log(`  Ranked: ${ranked.length} items`);
        for (const item of ranked.slice(0, 3)) {
          console.log(`    - ${item.entityId.substring(0, 20)} (score: ${item.score.toFixed(2)})`);
        }
      } else {
        console.log(`  No candidates to rank`);
      }

      // Full execute
      console.log('\n🚀 Full Pipeline Execute');
      const result = await container.searchUseCase.execute(
        {
          query,
          options: {
            mode: 'auto',
            explain: false,
            clarification: false,
          },
        },
        `trace-${Date.now()}`,
      );

      console.log(`  Decision: ${result.engineDecision.decisionStatus}`);
      console.log(`  Confidence: ${result.engineDecision.decisionConfidence.toFixed(2)}`);
      console.log(`  Results: ${result.results.length}`);
      console.log(`  Next action: ${result.engineDecision.nextAction}`);
      if (result.engineDecision.failureReason) {
        console.log(`  Failure reason: ${result.engineDecision.failureReason}`);
      }
    } catch (err) {
      console.log(`\n❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        console.log(err.stack.split('\n').slice(0, 5).join('\n'));
      }
    }
  });
});
