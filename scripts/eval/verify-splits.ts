#!/usr/bin/env tsx
/**
 * Split Integrity Verifier: Validates that train/val/gate splits respect
 * the leakage prevention contract (RFC-017 §2.5).
 *
 * Checks:
 * 1. No entity_id appears in both train and gate
 * 2. No alias_cluster_id spans train ↔ gate
 * 3. Gate queries are temporally after train/val
 * 4. No query_template_id + entity_id pair spans train ↔ gate
 *
 * Exit code 1 on any violation. Designed for CI integration.
 *
 * Usage:
 *   npx tsx scripts/eval/verify-splits.ts
 */

import {
  DEFAULT_SPLIT_PATHS,
  verifyDefaultGoldenSplits,
} from './split-integrity.js';

async function run(): Promise<void> {
  console.log('Verifying split integrity …\n');

  const trainPath = DEFAULT_SPLIT_PATHS.train;
  const valPath = DEFAULT_SPLIT_PATHS.val;
  const gatePath = DEFAULT_SPLIT_PATHS.gate;

  const result = await verifyDefaultGoldenSplits();

  console.log(`  Train: ${result.stats.train}  Val: ${result.stats.val}  Gate: ${result.stats.gate}`);
  console.log(`  Files: ${trainPath} | ${valPath} | ${gatePath}`);

  if (result.stats.train === 0 && result.stats.val === 0 && result.stats.gate === 0) {
    console.log('\n  No split files found. Run build-splits.ts first.');
    process.exit(1);
  }

  if (result.valid) {
    console.log('\n  ✅ Split integrity PASSED — no leakage detected');
  } else {
    console.log(`\n  ❌ Split integrity FAILED — ${result.violations.length} violations:`);
    for (const v of result.violations.slice(0, 20)) {
      console.log(`    ${v}`);
    }
    if (result.violations.length > 20) {
      console.log(`    … and ${result.violations.length - 20} more`);
    }
    process.exit(1);
  }
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
