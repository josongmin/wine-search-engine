#!/usr/bin/env node

/**
 * Track C (ETL Pipeline) Orchestrator
 *
 * Executes the full Track C enrichment pipeline in sequence:
 * 1. generate-critic-proxy.ts - LLM-based critic proxy scores
 * 2. enrich-certifications.ts - Wikidata SPARQL + LLM fallback for certs
 * 3. generate-pairings.ts - Claude-based food pairing taxonomy normalization
 * 4. drinking-window-backfill.ts - LightGBM-based drinking window predictions
 *
 * SOTA++ improvements over v1:
 * - Advisory file lock prevents concurrent runs
 * - Early record-count validation (fail fast before LLM spend)
 * - Per-step field validation on ALL records (not just sample)
 * - Backup-before-write safety in each step
 * - Structured run metadata for audit trail
 *
 * Usage: npx tsx --env-file=.env scripts/etl/run-track-c.ts [--from-step N]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { acquireLock, backupFile } from './etl-utils.js';

const DATA_FILE = resolveDataPath('data/silver-docquery.ndjson');
const LOCK_FILE = resolveDataPath('.etl-track-c.lock');
const MIN_RECORDS_FOR_TRACK_C = 100; // fail fast: don't spend LLM credits on tiny datasets

function getFileSize(filePath: string): string {
  const stats = fs.statSync(filePath);
  const mb = (stats.size / 1024 / 1024).toFixed(1);
  return `${mb}MB`;
}

function getRecordCount(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.trim().split('\n').filter((line) => line.length > 0).length;
}

/**
 * Checks field coverage across ALL records (not just the first sample).
 * Returns the fraction of records that have the field defined and non-null.
 */
function fieldCoverage(fieldName: string): { present: number; total: number; ratio: number } {
  const content = fs.readFileSync(DATA_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter((line) => line.length > 0);
  let present = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record[fieldName] != null) present++;
    } catch {
      // Skip malformed lines
    }
  }
  return { present, total: lines.length, ratio: lines.length > 0 ? present / lines.length : 0 };
}

function parseFromStep(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-step') {
      const n = parseInt(argv[i + 1] ?? '', 10);
      return Number.isNaN(n) ? 1 : Math.max(1, Math.min(4, n));
    }
  }
  return 1;
}

