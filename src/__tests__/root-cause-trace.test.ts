/**
 * Root Cause Trace — Diagnostic Test for 0-Results Pipeline
 *
 * Systematically traces the exact flow for: "David Arthur Cabernet 2014"
 * Logs input/output at EACH stage to identify the exact break point.
 *
 * Expected data:
 * - silver-docquery.ndjson contains: 2014 David Arthur Cabernet Sauvignon (vivino-e259450bc8286296)
 * - Test indexes 100 wines and registers them with the blocking adapter
 *
 * Pipeline stages traced:
 * 1. Planner: QueryPlanV1 generation
 * 2. CandidatePool: Sparse/dense search + fusion
 * 3. Ranker: Candidate scoring and ranking
 * 4. DecisionEngine: Status/confidence decision
 * 5. ResponseBuilder: Final response construction
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestContainer } from '../../test/integration/helpers/test-container.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { SearchUseCase } from '../application/search/search.usecase.js';
import type { Container } from '../config/container.js';
import { retrieveHybridCandidatesForPlan } from '../application/search/search-usecase-hybrid-candidates.js';
import { buildResolverCandidatesFromPlan } from '../application/search/search-usecase-resolver-candidates.js';
import { buildHybridRouteResolveResult } from '../application/search/search-usecase-hybrid-route.js';
import { buildSearchDecisionInput } from '../application/search/search-usecase-decision-input.js';
import { buildDecisionSnapshotFromPlan } from '../application/search/search-usecase-decision-snapshot.js';

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

describe('Root Cause Trace: "David Arthur Cabernet 2014"', () => {
  let container: Container;
  let blockingAdapter: ReturnType<typeof createTestContainer>['blockingAdapter'];
  let searchIndex: ReturnType<typeof createTestContainer>['searchIndex'];
  let browseRetriever: ReturnType<typeof createTestContainer>['browseRetriever'];
  let compareRetriever: ReturnType<typeof createTestContainer>['compareRetriever'];

  const QUERY = 'David Arthur Cabernet 2014';
  const REQUEST_ID = 'root-cause-trace-001';

  beforeAll(() => {
    const testContainer = createTestContainer();
    container = testContainer.container;
    blockingAdapter = testContainer.blockingAdapter;
    searchIndex = testContainer.searchIndex;
    browseRetriever = testContainer.browseRetriever;
    compareRetriever = testContainer.compareRetriever;

    // Load wine data
    const dataPath = join(process.cwd(), 'data', 'silver-docquery.ndjson');
    const lines = readFileSync(dataPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    const wines = lines.map(parseWineRecord);

    // Index 100 wines
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
    console.error(`\n📦 Root Cause Trace Setup: indexed 100 wines, registered with blocking adapter\n`);
  });

  afterAll(() => {
    // Cleanup
  });

  /**
   * STEP 1: Query Planner
   * Verify that the planner produces a valid QueryPlanV1 with:
   * - Non-null queryClass
   * - Appropriate route (entity/hybrid/mixed)
   * - Anchors extracted
   */
  it('[STEP 1] Planner generates valid QueryPlanV1', async () => {
    console.error(`\n${'='.repeat(80)}`);
    console.error(`[STEP 1] PLANNER`);
    console.error('='.repeat(80));
    console.error(`Input query: "${QUERY}"`);

    const plan = await container.queryPlanner.plan(QUERY, {});

    console.error(`\nPlanner Output:`);
    console.error(`  rawQuery: ${plan.rawQuery}`);
    console.error(`  normalizedQuery: ${plan.normalizedQuery}`);
    console.error(`  queryClass: ${plan.queryClass} ${plan.queryClass ? '✅' : '❌'}`);
    console.error(`  intent: ${plan.intent}`);
    console.error(`  route: ${plan.route}`);
    console.error(`  retrievalMode: ${plan.retrievalMode}`);
    console.error(`  anchors: ${plan.anchors.length} extracted`);
    if (plan.anchors.length > 0) {
      plan.anchors.forEach((a, i) => {
        console.error(`    [${i}] ${a.value} (confidence: ${a.confidence.toFixed(3)})`);
      });
    }
    console.error(`  constraints.hard: ${plan.constraints.hard.length}`);
    console.error(`  constraints.soft: ${plan.constraints.soft.length}`);

    // Assertions
    expect(plan.queryClass).toBeDefined();
    expect(plan.queryClass).not.toBeNull();
    expect(plan.route).toBeDefined();
    expect(['entity', 'hybrid', 'mixed']).toContain(plan.route);

    // Store plan for next steps
    return plan;
  });

  /**
   * STEP 2: Candidate Pool (Sparse/Dense Search + Fusion)
   * Verify that CandidatePool finds candidates via hybrid retrieval:
   * - Sparse search results
   * - Dense search results
   * - Fused candidates count
   */
  it('[STEP 2] CandidatePool generates HybridCandidate[]', async () => {
    console.error(`\n${'='.repeat(80)}`);
    console.error(`[STEP 2] CANDIDATE POOL`);
    console.error('='.repeat(80));

    const plan = await container.queryPlanner.plan(QUERY, {});

    console.error(`\nRetrieval Input:`);
    console.error(`  lexicalQueries: [${plan.normalizedQuery}]`);
    console.error(`  semanticQueries: [${plan.rawQuery}]`);
    console.error(`  hardConstraints: ${plan.constraints.hard.length}`);
    console.error(`  softConstraints: ${plan.constraints.soft.length}`);

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

    console.error(`\nCandidate Pool Output:`);
    console.error(`  Total candidates: ${candidates.length}`);
    if (candidates.length === 0) {
      console.error(`  ❌ NO CANDIDATES RETURNED`);
    } else {
      candidates.slice(0, 5).forEach((c, i) => {
        console.error(`  [${i}] ${c.entityId} (${c.canonicalLabel})`);
        console.error(`      Sparse Rank: ${c.sparseRank ?? 'N/A'}`);
        console.error(`      Dense Rank: ${c.denseRank ?? 'N/A'}`);
        console.error(`      Fusion Score: ${c.retrievalFusionScore.toFixed(3)}`);
      });
      if (candidates.length > 5) {
        console.error(`  ... and ${candidates.length - 5} more`);
      }
    }

    // Assertions
    expect(candidates).toBeDefined();
    expect(Array.isArray(candidates)).toBe(true);

    // Check if David Arthur is in candidates
    const davidArthurFound = candidates.some((c) =>
      String(c.canonicalLabel).toLowerCase().includes('david arthur'),
    );
    console.error(`\n  David Arthur found in candidates: ${davidArthurFound ? '✅' : '❌'}`);

    return candidates;
  });

  /**
   * STEP 3: Ranker
   * Verify that Ranker produces RankedResult[] with scores:
   * - Component scores populated
   * - Final scores assigned
   * - Ranking order
   */
  it('[STEP 3] Ranker scores and ranks candidates', async () => {
    console.error(`\n${'='.repeat(80)}`);
    console.error(`[STEP 3] RANKER`);
    console.error('='.repeat(80));

    const plan = await container.queryPlanner.plan(QUERY, {});

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

    const rankingInput = {
      queryPlan: plan,
      candidates,
      constraints: plan.constraints,
    };

    console.error(`\nRanking Input:`);
    console.error(`  Candidates to rank: ${rankingInput.candidates.length}`);
    console.error(`  Query class: ${rankingInput.queryPlan.queryClass}`);

    const rankedResults = await container.ranker.rank(rankingInput);

    console.error(`\nRanker Output:`);
    console.error(`  Total ranked results: ${rankedResults.length}`);
    if (rankedResults.length === 0) {
      console.error(`  ❌ NO RANKED RESULTS`);
    } else {
      rankedResults.slice(0, 5).forEach((r, i) => {
        console.error(`  [${i}] ${r.entityId} (${r.canonicalLabel})`);
        console.error(`      Final Score: ${r.finalScore.toFixed(4)}`);
        console.error(`      Semantic: ${r.componentScores.semantic.toFixed(3)}`);
        console.error(`      Hard Constraint: ${r.componentScores.hardConstraintPass ? '✅' : '❌'}`);
        console.error(`      Uncertainty Penalty: ${r.componentScores.uncertaintyPenalty.toFixed(3)}`);
      });
      if (rankedResults.length > 5) {
        console.error(`  ... and ${rankedResults.length - 5} more`);
      }
    }

    // Assertions
    expect(rankedResults).toBeDefined();
    expect(Array.isArray(rankedResults)).toBe(true);

    const davidArthurRanked = rankedResults.find((r) =>
      r.canonicalLabel.toLowerCase().includes('david arthur'),
    );
    console.error(`\n  David Arthur ranked: ${davidArthurRanked ? '✅' : '❌'}`);
    if (davidArthurRanked) {
      console.error(`    Final Score: ${davidArthurRanked.finalScore.toFixed(4)}`);
      console.error(`    Rank: ${davidArthurRanked.rank}`);
    }

    return rankedResults;
  });

  /**
   * STEP 4: Decision Engine
   * Verify that DecisionEngine processes the decision:
   * - Loads thresholds
   * - Applies numeric gate
   * - Produces decision status + confidence
   */
  it('[STEP 4] DecisionEngine makes decision', async () => {
    console.error(`\n${'='.repeat(80)}`);
    console.error(`[STEP 4] DECISION ENGINE`);
    console.error('='.repeat(80));

    const plan = await container.queryPlanner.plan(QUERY, {});

    // Build synthetic resolver result (as the SearchUseCase does for hybrid route)
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

    const rankingInput = {
      queryPlan: plan,
      candidates,
      constraints: plan.constraints,
    };

    const rankedResults = await container.ranker.rank(rankingInput);

    const resolveResult = buildHybridRouteResolveResult(plan, rankedResults);

    console.error(`\nResolver Result (synthetic for hybrid):`);
    console.error(`  Status: ${resolveResult.status}`);
    console.error(`  Candidates count: ${resolveResult.candidates.length}`);
    console.error(`  Decision Confidence C: ${(resolveResult.decisionConfidenceC ?? 0).toFixed(4)}`);
    console.error(`  Top1 Score: ${resolveResult.decisionTrace.top1CalibratedScore.toFixed(4)}`);
    console.error(`  Top2 Score: ${resolveResult.decisionTrace.top2CalibratedScore.toFixed(4)}`);
    console.error(`  Calibrated Gap: ${resolveResult.decisionTrace.calibratedGap.toFixed(4)}`);
    console.error(`  Ambiguity Detected: ${resolveResult.decisionTrace.ambiguityDetected}`);

    const topResult = rankedResults[0];
    const decisionInput = buildSearchDecisionInput(plan, resolveResult, rankedResults, 'hybrid');

    console.error(`\nDecision Input:`);
    console.error(`  Policy fallback mode: ${decisionInput.policy.fallbackMode}`);
    console.error(`  Uncertainty decision effect: ${decisionInput.uncertainty.decisionEffect ?? 'none'}`);
    console.error(`  Identity evidence present: ${decisionInput.evidenceSummary.identityEvidencePresent}`);
    console.error(`  Ranking signals present: ${decisionInput.rankingSignals !== undefined ? '✅' : '❌'}`);
    if (decisionInput.rankingSignals) {
      console.error(`    semantic_relevance_score: ${decisionInput.rankingSignals.semantic_relevance_score.toFixed(3)}`);
      console.error(`    hard_constraint_pass: ${decisionInput.rankingSignals.hard_constraint_pass}`);
    }

    // Run decision engine
    const snapshot = buildDecisionSnapshotFromPlan(plan);

    const decisionOutput = await container.decisionEngine.decide(decisionInput, snapshot);

    console.error(`\nDecision Engine Output:`);
    console.error(`  Decision Status: ${decisionOutput.decisionStatus}`);
    console.error(`  Decision Confidence: ${decisionOutput.decisionConfidence.toFixed(4)}`);
    console.error(`  Confidence Semantics: ${decisionOutput.confidenceSemantics}`);
    console.error(`  Next Action: ${decisionOutput.nextAction}`);
    console.error(`  Route: ${decisionOutput.route}`);
    console.error(`  Failure Reason: ${decisionOutput.failure_reason ?? 'N/A'}`);
    console.error(`\n  Rules Applied:`);
    decisionOutput.decisionTrace.rulesApplied.forEach((rule) => {
      console.error(`    - ${rule}`);
    });

    // Assertions
    expect(decisionOutput).toBeDefined();
    expect(['resolved', 'ambiguous', 'failed']).toContain(decisionOutput.decisionStatus);

    return { decisionOutput, rankedResults };
  });

  /**
   * STEP 5: Full Pipeline End-to-End
   * Run the complete SearchUseCase and examine the response.
   */
  it('[STEP 5] SearchUseCase.execute() — Full Pipeline', async () => {
    console.error(`\n${'='.repeat(80)}`);
    console.error(`[STEP 5] FULL PIPELINE — SearchUseCase.execute()`);
    console.error('='.repeat(80));
    console.error(`Query: "${QUERY}"`);
    console.error(`Request ID: ${REQUEST_ID}`);

    const response = await container.searchUseCase.execute(
      {
        query: QUERY,
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      REQUEST_ID,
    );

    console.error(`\nSearchResponse Output:`);
    console.error(`  Decision Status: ${response.engineDecision.decisionStatus}`);
    console.error(`  Decision Confidence: ${response.engineDecision.decisionConfidence.toFixed(4)}`);
    console.error(`  Confidence Semantics: ${response.engineDecision.confidenceSemantics}`);
    console.error(`  Route: ${response.engineDecision.route}`);
    console.error(`  Failure Reason: ${response.engineDecision.failure_reason ?? 'N/A'}`);
    console.error(`  Results Count: ${response.results.length} ${response.results.length > 0 ? '✅' : '❌'}`);

    if (response.results.length > 0) {
      console.error(`\n  Top 5 Results:`);
      response.results.slice(0, 5).forEach((r, i) => {
        console.error(`    [${i}] ${r.entity.entityId} (${r.entity.canonicalLabel})`);
        console.error(`        Score: ${r.relevanceScore.toFixed(4)}`);
      });
    }

    console.error(`\n  Decision Trace:`);
    if (response.engineDecision.decisionTrace) {
      const trace = response.engineDecision.decisionTrace;
      console.error(`    Query Class: ${trace.queryClass}`);
      console.error(`    Top1 Score: ${trace.top1CalibratedScore?.toFixed(4) ?? 'N/A'}`);
      console.error(`    Calibrated Gap: ${trace.calibratedGap?.toFixed(4) ?? 'N/A'}`);
      console.error(`    Ambiguity Detected: ${trace.ambiguityDetected ?? 'N/A'}`);
      console.error(`    Rules Applied: ${trace.rulesApplied?.join(', ') ?? 'N/A'}`);
    }

    console.error(`\n  Metadata:`);
    console.error(`    Request ID: ${response.meta.requestId}`);
    console.error(`    Query Time Ms: ${response.meta.queryTimeMs}`);
    console.error(`    Route: ${response.meta.route}`);

    // Assertions
    expect(response).toBeDefined();
    expect(response.engineDecision).toBeDefined();
    expect(response.meta).toBeDefined();

    const davidArthurFound = response.results.some((r) =>
      String(r.entity.canonicalLabel).toLowerCase().includes('david arthur'),
    );
    console.error(`\n  David Arthur in results: ${davidArthurFound ? '✅' : '❌'}`);

    // DIAGNOSTIC: Log why status is not resolved
    if (response.engineDecision.decisionStatus !== 'resolved') {
      console.error(`\n  ⚠️ DIAGNOSTIC: Decision Status is NOT 'resolved'`);
      console.error(`     Confidence: ${response.engineDecision.decisionConfidence.toFixed(4)}`);
      console.error(`     Expected confidence threshold: >= 0.60 (approx)`);
      console.error(`     This indicates the pipeline found candidates but confidence was too low.`);
    }

    return response;
  });

  /**
   * SUMMARY: Pinpoint the exact failure mode
   */
  it('[SUMMARY] Root Cause Analysis', async () => {
    console.error(`\n${'='.repeat(80)}`);
    console.error(`[SUMMARY] ROOT CAUSE ANALYSIS`);
    console.error('='.repeat(80));

    const response = await container.searchUseCase.execute(
      {
        query: QUERY,
        options: {
          mode: 'auto',
          explain: false,
          clarification: false,
        },
      },
      REQUEST_ID,
    );

    const plan = await container.queryPlanner.plan(QUERY, {});
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

    console.error(`\nTrace Summary:`);
    console.error(`  1. Planner produces queryClass: ${plan.queryClass} ✅`);
    console.error(`  2. CandidatePool finds: ${candidates.length} candidates ${candidates.length > 0 ? '✅' : '❌'}`);

    if (candidates.length > 0) {
      const rankingInput = {
        queryPlan: plan,
        candidates,
        constraints: plan.constraints,
      };
      const rankedResults = await container.ranker.rank(rankingInput);

      console.error(`  3. Ranker produces: ${rankedResults.length} ranked results ${rankedResults.length > 0 ? '✅' : '❌'}`);

      if (rankedResults.length > 0) {
        const topScore = rankedResults[0]?.finalScore ?? 0;
        console.error(`  4. Top result score: ${topScore.toFixed(4)}`);
        console.error(`  5. Final response: ${response.engineDecision.decisionStatus} (confidence: ${response.engineDecision.decisionConfidence.toFixed(4)})`);
      }
    }

    console.error(`\n${response.results.length === 0 ? '❌' : '✅'} Final Result: ${response.results.length} items returned`);

    if (response.results.length === 0) {
      console.error(`\nROOT CAUSE: ${response.engineDecision.failure_reason ?? response.engineDecision.decisionStatus}`);
      console.error(`  Decision Confidence: ${response.engineDecision.decisionConfidence.toFixed(4)}`);
      console.error(`  This suggests: ${
        response.engineDecision.decisionStatus === 'ambiguous'
          ? 'Decision engine downgraded to AMBIGUOUS (confidence too low, gap threshold, or policy)'
          : response.engineDecision.decisionStatus === 'failed'
            ? 'Decision engine produced FAILED status (no confidence or policy block)'
            : 'Unknown status'
      }`);
    }

    expect(response).toBeDefined();
  });
});
