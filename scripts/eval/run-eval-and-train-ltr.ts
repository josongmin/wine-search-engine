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
import { LTRTrainingService, createModelRegistry } from '../../src/domain/ranking/index.js';
import type { SearchUseCase } from '../../src/domain/search/search.usecase.js';

/**
 * Main evaluation pipeline.
 */
async function runEvaluationAndTraining(
  searchUseCase: SearchUseCase,
  databaseUrl: string = process.env.DATABASE_URL || 'postgresql://localhost/wine-search',
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
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

    // Step 3: Build training examples
    console.log('\n🧠 Step 3: Building LambdaMART training examples...');
    // For now, use a synthetic approach: create examples from evaluation results
    // In production, this would extract ranking features from the actual retrieval pipeline

    // Step 4: Train LambdaMART models
    console.log('\n🎓 Step 4: Training LambdaMART models...');
    // Create synthetic training examples for demo
    const examples = LTRTrainingService.buildTrainingExamples([], cases);

    if (examples.length > 0) {
      const models = LTRTrainingService.trainAllModels(examples);
      const modelRegistry = createModelRegistry(models);

      console.log(`   ✓ Trained models for ${models.size} query classes`);
      console.log(`     Mean NDCG@5: ${modelRegistry.trainingMetrics.meanNdcg5.toFixed(3)}`);
      console.log(`     Min NDCG@5: ${modelRegistry.trainingMetrics.minNdcg5.toFixed(3)}`);
      console.log(`     Max NDCG@5: ${modelRegistry.trainingMetrics.maxNdcg5.toFixed(3)}`);
      console.log(`     Total Training Examples: ${modelRegistry.trainingMetrics.totalExamples}`);

      // Store model metadata
      console.log('\n💾 Step 5: Storing model registry...');
      await pool.query(
        `INSERT INTO ltr_model_registry (
          model_id, version, trained_at, training_metrics
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (model_id) DO UPDATE SET
          trained_at = $3,
          training_metrics = $4`,
        [
          modelRegistry.modelId,
          modelRegistry.version,
          modelRegistry.trainedAt,
          JSON.stringify(modelRegistry.trainingMetrics),
        ],
      );
      console.log(`   ✓ Stored model registry: ${modelRegistry.modelId}`);
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
  } finally {
    await pool.end();
  }
}

// Entry point (for CLI use)
if (import.meta.url === `file://${process.argv[1]}`) {
  runEvaluationAndTraining().catch((err) => {
    console.error('❌ Pipeline failed:', err);
    process.exit(1);
  });
}

export { runEvaluationAndTraining };
