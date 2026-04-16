#!/usr/bin/env node

/**
 * Track C (ETL Pipeline) Orchestrator
 *
 * Consumes `data/silver-docquery.ndjson`, seeds `data/silver-trackc.ndjson`,
 * and executes the full Track C enrichment pipeline in sequence:
 * 1. generate-critic-proxy.ts - LLM-based critic proxy scores
 * 2. enrich-certifications.ts - Wikidata SPARQL + LLM fallback for certs
 * 3. generate-pairings.ts - Claude-based food pairing taxonomy normalization
 * 4. run-track-c-step4-occasion.ts - ontology-constrained occasion classification
 * 5. drinking-window-backfill.ts - heuristic stub (opt-in only)
 * 6. run-track-c-step6-gift-suitability.ts - LLM-based gift suitability scoring
 * 7. run-track-c-step7-beginner-suitability.ts - LLM-based beginner suitability scoring
 *
 * SOTA++ improvements over v1:
 * - Advisory file lock prevents concurrent runs
 * - Early record-count validation (fail fast before LLM spend)
 * - Per-step field validation on ALL records (not just sample)
 * - Backup-before-write safety in each step
 * - Structured run metadata for audit trail
 *
 * Usage: pnpm exec tsx --env-file=.env scripts/etl/run-track-c.ts [--from-step N]
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { acquireLock, backupFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

export const TRACK_C_SOURCE_FILE = ETL_ARTIFACT_FILES.docquery;
export const TRACK_C_OUTPUT_FILE = ETL_ARTIFACT_FILES.trackc;
export const TRACK_C_SOURCE_STATE_FILE = resolveDataPath('.silver-trackc.source-state.json');
const LOCK_FILE = resolveDataPath('.etl-track-c.lock');
const MIN_RECORDS_FOR_TRACK_C = 100; // fail fast: don't spend LLM credits on tiny datasets

export interface TrackCStepDefinition {
  readonly num: number;
  readonly script: string;
  readonly desc: string;
  readonly field: string;
  /** Minimum coverage ratio required before the step is considered passable. */
  readonly requiredCoverage?: number;
}

export const TRACK_C_STEP_DEFINITIONS: readonly TrackCStepDefinition[] = [
  {
    num: 1,
    script: 'run-track-c-step1.ts',
    desc: 'Generate Critic Proxy Scores',
    field: 'criticProxy',
    requiredCoverage: 1,
  },
  {
    num: 2,
    script: 'run-track-c-step2.ts',
    desc: 'Enrich Certifications (Wikidata + LLM)',
    field: 'certifications',
    requiredCoverage: 1,
  },
  {
    num: 3,
    script: 'run-track-c-step3.ts',
    desc: 'Generate Food Pairings (Claude)',
    field: 'pairingTags',
    requiredCoverage: 1,
  },
  {
    num: 4,
    script: 'run-track-c-step4-occasion.ts',
    desc: 'Classify Occasion Tags (Ontology + LLM)',
    field: 'occasionClassification',
    requiredCoverage: 0,
  },
  {
    num: 5,
    script: 'drinking-window-backfill.ts',
    desc: 'Drinking Window Backfill (Heuristic Stub, Opt-In)',
    field: 'drinkingWindow',
    requiredCoverage: 1,
  },
  {
    num: 6,
    script: 'run-track-c-step6-gift-suitability.ts',
    desc: 'Score Gift Suitability (LLM Teacher Label)',
    field: 'giftSuitabilityClassification',
    requiredCoverage: 0.7,
  },
  {
    num: 7,
    script: 'run-track-c-step7-beginner-suitability.ts',
    desc: 'Score Beginner Suitability (LLM Teacher Label)',
    field: 'beginnerSuitabilityClassification',
    requiredCoverage: 0.7,
  },
] as const;

export const TRACK_C_TOTAL_STEPS = TRACK_C_STEP_DEFINITIONS.length;

export interface TrackCSourceState {
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly sourceRecordCount: number;
}

function getFileSize(filePath: string): string {
  const stats = fs.statSync(filePath);
  const mb = (stats.size / 1024 / 1024).toFixed(1);
  return `${mb}MB`;
}

function getRecordCount(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.trim().split('\n').filter((line) => line.length > 0).length;
}