async function runStep(
  stepNum: number,
  scriptName: string,
  description: string,
  outputField: string,
): Promise<boolean> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Step ${stepNum}: ${description}`);
  console.log(`${'='.repeat(70)}`);

  const scriptPath = path.resolve(`./scripts/etl/${scriptName}`);
  if (!fs.existsSync(scriptPath)) {
    console.error(`  Script not found: ${scriptPath}`);
    return false;
  }

  // Backup before step execution
  await backupFile(DATA_FILE);

  console.log(`  Script: ${scriptName}`);
  console.log(`  Before: ${getRecordCount(DATA_FILE)} records, ${getFileSize(DATA_FILE)}`);

  try {
    console.log(`  Running step ${stepNum}...`);
    const startTime = Date.now();

    execSync(`npx tsx --env-file=.env ${scriptPath}`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Validate output field across ALL records (not just first sample)
    const coverage = fieldCoverage(outputField);
    if (coverage.present === 0) {
      console.warn(
        `  Step ${stepNum} completed but output field "${outputField}" not found in any record`,
      );
      return false;
    }

    console.log(
      `  Step ${stepNum} complete (${elapsed}s). ` +
      `Field "${outputField}": ${coverage.present}/${coverage.total} records ` +
      `(${(coverage.ratio * 100).toFixed(1)}%)`,
    );
    console.log(`  After: ${getRecordCount(DATA_FILE)} records, ${getFileSize(DATA_FILE)}`);
    return true;
  } catch (error) {
    console.error(
      `  Step ${stepNum} failed:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function main() {
  console.log('');
  console.log('=' .repeat(70));
  console.log('  Track C (ETL Pipeline) Orchestrator');
  console.log('='.repeat(70));

  // Validate input
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`  Input file not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const fromStep = parseFromStep(process.argv.slice(2));
  if (fromStep > 1) {
    console.log(`  Resuming from step ${fromStep} (--from-step)`);
  }

  // Early validation: fail fast before spending LLM credits
  const initialRecordCount = getRecordCount(DATA_FILE);
  if (initialRecordCount < MIN_RECORDS_FOR_TRACK_C) {
    console.error(
      `  Record count ${initialRecordCount} < ${MIN_RECORDS_FOR_TRACK_C}. ` +
      `Too few records for Track C enrichment — check upstream Silver pipeline.`,
    );
    process.exit(1);
  }

  const initialSize = getFileSize(DATA_FILE);

  console.log(`\n  Input Statistics:`);
  console.log(`   File: ${DATA_FILE}`);
  console.log(`   Records: ${initialRecordCount}`);
  console.log(`   Size: ${initialSize}`);
  console.log(`   Date: ${new Date().toISOString()}`);

  // Acquire advisory lock
  let unlock: (() => Promise<void>) | null = null;
  try {
    unlock = await acquireLock(LOCK_FILE);
  } catch (e) {
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const startTime = Date.now();
  const results: Array<{
    step: number;
    name: string;
    success: boolean;
  }> = [];

  try {
    const steps = [
      {
        num: 1,
        script: 'run-track-c-step1.ts',
        desc: 'Generate Critic Proxy Scores',
        field: 'criticProxy',
      },
      {
        num: 2,
        script: 'run-track-c-step2.ts',
        desc: 'Enrich Certifications (Wikidata + LLM)',
        field: 'certifications',
      },
      {
        num: 3,
        script: 'run-track-c-step3.ts',
        desc: 'Generate Food Pairings (Claude)',
        field: 'pairingTags',
      },
      {
        num: 4,
        script: 'drinking-window-backfill.ts',
        desc: 'Drinking Window Backfill (LightGBM)',
        field: 'drinkingWindow',
      },
    ];

    for (const step of steps) {
      if (step.num < fromStep) {
        console.log(`\n  Skipping step ${step.num} (--from-step ${fromStep})`);
        results.push({ step: step.num, name: step.desc, success: true });
        continue;
      }

      const success = await runStep(
        step.num,
        step.script,
        step.desc,
        step.field,
      );
      results.push({
        step: step.num,
        name: step.desc,
        success,
      });

      if (!success) {
        console.warn(
          `\n  Step ${step.num} failed. Continuing with next step.`,
        );
      }

      // Verify record count hasn't changed (data integrity check)
      const currentCount = getRecordCount(DATA_FILE);
      if (currentCount !== initialRecordCount) {
        console.error(
          `  INTEGRITY ERROR: Record count changed from ${initialRecordCount} to ${currentCount} after step ${step.num}. Aborting.`,
        );
        results.push({ step: step.num, name: step.desc, success: false });
        break; // Stop pipeline — data integrity violation
      }
    }
  } finally {
    // Always release lock
    if (unlock) await unlock();
  }

  // Final report
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const finalRecordCount = getRecordCount(DATA_FILE);
  const finalSize = getFileSize(DATA_FILE);

  console.log(`\n${'='.repeat(70)}`);
  console.log('  Track C Pipeline Summary');
  console.log(`${'='.repeat(70)}`);

  console.log(`\nInput:`);
  console.log(`  Records: ${initialRecordCount}`);
  console.log(`  Size: ${initialSize}`);

  console.log(`\nOutput:`);
  console.log(`  Records: ${finalRecordCount}`);
  console.log(`  Size: ${finalSize}`);

  console.log(`\nSteps Completed:`);
  for (const result of results) {
    const icon = result.success ? 'OK' : 'FAIL';
    console.log(`  [${icon}] Step ${result.step}: ${result.name}`);
  }

  const allPassed = results.every((r) => r.success);

  console.log(`\nExecution Time: ${elapsed} minutes`);
  console.log(`File: ${DATA_FILE}`);

  if (allPassed) {
    console.log(`\n  Track C Complete! Data ready for Vespa indexing.`);
  } else {
    console.log(`\n  Some steps failed. Use --from-step N to resume.`);
  }

  console.log(`\n${'='.repeat(70)}\n`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
