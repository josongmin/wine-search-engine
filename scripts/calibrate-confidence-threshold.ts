#!/usr/bin/env tsx
/**
 * Confidence Threshold Calibration Script (Epic 17.3).
 *
 * Analyzes an eval dataset with decision confidence scores to find the optimal
 * confidence threshold that:
 * 1. Catches most hallucinations (refusal_rate >= 0.90 at C < threshold)
 * 2. Minimizes false refusals (false_refusal_rate <= 0.05 at C >= threshold)
 *
 * Input format (NDJSON): Each line must have:
 * - decisionConfidenceC or resolver_confidence: calibrated decision confidence
 * - expected_entity_id: the gold/expected entity
 * - top1_entity_id: the top result entity returned by system
 *
 * Outputs:
 * - ROC curve (confidence threshold vs. refusal rate) to stdout
 * - Suggested threshold (AURC-calibrated operating point)
 * - Trade-off analysis
 * - JSON results if --output is specified
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/calibrate-confidence-threshold.ts [--input data/eval-output.jsonl] [--output calibration-results.json]
 *
 * To generate eval output with confidence scores, run:
 *   npx tsx --env-file=.env scripts/eval/run-offline-eval.ts --output data/eval-output.jsonl
 *
 * Reference: RFC-016 §3 (AdmissionGate), Epic 17.3 (Hallucination Verify)
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import { parseNdjson } from './etl/ndjson.js';
import type { GoldenQuery } from './etl/types.js';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface CalibrationPoint {
  threshold: number;
  correctRefusals: number; // Wrong cases correctly refused
  totalWrong: number;
  falseRefusals: number; // Correct cases incorrectly refused
  totalCorrect: number;
  refusalRate: number; // % of wrong cases refused
  falseRefusalRate: number; // % of correct cases refused
}

interface CalibrationResult {
  totalQueries: number;
  correctQueries: number;
  wrongQueries: number;
  rocCurve: readonly CalibrationPoint[];
  suggestedThreshold: number;
  metricsAtSuggested: CalibrationPoint;
  targetOperatingPoint: {
    minRefusalRate: number;
    maxFalseRefusalRate: number;
  };
}

// ────────────────────────────────────────────────────────────────
// Main calibration logic
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let inputPath: string | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input') {
      inputPath = args[i + 1]!;
      i++;
    } else if (args[i] === '--output') {
      outputPath = args[i + 1]!;
      i++;
    }
  }

  if (!inputPath) {
    console.error('[Calibrate] ERROR: No input file specified.');
    console.error('[Calibrate] Usage: npx tsx scripts/calibrate-confidence-threshold.ts --input <file.jsonl> [--output results.json]');
    console.error('[Calibrate] Example: npx tsx scripts/calibrate-confidence-threshold.ts --input data/eval-output.jsonl');
    process.exit(1);
  }

  console.log(`[Calibrate] Loading queries from ${inputPath}...`);

  const content = await fs.readFile(inputPath, 'utf-8');
  const { records: queries, skipped } = parseNdjson<GoldenQuery>(content, inputPath);

  if (queries.length === 0) {
    console.error('[Calibrate] ERROR: No queries loaded. Check file format and path.');
    process.exit(1);
  }

  console.log(`[Calibrate] Loaded ${queries.length} queries (${skipped} skipped)`);

  // Extract cases: classify as correct/wrong based on expected vs. top1
  const cases = queries
    .map((q) => {
      // Skip queries without confidence scores
      if (q.decisionConfidenceC === undefined && q.resolver_confidence === undefined) {
        return null;
      }

      const C = q.decisionConfidenceC ?? q.resolver_confidence ?? 0.5;
      const expectedEntity = q.expected_entity_id;
      const top1Entity = q.top1_entity_id;

      // Determine if the search result is correct
      const isCorrect = expectedEntity !== undefined && expectedEntity === top1Entity;

      return { C, isCorrect };
    })
    .filter((c) => c !== null) as Array<{ C: number; isCorrect: boolean }>;

  const correctCases = cases.filter((c) => c.isCorrect);
  const wrongCases = cases.filter((c) => !c.isCorrect);

  console.log(`[Calibrate] Extracted ${cases.length} cases with confidence scores`);
  console.log(`  - Correct: ${correctCases.length}`);
  console.log(`  - Wrong: ${wrongCases.length}`);

  if (wrongCases.length === 0) {
    console.error(
      '[Calibrate] ERROR: No wrong cases found. Cannot calibrate without hallucination examples.',
    );
    process.exit(1);
  }

  // Generate threshold points
  const thresholds = generateThresholdPoints(0, 1, 21);

  // Compute ROC curve
  const rocCurve = thresholds.map((threshold) => {
    const correctRefusals = wrongCases.filter((c) => c.C < threshold).length;
    const falseRefusals = correctCases.filter((c) => c.C < threshold).length;

    return {
      threshold,
      correctRefusals,
      totalWrong: wrongCases.length,
      falseRefusals,
      totalCorrect: correctCases.length,
      refusalRate: correctCases.length > 0 ? correctRefusals / wrongCases.length : 0,
      falseRefusalRate:
        correctCases.length > 0 ? falseRefusals / correctCases.length : 0,
    };
  });

  // Find suggested threshold (operating point that meets both constraints)
  const suggestedThreshold = findSuggestedThreshold(rocCurve);
  const metricsAtSuggested =
    rocCurve.find((p) => p.threshold === suggestedThreshold) || rocCurve[0]!;

  const result: CalibrationResult = {
    totalQueries: queries.length,
    correctQueries: correctCases.length,
    wrongQueries: wrongCases.length,
    rocCurve,
    suggestedThreshold,
    metricsAtSuggested,
    targetOperatingPoint: {
      minRefusalRate: 0.9,
      maxFalseRefusalRate: 0.05,
    },
  };

  // Print ROC curve to stdout
  printRocCurve(rocCurve, suggestedThreshold);

  // Print detailed metrics
  console.log(`\n[Calibrate] Suggested threshold: ${suggestedThreshold.toFixed(4)}`);
  console.log(
    `[Calibrate]   - Refusal rate: ${(metricsAtSuggested.refusalRate * 100).toFixed(1)}% (target >= 90%)`
  );
  console.log(
    `[Calibrate]   - False refusal rate: ${(metricsAtSuggested.falseRefusalRate * 100).toFixed(1)}% (target <= 5%)`
  );

  // Output JSON if requested
  if (outputPath) {
    const jsonOutput = JSON.stringify(result, null, 2);
    await fs.writeFile(outputPath, jsonOutput);
    console.log(`\n[Calibrate] Wrote results to ${outputPath}`);
  }

  // Exit with status
  const meetsTargets =
    metricsAtSuggested.refusalRate >= 0.9 &&
    metricsAtSuggested.falseRefusalRate <= 0.05;
  if (!meetsTargets) {
    console.warn(
      '[Calibrate] WARNING: Suggested threshold does not meet both targets. Consider tuning thresholds.',
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function generateThresholdPoints(min: number, max: number, count: number): number[] {
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + i * step);
}

function findSuggestedThreshold(rocCurve: readonly CalibrationPoint[]): number {
  // Find the threshold that:
  // 1. Achieves refusal_rate >= 0.90 (catches hallucinations)
  // 2. Minimizes false_refusal_rate (doesn't block good searches)
  // 3. If multiple thresholds work, pick the one with lowest false_refusal_rate

  const candidates = rocCurve.filter(
    (p) => p.refusalRate >= 0.9 && p.falseRefusalRate <= 0.05,
  );

  if (candidates.length > 0) {
    // Pick the one with lowest false refusal rate
    return candidates.reduce((best, current) =>
      current.falseRefusalRate < best.falseRefusalRate ? current : best,
    ).threshold;
  }

  // If no threshold perfectly meets both targets, find the best compromise
  // using a weighted distance metric
  return rocCurve.reduce((best, current) => {
    const refusalGap = Math.max(0, 0.9 - current.refusalRate); // Penalty for missing target
    const falseRefusalPenalty = Math.max(0, current.falseRefusalRate - 0.05); // Penalty for exceeding target
    const score = refusalGap * 2 + falseRefusalPenalty; // Weight refusal rate 2x

    const bestRefusalGap = Math.max(0, 0.9 - best.refusalRate);
    const bestFalseRefusalPenalty = Math.max(0, best.falseRefusalRate - 0.05);
    const bestScore = bestRefusalGap * 2 + bestFalseRefusalPenalty;

    return score < bestScore ? current : best;
  }).threshold;
}

function printRocCurve(
  rocCurve: readonly CalibrationPoint[],
  suggestedThreshold: number,
): void {
  console.log('\n[Calibrate] ROC Curve (Confidence Threshold vs. Refusal Metrics)');
  console.log(
    '────────────────────────────────────────────────────────────────────────────',
  );
  console.log(
    'Threshold  | Refusal Rate | False Refusal | Caught Wrong | False Blocked | Suggested',
  );
  console.log(
    '────────────────────────────────────────────────────────────────────────────',
  );

  rocCurve.forEach((point) => {
    const isSelected = Math.abs(point.threshold - suggestedThreshold) < 0.001;
    const marker = isSelected ? '← SELECTED' : '';

    const thresholdStr = point.threshold.toFixed(3);
    const refusalStr = (point.refusalRate * 100).toFixed(1).padStart(5);
    const falseRefusalStr = (point.falseRefusalRate * 100).toFixed(1).padStart(5);
    const caughtStr = `${point.correctRefusals}/${point.totalWrong}`;
    const blockedStr = `${point.falseRefusals}/${point.totalCorrect}`;

    console.log(
      `${thresholdStr}    | ${refusalStr}%     | ${falseRefusalStr}%      | ${caughtStr.padEnd(13)} | ${blockedStr.padEnd(13)} | ${marker}`,
    );
  });

  console.log(
    '────────────────────────────────────────────────────────────────────────────',
  );
}

// ────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[Calibrate] Error:', err);
  process.exit(1);
});
