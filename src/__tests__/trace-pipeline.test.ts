/**
 * Trace pipeline execution with detailed logging
 */

import { describe, it, beforeAll } from 'vitest';
import { createTestContainer } from '../../test/integration/helpers/test-container.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { retrieveHybridCandidatesForPlan } from '../application/search/search-usecase-hybrid-candidates.js';
import { buildResolverCandidatesFromPlan } from '../application/search/search-usecase-resolver-candidates.js';

type WineRecord = {
  sourceId: string;
  canonicalLabel: string;
  aliases?: {
    identitySafeProjection?: string[];
    noisyRecallProjection?: string[];
  };
  producer?: string;
  region?: string;
  grapes?: string[];
  searchTextEn?: string;
  body?: number;
  sweetness?: number;
  wineType?: string;
  priceBand?: string;
  pairingTags?: string[];
  popularityScore?: number;
  vintageYear?: number;
  acidity?: number;
  tannin?: number;
  grapePrimary?: string;
  country?: string;
  appellation?: string;
  priceUsd?: string | number;
  flavorProfiles?: string[];
  drinkingWindow?: {
    drinkingWindowStart?: string;
    drinkingWindowEnd?: string;
  };
};

const parseWineRecord = (line: string): WineRecord => {
  const parsed: unknown = JSON.parse(line);
  return parsed as WineRecord;
};

describe('Pipeline Tracing', () => {
  let container: ReturnType<typeof createTestContainer>['container'];
  let searchIndex: ReturnType<typeof createTestContainer>['searchIndex'];
  let blockingAdapter: ReturnType<typeof createTestContainer>['blockingAdapter'];
  let browseRetriever: ReturnType<typeof createTestContainer>['browseRetriever'];
  let compareRetriever: ReturnType<typeof createTestContainer>['compareRetriever'];

  beforeAll(() => {
    const testContainer = createTestContainer();
    container = testContainer.container;
    searchIndex = testContainer.searchIndex;
    blockingAdapter = testContainer.blockingAdapter;
    browseRetriever = testContainer.browseRetriever;
    compareRetriever = testContainer.compareRetriever;

    const dataPath = join(process.cwd(), 'data', 'silver-docquery.ndjson');
    const lines = readFileSync(dataPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    const wines = lines.map(parseWineRecord);
    console.error(`\n📦 Loaded ${wines.length} wines`);

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
    console.error(`✅ Indexed 20 wines, registered ${entityIds.length} entity IDs\n`);
  });

  it('should trace "David Arthur Cabernet"', async () => {
    const query = 'David Arthur Cabernet 2014';
    console.error(`\n🔍 Query: "${query}"`);

    try {
      // Step 1: Plan
      console.error('\n📋 Step 1: Query Planning');
      const plan = await container.queryPlanner.plan(query);
      console.error(`  plan exists: ${plan !== null && plan !== undefined}`);
      console.error(`  queryClass: ${plan?.queryClass}`);
      console.error(`  query_class (snake): ${(plan as any)?.query_class}`);
      console.error(`  All fields: ${Object.keys(plan || {}).join(', ')}`);
      console.error('  policy:', JSON.stringify(plan?.policy) ?? 'undefined');
      console.error(`  constraints.hard: ${plan?.constraints?.hard?.length || 0}`);
      console.error(`  constraints.soft: ${plan?.constraints?.soft?.length || 0}`);

      // Step 2: Candidate pool (sparse search)
      console.error('\n🔎 Step 2: Candidate Pool');
      const candidates = await retrieveHybridCandidatesForPlan(
        plan,
        {
          candidatePool: container.candidatePool,
          browseRetriever,
          compareRetriever,
        },
        async (resolverPlan) => {
          const candidateEntities = await buildResolverCandidatesFromPlan(resolverPlan, searchIndex);
          return container.entityResolver.resolve({
            rawQuery: resolverPlan.rawQuery,
            normalizedQuery: resolverPlan.normalizedQuery,
            ...(resolverPlan.normalizedQueryViews !== undefined
              ? { normalizedQueryViews: resolverPlan.normalizedQueryViews }
              : {}),
            queryClass: resolverPlan.queryClass,
            policy: resolverPlan.policy,
            anchorCandidates: resolverPlan.anchors,
            uncertainty: resolverPlan.uncertainty,
            candidateEntities,
          });
        },
      );
      console.error(`  Total candidates from pool: ${candidates.length}`);
      if (candidates.length > 0) {
        console.error(`  Top 3:`);
        for (const cand of candidates.slice(0, 3)) {
          console.error(
            `    - ${cand.entityId.substring(0, 20)} (fusion: ${cand.retrievalFusionScore.toFixed(2)})`,
          );
        }
      }

      // Step 3: Ranking (hybrid path bypasses entity resolver)
      console.error('\n⭐ Step 3: Ranking');
      if (candidates.length > 0) {
        const ranked = await container.ranker.rank({
          queryPlan: plan,
          candidates,
          constraints: plan.constraints,
        });
        console.error(`  Ranked: ${ranked.length} items`);
        for (const item of ranked.slice(0, 3)) {
          console.error(`    - ${item.entityId.substring(0, 20)} (score: ${item.finalScore.toFixed(2)})`);
        }
      } else {
        console.error(`  No candidates to rank`);
      }

      // Step 4: Full execute
      console.error('\n🚀 Full Pipeline Execute');
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

      console.error(`  Decision: ${result.engineDecision.decisionStatus}`);
      console.error(`  Confidence: ${result.engineDecision.decisionConfidence.toFixed(2)}`);
      console.error(`  Results: ${result.results.length}`);
      console.error(`  Next action: ${result.engineDecision.nextAction}`);
      if (result.engineDecision.failure_reason) {
        console.error(`  Failure reason: ${result.engineDecision.failure_reason}`);
      }
    } catch (err) {
      console.error(`\n❌ Error: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack.split('\n').slice(0, 5).join('\n'));
      }
    }
  });
});
