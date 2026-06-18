#!/usr/bin/env tsx
/**
 * Active-runtime pointer proof bundle (blocking gates for cutover confidence).
 *
 * Runs authority + parity + Korean-famous latency against the active snapshot
 * pointer. Fails closed on any gate failure.
 *
 * `--contract-only` validates script wiring without requiring a live runtime
 * pointer (CI / meta lane).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PROOF_SCRIPTS = [
  'scripts/eval/run-entity-resolution-validation.ts',
  'scripts/eval/run-lookup-v2-parity.ts',
  'scripts/eval/run-lookup-v2-latency-korean-famous.ts',
] as const;

function run(label: string, script: string, extraArgs: readonly string[] = []): void {
  console.log(`[lookup-v2-active-pointer-proof] ${label}`);
  execFileSync(
    process.execPath,
    ['--import', 'tsx', script, '--use-active-runtime', ...extraArgs],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

function contractOnly(): void {
  for (const relativePath of PROOF_SCRIPTS) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`missing proof script: ${relativePath}`);
    }
    const source = readFileSync(absolutePath, 'utf8');
    const hasRuntimeBindingContract =
      source.includes('EVAL_RUNTIME_BINDING_OPTIONS')
      || source.includes('resolveEvalRuntimeBinding')
      || source.includes('requireExplicitEvalRuntimeBinding');
    if (!hasRuntimeBindingContract) {
      throw new Error(`${relativePath} must bind eval runtime via runtime-binding-args`);
    }
  }
  console.log('[lookup-v2-active-pointer-proof] CONTRACT-ONLY PASS — proof scripts wired');
}

function main(): void {
  if (process.argv.includes('--contract-only')) {
    contractOnly();
    return;
  }

  run(
    'authority',
    'scripts/eval/run-entity-resolution-validation.ts',
    ['--output', '/tmp/entity-resolution-validation-active-pointer.json'],
  );
  run(
    'parity',
    'scripts/eval/run-lookup-v2-parity.ts',
    ['--output', '/tmp/lookup-v2-parity-active-pointer.json'],
  );
  run(
    'latency:korean-famous',
    'scripts/eval/run-lookup-v2-latency-korean-famous.ts',
    ['--output', '/tmp/lookup-v2-latency-korean-famous-active-pointer.json'],
  );
  console.log('[lookup-v2-active-pointer-proof] PASS — authority, parity, latency');
}

main();