function getRecordCountFromContent(content: string): number {
  return content.trim().split('\n').filter((line) => line.length > 0).length;
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function buildTrackCSourceState(sourcePath: string, content: string): TrackCSourceState {
  return {
    sourcePath,
    sourceHash: hashContent(content),
    sourceRecordCount: getRecordCountFromContent(content),
  };
}

function readTrackCSourceState(statePath: string): TrackCSourceState {
  const raw = fs.readFileSync(statePath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Invalid Track C source state at ${statePath}`);
  }
  const rec = parsed as Record<string, unknown>;
  if (
    typeof rec.sourcePath !== 'string'
    || typeof rec.sourceHash !== 'string'
    || typeof rec.sourceRecordCount !== 'number'
  ) {
    throw new Error(`Invalid Track C source state at ${statePath}`);
  }
  return {
    sourcePath: rec.sourcePath,
    sourceHash: rec.sourceHash,
    sourceRecordCount: rec.sourceRecordCount,
  };
}

function writeTrackCSourceState(statePath: string, state: TrackCSourceState): void {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

export function assertTrackCSourceStateMatches(
  current: TrackCSourceState,
  recorded: TrackCSourceState,
): void {
  if (current.sourcePath !== recorded.sourcePath) {
    throw new Error(
      `Track C working copy source path mismatch: current=${current.sourcePath} recorded=${recorded.sourcePath}`,
    );
  }
  if (current.sourceHash !== recorded.sourceHash) {
    throw new Error(
      `Track C working copy source hash mismatch for ${current.sourcePath}; rerun step 1 to reseed the working copy`,
    );
  }
  if (current.sourceRecordCount !== recorded.sourceRecordCount) {
    throw new Error(
      `Track C working copy source record count mismatch: current=${current.sourceRecordCount} recorded=${recorded.sourceRecordCount}`,
    );
  }
}

function seedTrackCWorkingCopy(fromStep: number): void {
  const sourceContent = fs.readFileSync(TRACK_C_SOURCE_FILE, 'utf-8');
  const currentSourceState = buildTrackCSourceState(TRACK_C_SOURCE_FILE, sourceContent);

  if (fromStep > 1 && !fs.existsSync(TRACK_C_OUTPUT_FILE)) {
    throw new Error(
      `Missing working artifact ${TRACK_C_OUTPUT_FILE}. Run step 1 first or seed the track-c artifact before resuming.`,
    );
  }
  if (fromStep > 1 && fs.existsSync(TRACK_C_OUTPUT_FILE)) {
    if (!fs.existsSync(TRACK_C_SOURCE_STATE_FILE)) {
      throw new Error(
        `Missing Track C source state ${TRACK_C_SOURCE_STATE_FILE}; rerun step 1 to reseed from ${TRACK_C_SOURCE_FILE}`,
      );
    }
    const recordedState = readTrackCSourceState(TRACK_C_SOURCE_STATE_FILE);
    assertTrackCSourceStateMatches(currentSourceState, recordedState);
    return;
  }
  if (fromStep === 1 || !fs.existsSync(TRACK_C_OUTPUT_FILE)) {
    fs.copyFileSync(TRACK_C_SOURCE_FILE, TRACK_C_OUTPUT_FILE);
    writeTrackCSourceState(TRACK_C_SOURCE_STATE_FILE, currentSourceState);
  }
}

/**
 * Checks field coverage across ALL records (not just the first sample).
 * Returns the fraction of records that have the field defined and non-null.
 */
function fieldCoverage(fieldName: string): { present: number; total: number; ratio: number } {
  const content = fs.readFileSync(TRACK_C_OUTPUT_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter((line) => line.length > 0);
  let present = 0;
  for (const line of lines) {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record[fieldName] != null) present++;
  }
  return { present, total: lines.length, ratio: lines.length > 0 ? present / lines.length : 0 };
}

export function assertTrackCFieldCoverageIsComplete(
  fieldName: string,
  coverage: { readonly present: number; readonly total: number },
  minimumRatio: number = 1,
): void {
  if (minimumRatio <= 0) {
    return;
  }
  if (coverage.total === 0) {
    throw new Error(`Track C field "${fieldName}" has no records`);
  }
  if (minimumRatio >= 1 && coverage.present !== coverage.total) {
    throw new Error(
      `Track C field "${fieldName}" is not fully populated (${coverage.present}/${coverage.total})`,
    );
  }
  if (coverage.total > 0 && coverage.present / coverage.total < minimumRatio) {
    throw new Error(
      `Track C field "${fieldName}" is below minimum coverage (${coverage.present}/${coverage.total})`
      + `, threshold ${(minimumRatio * 100).toFixed(1)}%`,
    );
  }
}

export function parseFromStep(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from-step') {
      const n = parseInt(argv[i + 1] ?? '', 10);
      return Number.isNaN(n) ? 1 : Math.max(1, Math.min(TRACK_C_TOTAL_STEPS, n));
    }
  }
  return 1;
}

async function runStep(
  stepNum: number,
  scriptName: string,
  description: string,
  outputField: string,
  minimumCoverage: number,
): Promise<boolean> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Step ${stepNum}: ${description}`);
  console.log(`${'='.repeat(70)}`);

  const scriptPath = path.resolve(`./scripts/etl/${scriptName}`);
  if (!fs.existsSync(scriptPath)) {
    console.error(`  Script not found: ${scriptPath}`);
    return false;
  }

  // Backup before step execution so checkpointed partial writes can be rolled back.
  const backupPath = await backupFile(TRACK_C_OUTPUT_FILE);

  console.log(`  Script: ${scriptName}`);
  console.log(`  Before: ${getRecordCount(TRACK_C_OUTPUT_FILE)} records, ${getFileSize(TRACK_C_OUTPUT_FILE)}`);

  try {
    console.log(`  Running step ${stepNum}...`);
    const startTime = Date.now();

    execSync(`pnpm exec tsx --env-file=.env ${scriptPath}`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Validate output field across ALL records (not just first sample)
    const coverage = fieldCoverage(outputField);
    try {
      assertTrackCFieldCoverageIsComplete(
        outputField,
        coverage,
        minimumCoverage,
      );
    } catch {
      if (backupPath !== null) {
        fs.copyFileSync(backupPath, TRACK_C_OUTPUT_FILE);
      }
      console.error(
        `  Step ${stepNum} completed but output field "${outputField}" failed coverage check (` +
        `${coverage.present}/${coverage.total}, ${(coverage.ratio * 100).toFixed(1)}%)`,
      );
      return false;
    }

    console.log(
      `  Step ${stepNum} complete (${elapsed}s). ` +
      `Field "${outputField}": ${coverage.present}/${coverage.total} records ` +
      `(${(coverage.ratio * 100).toFixed(1)}%)`,
    );
    console.log(`  After: ${getRecordCount(TRACK_C_OUTPUT_FILE)} records, ${getFileSize(TRACK_C_OUTPUT_FILE)}`);
    return true;
  } catch (error) {
    if (backupPath !== null) {
      fs.copyFileSync(backupPath, TRACK_C_OUTPUT_FILE);
    }
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
  if (!fs.existsSync(TRACK_C_SOURCE_FILE)) {
    console.error(`  Input file not found: ${TRACK_C_SOURCE_FILE}`);
    throw new Error(`Input file not found: ${TRACK_C_SOURCE_FILE}`);
  }

  const fromStep = parseFromStep(process.argv.slice(2));
  if (fromStep > 1) {
    console.log(`  Resuming from step ${fromStep} (--from-step)`);
  }

  // Early validation: fail fast before spending LLM credits
  seedTrackCWorkingCopy(fromStep);

  const initialRecordCount = getRecordCount(TRACK_C_OUTPUT_FILE);
  if (initialRecordCount < MIN_RECORDS_FOR_TRACK_C) {
    console.error(
      `  Record count ${initialRecordCount} < ${MIN_RECORDS_FOR_TRACK_C}. ` +
      `Too few records for Track C enrichment — check upstream Silver pipeline.`,
    );
    throw new Error(
      `Track C record count ${initialRecordCount} < ${MIN_RECORDS_FOR_TRACK_C}`,
    );
  }

  const initialSize = getFileSize(TRACK_C_OUTPUT_FILE);

  console.log(`\n  Input Statistics:`);
  console.log(`   Source File: ${TRACK_C_SOURCE_FILE}`);
  console.log(`   Working File: ${TRACK_C_OUTPUT_FILE}`);
  console.log(`   Records: ${initialRecordCount}`);
  console.log(`   Size: ${initialSize}`);
  console.log(`   Date: ${new Date().toISOString()}`);

  // Acquire advisory lock
  let unlock: (() => Promise<void>) | null = null;
  try {
    unlock = await acquireLock(LOCK_FILE);
  } catch (e) {
    console.error(`  ${e instanceof Error ? e.message : String(e)}`);
    throw e instanceof Error ? e : new Error(String(e));
  }

  const startTime = Date.now();
  const results: Array<{
    step: number;
    name: string;
    success: boolean;
  }> = [];

  try {
    for (const step of TRACK_C_STEP_DEFINITIONS) {
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
        step.requiredCoverage ?? 1,
      );
      results.push({
        step: step.num,
        name: step.desc,
        success,
      });

      if (!success) {
        console.error(`\n  Step ${step.num} failed. Aborting Track C.`);
        break;
      }

      // Verify record count hasn't changed (data integrity check)
      const currentCount = getRecordCount(TRACK_C_OUTPUT_FILE);
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
  const finalRecordCount = getRecordCount(TRACK_C_OUTPUT_FILE);
  const finalSize = getFileSize(TRACK_C_OUTPUT_FILE);

  console.log(`\n${'='.repeat(70)}`);
  console.log('  Track C Pipeline Summary');
  console.log(`${'='.repeat(70)}`);

  console.log(`\nInput:`);
  console.log(`  Records: ${initialRecordCount}`);
  console.log(`  Size: ${initialSize}`);

  console.log(`\nOutput:`);
  console.log(`  Records: ${finalRecordCount}`);
  console.log(`  Size: ${finalSize}`);

  console.log(`\nSteps Completed (${TRACK_C_TOTAL_STEPS} planned):`);
  for (const result of results) {
    const icon = result.success ? 'OK' : 'FAIL';
    console.log(`  [${icon}] Step ${result.step}: ${result.name}`);
  }

  const allPassed = results.every((r) => r.success);

  console.log(`\nExecution Time: ${elapsed} minutes`);
  console.log(`Working File: ${TRACK_C_OUTPUT_FILE}`);

  if (allPassed) {
    console.log(`\n  Track C Complete! Data ready for Vespa indexing.`);
  } else {
    console.log(`\n  Some steps failed. Use --from-step N to resume.`);
  }

  console.log(`\nFile: ${TRACK_C_OUTPUT_FILE}`);
  console.log(`\n${'='.repeat(70)}\n`);
  if (!allPassed) {
    throw new Error('Track C pipeline completed with failures');
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  void main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
