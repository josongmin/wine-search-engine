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

describe('Root Cause Trace: "David Arthur Cabernet 2014"', () => {
  let container: Container;
  let blockingAdapter: ReturnType<typeof createTestContainer>['blockingAdapter'];
  let searchIndex: ReturnType<typeof createTestContainer>['searchIndex'];

  const QUERY = 'David Arthur Cabernet 2014';
  const REQUEST_ID = 'root-cause-trace-001';

  beforeAll(() => {
    const testContainer = createTestContainer();
    container = testContainer.container;
    blockingAdapter = testContainer.blockingAdapter;
    searchIndex = testContainer.searchIndex;

    // Load wine data
    const dataPath = join(process.cwd(), 'data', 'silver-docquery.ndjson');
    const lines = readFileSync(dataPath, 'utf-8')
      .split('\n')
      .filter((line) => line.trim());

    const wines = lines.map((line) => JSON.parse(line));

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
    console.log(`\n📦 Root Cause Trace Setup: indexed 100 wines, registered with blocking adapter\n`);
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
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[STEP 1] PLANNER`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Input query: "${QUERY}"`);

    const plan = await container.queryPlanner.plan(QUERY, {});

    console.log(`\nPlanner Output:`);
    console.log(`  rawQuery: ${plan.rawQuery}`);
    console.log(`  normalizedQuery: ${plan.normalizedQuery}`);
    console.log(`  queryClass: ${plan.queryClass} ${plan.queryClass ? '✅' : '❌'}`);
    console.log(`  intent: ${plan.intent}`);
    console.log(`  route: ${plan.route}`);
    console.log(`  retrievalMode: ${plan.retrievalMode}`);
    console.log(`  anchors: ${plan.anchors.length} extracted`);
    if (plan.anchors.length > 0) {
      plan.anchors.forEach((a, i) => {
        console.log(`    [${i}] ${a.value} (confidence: ${a.confidence.toFixed(3)})`);
      });
    }
    console.log(`  constraints.hard: ${plan.constraints.hard.length}`);
    console.log(`  constraints.soft: ${plan.constraints.soft.length}`);

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
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[STEP 2] CANDIDATE POOL`);
    console.log(`${'='.repeat(80)}`);

    const plan = await container.queryPlanner.plan(QUERY, {});

    const retrievalInput = {
      queryPlan: plan,
      route: 'hybrid' as const,
      lexicalQueries: [plan.normalizedQuery],
      semanticQueries: [plan.rawQuery],
      hardConstraints: plan.constraints.hard,
      softConstraints: plan.constraints.soft,
    };

    console.log(`\nRetrieval Input:`);
    console.log(`  lexicalQueries: [${retrievalInput.lexicalQueries.join(', ')}]`);
    console.log(`  semanticQueries: [${retrievalInput.semanticQueries.join(', ')}]`);
    console.log(`  hardConstraints: ${retrievalInput.hardConstraints.length}`);
    console.log(`  softConstraints: ${retrievalInput.softConstraints.length}`);

    const candidates = await container.candidatePool.generate(retrievalInput);

    console.log(`\nCandidate Pool Output:`);
    console.log(`  Total candidates: ${candidates.length}`);
    if (candidates.length === 0) {
      console.log(`  ❌ NO CANDIDATES RETURNED`);
    } else {
      candidates.slice(0, 5).forEach((c, i) => {
        console.log(`  [${i}] ${c.entityId} (${c.canonicalLabel})`);
        console.log(`      BM25 Score: ${c.bm25Score?.toFixed(3) ?? 'N/A'}`);
        console.log(`      Dense Score: ${c.denseScore?.toFixed(3) ?? 'N/A'}`);
        console.log(`      Fusion Score: ${c.fusionScore?.toFixed(3) ?? 'N/A'}`);
      });
      if (candidates.length > 5) {
        console.log(`  ... and ${candidates.length - 5} more`);
      }
    }

    // Assertions
    expect(candidates).toBeDefined();
    expect(Array.isArray(candidates)).toBe(true);

    // Check if David Arthur is in candidates
    const davidArthurFound = candidates.some((c) =>
      c.canonicalLabel.toLowerCase().includes('david arthur'),
    );
    console.log(`\n  David Arthur found in candidates: ${davidArthurFound ? '✅' : '❌'}`);

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
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[STEP 3] RANKER`);
    console.log(`${'='.repeat(80)}`);

    const plan = await container.queryPlanner.plan(QUERY, {});

    const retrievalInput = {
      queryPlan: plan,
      route: 'hybrid' as const,
      lexicalQueries: [plan.normalizedQuery],
      semanticQueries: [plan.rawQuery],
      hardConstraints: plan.constraints.hard,
      softConstraints: plan.constraints.soft,
    };

    const candidates = await container.candidatePool.generate(retrievalInput);

    const rankingInput = {
      queryPlan: plan,
      candidates,
      constraints: plan.constraints,
    };

    console.log(`\nRanking Input:`);
    console.log(`  Candidates to rank: ${rankingInput.candidates.length}`);
    console.log(`  Query class: ${rankingInput.queryPlan.queryClass}`);

    const rankedResults = await container.ranker.rank(rankingInput);

    console.log(`\nRanker Output:`);
    console.log(`  Total ranked results: ${rankedResults.length}`);
    if (rankedResults.length === 0) {
      console.log(`  ❌ NO RANKED RESULTS`);
    } else {
      rankedResults.slice(0, 5).forEach((r, i) => {
        console.log(`  [${i}] ${r.entityId} (${r.canonicalLabel})`);
        console.log(`      Final Score: ${r.finalScore.toFixed(4)}`);
        console.log(`      Semantic: ${r.componentScores.semantic.toFixed(3)}`);
        console.log(`      Hard Constraint: ${r.componentScores.hardConstraintPass ? '✅' : '❌'}`);
        console.log(`      Uncertainty Penalty: ${r.componentScores.uncertaintyPenalty.toFixed(3)}`);
      });
      if (rankedResults.length > 5) {
        console.log(`  ... and ${rankedResults.length - 5} more`);
      }
    }

    // Assertions
    expect(rankedResults).toBeDefined();
    expect(Array.isArray(rankedResults)).toBe(true);

    const davidArthurRanked = rankedResults.find((r) =>
      r.canonicalLabel.toLowerCase().includes('david arthur'),
    );
    console.log(`\n  David Arthur ranked: ${davidArthurRanked ? '✅' : '❌'}`);
    if (davidArthurRanked) {
      console.log(`    Final Score: ${davidArthurRanked.finalScore.toFixed(4)}`);
      console.log(`    Rank: ${davidArthurRanked.rank}`);
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
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[STEP 4] DECISION ENGINE`);
    console.log(`${'='.repeat(80)}`);

    const plan = await container.queryPlanner.plan(QUERY, {});

    // Build synthetic resolver result (as the SearchUseCase does for hybrid route)
    const retrievalInput = {
      queryPlan: plan,
      route: 'hybrid' as const,
      lexicalQueries: [plan.normalizedQuery],
      semanticQueries: [plan.rawQuery],
      hardConstraints: plan.constraints.hard,
      softConstraints: plan.constraints.soft,
    };

    const candidates = await container.candidatePool.generate(retrievalInput);

    const rankingInput = {
      queryPlan: plan,
      candidates,
      constraints: plan.constraints,
    };

    const rankedResults = await container.ranker.rank(rankingInput);

    // Build resolver result (hybrid route — per search.usecase.ts:354-377)
    const top1Score = rankedResults[0]?.finalScore ?? 0;
    const top2Score = rankedResults[1]?.finalScore ?? 0;
    const hybridConfidence = Math.max(0, Math.min(1, top1Score));
    const hybridGap = Math.max(0, Math.min(1, top1Score - top2Score));

    // RFC-016: Include topEntity from top-ranked result for AdmissionGate
    const topResult = rankedResults[0];
    const topEntity = topResult ? {
      entityId: topResult.entityId,
      canonicalLabel: topResult.canonicalLabel,
    } : undefined;

    const resolveResult = {
      status: rankedResults.length > 0 ? 'resolved' as const : 'failed' as const,
      topEntity,
      candidates: [],
      decisionConfidenceC: hybridConfidence,
      decisionTrace: {
        queryClass: plan.queryClass,
        top1CalibratedScore: hybridConfidence,
        top2CalibratedScore: Math.max(0, Math.min(1, top2Score)),
        calibratedGap: hybridGap,
        decisionConfidenceC: hybridConfidence,
        ambiguityDetected: false,
        ambiguityTypes: [] as string[],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: ['HYBRID_ROUTE'],
      },
      conformalSetSize: 1,
    };

    console.log(`\nResolver Result (synthetic for hybrid):`);
    console.log(`  Status: ${resolveResult.status}`);
    console.log(`  Candidates count: ${resolveResult.candidates.length}`);
    console.log(`  Decision Confidence C: ${resolveResult.decisionConfidenceC.toFixed(4)}`);
    console.log(`  Top1 Score: ${resolveResult.decisionTrace.top1CalibratedScore.toFixed(4)}`);
    console.log(`  Top2 Score: ${resolveResult.decisionTrace.top2CalibratedScore.toFixed(4)}`);
    console.log(`  Calibrated Gap: ${resolveResult.decisionTrace.calibratedGap.toFixed(4)}`);
    console.log(`  Ambiguity Detected: ${resolveResult.decisionTrace.ambiguityDetected}`);

    // Build decision input (topResult already defined above)
    // const topResult = rankedResults[0];
    const rankingSignals = topResult
      ? {
          entity_integrity_score: topResult.componentScores.entityIntegrity,
          hard_constraint_pass: topResult.componentScores.hardConstraintPass ? 1 : 0,
          soft_constraint_score: topResult.componentScores.softConstraint,
          semantic_relevance_score: topResult.componentScores.semantic,
          preference_alignment_score: topResult.componentScores.preferenceAlignment,
          popularity_score: topResult.componentScores.popularity,
          availability_score: topResult.componentScores.availability,
          uncertainty_penalty: topResult.componentScores.uncertaintyPenalty,
        }
      : undefined;

    const identityEvidencePresent =
      (rankedResults.length > 0 && rankedResults.length > 0) ||
      false;

    const decisionInput = {
      queryPlan: plan,
      resolverResult: resolveResult,
      policy: plan.policy,
      uncertainty: plan.uncertainty,
      ...(rankingSignals !== undefined ? { rankingSignals } : {}),
      evidenceSummary: {
        identityEvidencePresent,
        ...(topResult !== undefined
          ? {
              constraintEvidencePresent: topResult.componentScores.hardConstraintPass,
              evidenceRefCount: topResult.evidenceItems.length,
            }
          : {}),
      },
      ...(topResult !== undefined ? { evidenceItems: topResult.evidenceItems } : {}),
      conformalSetSize: resolveResult.conformalSetSize,
    };

    console.log(`\nDecision Input:`);
    console.log(`  Policy fallback mode: ${decisionInput.policy.fallbackMode}`);
    console.log(`  Uncertainty decision effect: ${decisionInput.uncertainty.decisionEffect ?? 'none'}`);
    console.log(`  Identity evidence present: ${decisionInput.evidenceSummary.identityEvidencePresent}`);
    console.log(`  Ranking signals present: ${rankingSignals !== undefined ? '✅' : '❌'}`);
    if (rankingSignals) {
      console.log(`    semantic_relevance_score: ${rankingSignals.semantic_relevance_score.toFixed(3)}`);
      console.log(`    hard_constraint_pass: ${rankingSignals.hard_constraint_pass}`);
    }

    // Run decision engine
    const snapshot = {
      model_versions: {},
      index_versions: {},
      policy_rule_version: '1',
      threshold_profile_id: 'default',
      planner_version: 'test',
      feature_flags: {},
    };

    const decisionOutput = await container.decisionEngine.decide(decisionInput, snapshot);

    console.log(`\nDecision Engine Output:`);
    console.log(`  Decision Status: ${decisionOutput.decisionStatus}`);
    console.log(`  Decision Confidence: ${decisionOutput.decisionConfidence.toFixed(4)}`);
    console.log(`  Confidence Semantics: ${decisionOutput.confidenceSemantics}`);
    console.log(`  Next Action: ${decisionOutput.nextAction}`);
    console.log(`  Route: ${decisionOutput.route}`);
    console.log(`  Failure Reason: ${decisionOutput.failure_reason ?? 'N/A'}`);
    console.log(`\n  Rules Applied:`);
    decisionOutput.decisionTrace.rulesApplied.forEach((rule) => {
      console.log(`    - ${rule}`);
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
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[STEP 5] FULL PIPELINE — SearchUseCase.execute()`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Query: "${QUERY}"`);
    console.log(`Request ID: ${REQUEST_ID}`);

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

    console.log(`\nSearchResponse Output:`);
    console.log(`  Decision Status: ${response.engineDecision.decisionStatus}`);
    console.log(`  Decision Confidence: ${response.engineDecision.decisionConfidence.toFixed(4)}`);
    console.log(`  Confidence Semantics: ${response.engineDecision.confidenceSemantics}`);
    console.log(`  Route: ${response.engineDecision.route}`);
    console.log(`  Failure Reason: ${response.engineDecision.failure_reason ?? 'N/A'}`);
    console.log(`  Results Count: ${response.results.length} ${response.results.length > 0 ? '✅' : '❌'}`);

    if (response.results.length > 0) {
      console.log(`\n  Top 5 Results:`);
      response.results.slice(0, 5).forEach((r, i) => {
        console.log(`    [${i}] ${r.entity.entityId} (${r.entity.canonicalLabel})`);
        console.log(`        Score: ${r.relevanceScore.toFixed(4)}`);
      });
    }

    console.log(`\n  Decision Trace:`);
    if (response.engineDecision.decisionTrace) {
      const trace = response.engineDecision.decisionTrace;
      console.log(`    Query Class: ${trace.queryClass}`);
      console.log(`    Top1 Score: ${trace.top1CalibratedScore?.toFixed(4) ?? 'N/A'}`);
      console.log(`    Calibrated Gap: ${trace.calibratedGap?.toFixed(4) ?? 'N/A'}`);
      console.log(`    Ambiguity Detected: ${trace.ambiguityDetected ?? 'N/A'}`);
      console.log(`    Rules Applied: ${trace.rulesApplied?.join(', ') ?? 'N/A'}`);
    }

    console.log(`\n  Metadata:`);
    console.log(`    Request ID: ${response.meta.requestId}`);
    console.log(`    Query Time Ms: ${response.meta.queryTimeMs}`);
    console.log(`    Route: ${response.meta.route}`);

    // Assertions
    expect(response).toBeDefined();
    expect(response.engineDecision).toBeDefined();
    expect(response.meta).toBeDefined();

    const davidArthurFound = response.results.some((r) =>
      r.entity.canonicalLabel.toLowerCase().includes('david arthur'),
    );
    console.log(`\n  David Arthur in results: ${davidArthurFound ? '✅' : '❌'}`);

    // DIAGNOSTIC: Log why status is not resolved
    if (response.engineDecision.decisionStatus !== 'resolved') {
      console.log(`\n  ⚠️ DIAGNOSTIC: Decision Status is NOT 'resolved'`);
      console.log(`     Confidence: ${response.engineDecision.decisionConfidence.toFixed(4)}`);
      console.log(`     Expected confidence threshold: >= 0.60 (approx)`);
      console.log(`     This indicates the pipeline found candidates but confidence was too low.`);
    }

    return response;
  });

  /**
   * SUMMARY: Pinpoint the exact failure mode
   */
  it('[SUMMARY] Root Cause Analysis', async () => {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[SUMMARY] ROOT CAUSE ANALYSIS`);
    console.log(`${'='.repeat(80)}`);

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
    const retrievalInput = {
      queryPlan: plan,
      route: 'hybrid' as const,
      lexicalQueries: [plan.normalizedQuery],
      semanticQueries: [plan.rawQuery],
      hardConstraints: plan.constraints.hard,
      softConstraints: plan.constraints.soft,
    };

    const candidates = await container.candidatePool.generate(retrievalInput);

    console.log(`\nTrace Summary:`);
    console.log(`  1. Planner produces queryClass: ${plan.queryClass} ✅`);
    console.log(`  2. CandidatePool finds: ${candidates.length} candidates ${candidates.length > 0 ? '✅' : '❌'}`);

    if (candidates.length > 0) {
      const rankingInput = {
        queryPlan: plan,
        candidates,
        constraints: plan.constraints,
      };
      const rankedResults = await container.ranker.rank(rankingInput);

      console.log(`  3. Ranker produces: ${rankedResults.length} ranked results ${rankedResults.length > 0 ? '✅' : '❌'}`);

      if (rankedResults.length > 0) {
        const topScore = rankedResults[0]?.finalScore ?? 0;
        console.log(`  4. Top result score: ${topScore.toFixed(4)}`);
        console.log(`  5. Final response: ${response.engineDecision.decisionStatus} (confidence: ${response.engineDecision.decisionConfidence.toFixed(4)})`);
      }
    }

    console.log(`\n${response.results.length === 0 ? '❌' : '✅'} Final Result: ${response.results.length} items returned`);

    if (response.results.length === 0) {
      console.log(`\nROOT CAUSE: ${response.engineDecision.failure_reason ?? response.engineDecision.decisionStatus}`);
      console.log(`  Decision Confidence: ${response.engineDecision.decisionConfidence.toFixed(4)}`);
      console.log(`  This suggests: ${
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
