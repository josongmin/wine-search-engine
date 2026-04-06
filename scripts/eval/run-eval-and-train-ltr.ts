/**
 * Complete evaluation and LTR training pipeline.
 *
 * Orchestrates:
 * 1. Load eval cases from database
 * 2. Run evaluation against search pipeline
 * 3. Collect results
 * 4. Train LambdaMART models per query class
 * 5. Store trained models
 * 6. Produce evaluation report with LTR metrics
 *
 * Epic 3 + Epic 4: Eval baseline + LambdaMART training
 */

import { Pool } from 'pg';
import { EvalRunner } from '../../src/domain/evaluation/service/eval-runner.js';
import { PgGoldSetStore } from '../../src/infrastructure/adapter/pg-gold-set-store.js';
import { PgEvalResultStore } from '../../src/infrastructure/adapter/pg-eval-result-store.js';
import { SearchPipelineEvaluator } from '../../src/infrastructure/adapter/search-pipeline-evaluator.js';
import { buildTrainingExamples, trainAllModels } from '../../src/domain/ranking/training.js';
import { PgLtrModelRegistry } from '../../src/infrastructure/adapter/pg-ltr-model-registry.js';
import type { SearchUseCase } from '../../src/application/search/search.usecase.js';

/**
 * Main evaluation pipeline.
 *
 * @param searchUseCase - The wired SearchUseCase (from container).
 * @param pool - Postgres pool instance (caller manages lifecycle).
 */
async function runEvaluationAndTraining(
  searchUseCase: SearchUseCase,
  pool: Pool,
): Promise<void> {
  {
    console.log('🚀 Starting Evaluation + LTR Training Pipeline\n');
    console.log('='.repeat(60));

    // Step 1: Load evaluation cases
    console.log('\n📖 Step 1: Loading evaluation cases from database...');
    const goldSetStore = new PgGoldSetStore(pool);
    const cases = await goldSetStore.getCases();
    console.log(`   ✓ Loaded ${cases.length} evaluation cases`);

    // Distribution by query class
    const classDistribution = new Map<string, number>();
    for (const c of cases) {
      classDistribution.set(c.queryClass, (classDistribution.get(c.queryClass) ?? 0) + 1);
    }
    console.log('\n   Query class distribution:');
    for (const [queryClass, count] of Array.from(classDistribution.entries()).sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`     ${queryClass}: ${count} cases`);
    }

    // Distribution by label tier
    const tierDistribution = new Map<string, number>();
    for (const c of cases) {
      tierDistribution.set(c.labelTier, (tierDistribution.get(c.labelTier) ?? 0) + 1);
    }
    console.log('\n   Label tier distribution:');
    for (const [tier, count] of tierDistribution.entries()) {
      console.log(`     ${tier}: ${count} cases`);
    }

    // Step 2: Run evaluation
    console.log('\n📊 Step 2: Running evaluation...');
    const evalResultStore = new PgEvalResultStore(pool);
    const searchPipeline = new SearchPipelineEvaluator(searchUseCase);
    const evalRunner = new EvalRunner(goldSetStore, evalResultStore, searchPipeline);

    const evalReport = await evalRunner.run();
    console.log(`   ✓ Evaluated ${evalReport.caseCount} cases`);

    // Summary metrics
    console.log('\n   📈 Overall metrics:');
    console.log(`     Decision Utility: ${evalReport.overallMetrics.decisionUtility.toFixed(3)}`);
    console.log(`     Correct Resolve Rate: ${(evalReport.overallMetrics.correctResolveRate * 100).toFixed(1)}%`);
    console.log(`     Wrong Resolve Rate: ${(evalReport.overallMetrics.wrongResolveRate * 100).toFixed(2)}%`);
    console.log(`     Safe Abstain Rate: ${(evalReport.overallMetrics.safeAbstainRate * 100).toFixed(1)}%`);
    console.log(`     Expected Calibration Error (ECE): ${evalReport.overallMetrics.ece.toFixed(3)}`);

    // Release gate status
    console.log('\n   🚪 Release Gate Results:');
    if (evalReport.releaseGateResult.passed) {
      console.log('     ✅ ALL GATES PASSED');
    } else {
      console.log('     ❌ SOME GATES FAILED:');
      for (const gate of evalReport.releaseGateResult.gates) {
        if (!gate.passed) {
          console.log(
            `        ${gate.name}: ${gate.actual.toFixed(3)} (threshold: ${gate.threshold})`,
          );
        }
      }
    }

    // Step 3: Build training examples from evaluation results
    console.log('\n🧠 Step 3: Building LambdaMART training examples...');
    const results = await evalResultStore.getResults();
    const examples = buildTrainingExamples(results, cases);
    console.log(`   ✓ Built ${examples.length} training examples`);

    // Step 4: Train LambdaMART models per query class
    console.log('\n🎓 Step 4: Training LambdaMART models...');
    if (examples.length > 0) {
      const models = trainAllModels(examples);

      if (models.size > 0) {
        console.log(`   ✓ Trained models for ${models.size} query classes`);

        // Step 5: Store trained models in registry
        console.log('\n💾 Step 5: Persisting trained models to database...');
        const modelRegistry = new PgLtrModelRegistry(pool);

        let storedCount = 0;
        for (const [queryClass, weights] of models.entries()) {
          await modelRegistry.saveModel(queryClass, weights);
          storedCount++;
          console.log(
            `   ✓ Stored model for ${queryClass} (NDCG@5: ${weights.ndcg5ValidationScore.toFixed(3)})`,
          );
        }

        console.log(`   ✓ Persisted ${storedCount} models to ltr_model_registry`);
      } else {
        console.log('   ⚠️  No models trained (insufficient examples per class)');
      }
    } else {
      console.log('   ⚠️  No training examples generated (eval results needed)');
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ Evaluation + LTR Training Pipeline Complete\n');
    console.log('📋 Summary:');
    console.log(`   • Evaluation Cases: ${cases.length}`);
    console.log(`   • Evaluation Status: ${evalReport.releaseGateResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   • Query Classes: ${classDistribution.size}`);
    console.log('');
  }
}

// Entry point (for CLI use)
// Usage: npx tsx scripts/eval/run-eval-and-train-ltr.ts
// Requires: PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD env vars
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    // Bootstrap the DI container to get a wired SearchUseCase
    const { config } = await import('../../src/config/env.js');
    const { createContainer } = await import('../../src/config/container.js');
    const { getPgPool } = await import('../../src/infrastructure/db/pg-pool.js');

    const pool = getPgPool();
    const container = await createContainer(config, pool);

    await runEvaluationAndTraining(container.searchUseCase, pool);
    await pool.end();
  })().catch((err: unknown) => {
    console.error('❌ Pipeline failed:', err);
    process.exit(1);
  });
}

export { runEvaluationAndTraining };
