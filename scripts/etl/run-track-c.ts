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
 * Usage: npx ts-node scripts/etl/run-track-c.ts
 *
 * Input: data/silver-docquery.ndjson (7040 docs)
 * Output: data/silver-docquery.ndjson (fully enriched with all fields)
 * Error recovery: Logs all failures, continues with next step/batch
 * Resume capability: Detects already-processed docs, skips them
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DATA_FILE = path.resolve('./data/silver-docquery.ndjson');

function getFileSize(filePath: string): string {
  const stats = fs.statSync(filePath);
  const mb = (stats.size / 1024 / 1024).toFixed(1);
  return `${mb}MB`;
}

function getRecordCount(filePath: string): number {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.trim().split('\n').filter((line) => line.length > 0).length;
}

function hasField(fieldName: string): boolean {
  const content = fs.readFileSync(DATA_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter((line) => line.length > 0);
  const sample = lines[0];
  if (!sample) return false;
  const record = JSON.parse(sample);
  return fieldName in record;
}

async function runStep(
  stepNum: number,
  scriptName: string,
  description: string,
  outputField: string,
): Promise<boolean> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`📍 Step ${stepNum}: ${description}`);
  console.log(`${'='.repeat(70)}`);

  const scriptPath = path.resolve(`./scripts/etl/${scriptName}`);
  if (!fs.existsSync(scriptPath)) {
    console.error(`❌ Script not found: ${scriptPath}`);
    return false;
  }

  console.log(`📋 Script: ${scriptName}`);
  console.log(`📝 Before: ${getRecordCount(DATA_FILE)} records, ${getFileSize(DATA_FILE)}`);

  try {
    console.log(`⏳ Running step ${stepNum}...`);
    const startTime = Date.now();

    // Run the step
    execSync(`npx tsx --env-file=.env ${scriptPath}`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const hasOutput = hasField(outputField);

    if (hasOutput) {
      console.log(
        `✅ Step ${stepNum} Complete (${elapsed}s). Field added: ${outputField}`,
      );
      console.log(`📝 After: ${getRecordCount(DATA_FILE)} records, ${getFileSize(DATA_FILE)}`);
      return true;
    } else {
      console.warn(
        `⚠️  Step ${stepNum} completed but output field not found: ${outputField}`,
      );
      return false;
    }
  } catch (error) {
    console.error(
      `❌ Step ${stepNum} failed:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function main() {
  console.log('');
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + ' '.repeat(15) + '🍷 Track C (ETL Pipeline) Orchestrator' + ' '.repeat(15) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');

  // Validate input
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ Input file not found: ${DATA_FILE}`);
    process.exit(1);
  }

  const initialRecordCount = getRecordCount(DATA_FILE);
  const initialSize = getFileSize(DATA_FILE);

  console.log(`\n📊 Input Statistics:`);
  console.log(`   File: ${DATA_FILE}`);
  console.log(`   Records: ${initialRecordCount}`);
  console.log(`   Size: ${initialSize}`);
  console.log(`   Date: ${new Date().toISOString()}`);

  const startTime = Date.now();
  const results: Array<{
    step: number;
    name: string;
    success: boolean;
  }> = [];

  // Run steps in sequence
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
      field: 'pairingTags', // This one updates existing field
    },
    {
      num: 4,
      script: 'drinking-window-backfill.ts',
      desc: 'Drinking Window Backfill (LightGBM)',
      field: 'drinkingWindow',
    },
  ];

  for (const step of steps) {
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
        `\n⚠️  Step ${step.num} failed. Continue with next step? (Ctrl+C to abort)`,
      );
      // In production, could add retry logic here
    }
  }

  // Final report
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const finalRecordCount = getRecordCount(DATA_FILE);
  const finalSize = getFileSize(DATA_FILE);

  console.log(`\n${'='.repeat(70)}`);
  console.log('📊 Track C Pipeline Summary');
  console.log(`${'='.repeat(70)}`);

  console.log(`\nInput:`);
  console.log(`  Records: ${initialRecordCount}`);
  console.log(`  Size: ${initialSize}`);

  console.log(`\nOutput:`);
  console.log(`  Records: ${finalRecordCount}`);
  console.log(`  Size: ${finalSize}`);

  console.log(`\nSteps Completed:`);
  for (const result of results) {
    const icon = result.success ? '✅' : '❌';
    console.log(`  ${icon} Step ${result.step}: ${result.name}`);
  }

  const allPassed = results.every((r) => r.success);

  console.log(`\nExecution Time: ${elapsed} minutes`);
  console.log(`File: ${DATA_FILE}`);

  if (allPassed) {
    console.log(`\n🎉 Track C Complete! Data ready for Vespa indexing.`);
    console.log(`\nNew fields added:`);
    console.log(`  - criticProxy: LLM-based critic score (score 80-100, tier, confidence)`);
    console.log(`  - certifications: Organic/biodynamic/vegan/natural flags + source`);
    console.log(`  - pairingTags: Normalized food pairing taxonomy`);
    console.log(`  - drinkingWindow: Predicted drinking window (start, end, peak, confidence)`);
  } else {
    console.log(`\n⚠️  Some steps failed. Check logs above for details.`);
  }

  console.log(`\n${'='.repeat(70)}\n`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
