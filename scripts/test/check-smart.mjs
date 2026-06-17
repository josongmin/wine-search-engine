#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const stagedOnly = args.includes('--staged');
const explicitFiles = args.filter((arg) => arg !== '--staged');

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function npmRun(script, extraArgs = []) {
  run('npm', ['run', script, '--', ...extraArgs]);
}

/** Full TS graph: `src/` (app) + `scripts/etl/` (ETL) — see `tsconfig.etl.json`. */
function runTypecheckStack() {
  npmRun('typecheck');
  npmRun('typecheck:etl');
}

function runVitestLane(mode, config, extraArgs = [], emptyExitCode = null) {
  const args = ['./scripts/test/run-vitest-lane.mjs'];
  if (emptyExitCode !== null) {
    args.push('--empty-exit-code', String(emptyExitCode));
  }
  args.push(mode, config, ...extraArgs);
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });
  return result.status ?? 1;
}

function readGitPaths(args) {
  try {
    return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function detectChangedFiles() {
  if (stagedOnly) {
    return readGitPaths(['diff', '--name-only', '--cached']);
  }
  return [
    ...readGitPaths(['diff', '--name-only', '--cached']),
    ...readGitPaths(['diff', '--name-only']),
    ...readGitPaths(['ls-files', '--others', '--exclude-standard']),
  ];
}

function uniqueExistingFiles(files) {
  return [...new Set(files)].filter((file) => existsSync(file));
}

function isDocLike(file) {
  return (
    file.endsWith('.md') ||
    file.endsWith('.mdc') ||
    file.startsWith('docs/') ||
    file.startsWith('.ai/') ||
    file === 'README.md' ||
    file === 'CLAUDE.md' ||
    file === 'AGENTS.md'
  );
}

function isConfigish(file) {
  return (
    file === 'package.json' ||
    file.startsWith('config/vitest/') ||
    file.startsWith('scripts/test/') ||
    file.startsWith('tsconfig')
  );
}

function isTestFile(file) {
  return file.endsWith('.test.ts') || file.endsWith('.spec.ts');
}

function needsTypecheck(file) {
  if (isDocLike(file) || isTestFile(file)) {
    return false;
  }

  return (
    file.endsWith('.ts') ||
    file.endsWith('.tsx') ||
    file.endsWith('.js') ||
    file.endsWith('.mjs') ||
    file === 'package.json' ||
    file.startsWith('src/') ||
    file.startsWith('config/') ||
    file.startsWith('scripts/') ||
    file.startsWith('tsconfig')
  );
}

function isLintable(file) {
  return (
    file.endsWith('.ts') ||
    file.endsWith('.tsx') ||
    file.endsWith('.js') ||
    file.endsWith('.mjs') ||
    file.endsWith('.cjs')
  );
}

function matches(file, patterns) {
  return patterns.some((pattern) => pattern.test(file));
}

const metaPatterns = [
  /^test\/unit\/replay-fixtures\/.+\.test\.ts$/,
  /^src\/interface\/http\/schemas\/__tests__\/search-response-v2\.schema\.test\.ts$/,
  /^src\/interface\/http\/routes\/__tests__\/http-contract-manifest-script\.test\.ts$/,
  /^test\/meta\/vespa-hit-summary-readraw-parity\.test\.ts$/,
  /^test\/meta\/lookup-v2-.+\.meta\.test\.ts$/,
  /^test\/meta\/fuzzy-match-confidence-ssot\.test\.ts$/,
  /^test\/meta\/meta-config-exhaustiveness\.meta\.test\.ts$/,
  /^test\/meta\/ci-verification-core-parity\.meta\.test\.ts$/,
  /^test\/unit\/meta\/bench-smoke-lookup-v2-contract\.meta\.test\.ts$/,
  /^test\/unit\/meta\/curation-integration-lane-parity\.test\.ts$/,
];

const metaSourcePatterns = [
  /^src\/domain\/response\//,
  /^src\/interface\/http\/schemas\//,
  /^src\/interface\/http\/routes\/(?!__tests__)/,
  /^scripts\/export-http-contract-manifest\.ts$/,
  /^vespa\/app\/schemas\//,
  /^src\/infrastructure\/vespa\/vespa-schema\.sd$/,
  /^src\/infrastructure\/vespa\/mapping\.ts$/,
  /^test\/meta\/vespa-hit-summary-readraw-parity\.test\.ts$/,
  /^src\/config\/lookup-authority\.ts$/,
  /^src\/application\/search\/entity-lookup-v2\//,
  /^src\/domain\/resolver\/v2\/lookup-v2-substrate-capabilities\.ts$/,
  /^src\/infrastructure\/curation\//,
  /^scripts\/etl\/load-published-curation-proposals\.ts$/,
  /^scripts\/eval\/run-lookup-v2-active-pointer-proof\.ts$/,
];

const httpContractSourcePatterns = [
  /^src\/interface\/http\//,
  /^docs\/http-contract-surface\.md$/,
  /^data\/http-contract-manifest\.json$/,
  /^scripts\/export-http-contract-manifest\.ts$/,
  /^web\/src\/shared\/api\/ops-types\.ts$/,
  /^app\/entity-lookup-ops-web\/src\/lib\/api\.ts$/,
];

const evalPatterns = [
  /^test\/unit\/eval\/.+\.test\.ts$/,
];

const integrationPatterns = [
  /^test\/integration\/.+\.test\.ts$/,
  /^src\/__tests__\/integration\/.+\.integration\.test\.ts$/,
];

const e2ePatterns = [
  /^test\/e2e\/.+\.test\.ts$/,
];

const heavyPatterns = [
  /^test\/integration\/search-pipeline\.test\.ts$/,
];

const heavySourcePatterns = [
  /^src\/application\/search\//,
  /^src\/domain\/decision\//,
  /^src\/domain\/query\//,
  /^src\/domain\/retrieval\//,
  /^src\/domain\/response\//,
  /^src\/infrastructure\/vespa\//,
];

const noisyGatePatterns = [
  /^src\/application\/search\//,
  /^src\/domain\/attribute\//,
  /^src\/domain\/decision\//,
  /^src\/domain\/query\//,
  /^src\/domain\/resolver\//,
  /^src\/domain\/retrieval\//,
  /^src\/domain\/response\//,
  /^src\/infrastructure\/adapter\/search-pipeline-evaluator\.ts$/,
  /^scripts\/eval\/run-noisy-entity-eval\.ts$/,
  /^scripts\/eval\/assert-baseline-regression\.ts$/,
  /^scripts\/eval\/run-eval-and-train-ltr\.ts$/,
  /^scripts\/eval\/run-sota-parallel\.sh$/,
  /^scripts\/test\/check-smart\.mjs$/,
  /^scripts\/test\/prepush-smart\.mjs$/,
  /^data\/noisy-entity-/,
  /^data\/eval-baselines\/noisy-entity-/,
  /^test\/unit\/eval\/noisy-entity-eval\.test\.ts$/,
  /^test\/unit\/eval\/run-eval-and-train-ltr\.test\.ts$/,
  /^test\/unit\/eval\/assert-baseline-regression\.test\.ts$/,
  /^test\/unit\/meta\/benchmark-verification-scripts-parity\.test\.ts$/,
  /^test\/unit\/meta\/sota-parallel-script\.test\.ts$/,
];

const devTestPatterns = [
  /^test\/unit\/.+\.test\.ts$/,
  /^test\/helpers\/.+\.test\.ts$/,
  /^src\/application\/.+\/__tests__\/.+\.test\.ts$/,
  /^src\/config\/.+\/__tests__\/.+\.test\.ts$/,
  /^src\/domain\/.+\/__tests__\/.+\.test\.ts$/,
  /^src\/infrastructure\/.+\/__tests__\/.+\.test\.ts$/,
  /^src\/observability\/.+\/__tests__\/.+\.test\.ts$/,
  /^src\/interface\/.+\/__tests__\/.+\.test\.ts$/,
];

const changedFiles = uniqueExistingFiles(explicitFiles.length > 0 ? explicitFiles : detectChangedFiles());
const shouldRunTypecheck = changedFiles.some(needsTypecheck);
const lintableFiles = changedFiles.filter((file) => isLintable(file) && !isDocLike(file));
const shouldRunMetaLane = changedFiles.some((file) => matches(file, metaSourcePatterns));
const shouldRunHttpContractVerification = changedFiles.some((file) => matches(file, httpContractSourcePatterns));
const shouldRunHeavyLane = changedFiles.some((file) => matches(file, heavySourcePatterns));
const shouldRunNoisyVerification = changedFiles.some((file) => matches(file, noisyGatePatterns));
const label = stagedOnly ? 'check:smart:staged' : 'check:smart';

if (changedFiles.length === 0) {
  if (stagedOnly) {
    console.log(`[${label}] No staged files detected; skipping check.`);
    process.exit(0);
  }
  console.log(`[${label}] No changed files detected; falling back to check:quick.`);
  npmRun('check:quick');
  process.exit(0);
}

if (changedFiles.every(isDocLike)) {
  console.log(`[${label}] Only docs/rules changed; skipping test run.`);
  process.exit(0);
}

if (explicitFiles.length === 0 && changedFiles.length > 15) {
  console.log(
    `[${label}] ${changedFiles.length} changed files detected; falling back to check:quick instead of running many narrow lanes.`,
  );
  if (lintableFiles.length > 0) {
    console.log(`[${label}] Lintable changes detected; running changed-file lint first.`);
    npmRun('lint:file', lintableFiles);
  }
  npmRun('check:dev');
  if (shouldRunMetaLane) {
    console.log(`[${label}] Meta-contract-sensitive changes detected; running test:meta.`);
    npmRun('test:meta');
  }
  if (shouldRunHttpContractVerification) {
    console.log(`[${label}] HTTP-contract-sensitive changes detected; running verify:http-contracts.`);
    npmRun('verify:http-contracts');
  }
  if (shouldRunNoisyVerification) {
    console.log(`[${label}] Noisy-entity-sensitive changes detected; running test:verification:noisy.`);
    npmRun('test:verification:noisy');
  }
  if (shouldRunHeavyLane) {
    console.log(`[${label}] Search-pipeline-sensitive changes detected; running test:heavy.`);
    npmRun('test:heavy');
  }
  process.exit(0);
}

const broadFallback = changedFiles.some(isConfigish);

const heavyFiles = changedFiles.filter((file) => matches(file, heavyPatterns));
const e2eFiles = changedFiles.filter((file) => matches(file, e2ePatterns) && !matches(file, heavyPatterns));
const evalFiles = changedFiles.filter((file) => matches(file, evalPatterns));
const metaFiles = changedFiles.filter((file) => matches(file, metaPatterns));
const integrationFiles = changedFiles.filter(
  (file) => matches(file, integrationPatterns) &&
    !matches(file, heavyPatterns),
);
const devTestFiles = changedFiles.filter(
  (file) => matches(file, devTestPatterns) &&
    !matches(file, evalPatterns) &&
    !matches(file, metaPatterns) &&
    !matches(file, integrationPatterns) &&
    !matches(file, e2ePatterns),
);

const claimed = new Set([
  ...heavyFiles,
  ...e2eFiles,
  ...evalFiles,
  ...metaFiles,
  ...integrationFiles,
  ...devTestFiles,
]);

const relatedInputs = changedFiles.filter((file) => !claimed.has(file) && !isDocLike(file));

if (broadFallback) {
  console.log(`[${label}] Config/test-lane files changed; running safer broad fallback.`);
  if (lintableFiles.length > 0) {
    console.log(`[${label}] Lintable changes detected; running changed-file lint first.`);
    npmRun('lint:file', lintableFiles);
  }
  npmRun('check:dev');
  npmRun('test:meta');
  if (shouldRunHttpContractVerification) {
    console.log(`[${label}] HTTP-contract-sensitive changes detected; running verify:http-contracts.`);
    npmRun('verify:http-contracts');
  }
  if (shouldRunNoisyVerification) {
    console.log(`[${label}] Noisy-entity-sensitive changes detected; running test:verification:noisy.`);
    npmRun('test:verification:noisy');
  }
  if (shouldRunHeavyLane) {
    console.log(`[${label}] Search-pipeline-sensitive changes detected; running test:heavy.`);
    npmRun('test:heavy');
  }
  process.exit(0);
}

if (shouldRunTypecheck) {
  console.log(`[${label}] Source/config changes detected; running typecheck.`);
  runTypecheckStack();
}

if (lintableFiles.length > 0) {
  console.log(`[${label}] Lintable changes detected; running changed-file lint.`);
  npmRun('lint:file', lintableFiles);
}

if (evalFiles.length > 0) {
  console.log(`[${label}] Eval lane: ${evalFiles.join(', ')}`);
  npmRun('test:eval:file', evalFiles);
}

if (metaFiles.length > 0) {
  console.log(`[${label}] Meta lane: ${metaFiles.join(', ')}`);
  npmRun('test:meta:file', metaFiles);
}

if (shouldRunMetaLane) {
  console.log(`[${label}] Meta-contract-sensitive source changes detected; running test:meta.`);
  npmRun('test:meta');
}

if (shouldRunHttpContractVerification) {
  console.log(`[${label}] HTTP-contract-sensitive source changes detected; running verify:http-contracts.`);
  npmRun('verify:http-contracts');
}

if (shouldRunNoisyVerification) {
  console.log(`[${label}] Noisy-entity-sensitive changes detected; running test:verification:noisy.`);
  npmRun('test:verification:noisy');
}

if (devTestFiles.length > 0) {
  console.log(`[${label}] Dev file lane: ${devTestFiles.join(', ')}`);
  npmRun('test:file', devTestFiles);
}

if (integrationFiles.length > 0) {
  console.log(`[${label}] Integration lane: ${integrationFiles.join(', ')}`);
  npmRun('test:integration:file', integrationFiles);
}

if (e2eFiles.length > 0) {
  console.log(`[${label}] E2E lane: ${e2eFiles.join(', ')}`);
  npmRun('test:e2e:file', e2eFiles);
}

if (heavyFiles.length > 0) {
  console.log(`[${label}] Heavy search pipeline file changed; running heavy lane.`);
  npmRun('test:heavy');
}

if (shouldRunHeavyLane && heavyFiles.length === 0) {
  console.log(`[${label}] Search-pipeline-sensitive source changes detected; running heavy lane.`);
  npmRun('test:heavy');
}

if (relatedInputs.length > 0) {
  console.log(`[${label}] Related dev lane: ${relatedInputs.join(', ')}`);
  const devRelatedStatus = runVitestLane('related', 'config/vitest/dev.config.ts', relatedInputs, 42);
  if (devRelatedStatus === 42) {
    console.log(`[${label}] No related tests found in dev lane; trying unit related lane.`);
    const unitRelatedStatus = runVitestLane('related', 'config/vitest/unit.config.ts', relatedInputs, 43);
    if (unitRelatedStatus === 43) {
      console.log(`[${label}] No related tests found in unit lane; falling back to check:dev.`);
      npmRun('check:dev');
    } else if (unitRelatedStatus !== 0) {
      process.exit(unitRelatedStatus);
    }
  } else if (devRelatedStatus !== 0) {
    process.exit(devRelatedStatus);
  }
}

if (
  evalFiles.length === 0 &&
  metaFiles.length === 0 &&
  devTestFiles.length === 0 &&
  integrationFiles.length === 0 &&
  e2eFiles.length === 0 &&
  heavyFiles.length === 0 &&
  relatedInputs.length === 0
) {
  if (shouldRunNoisyVerification) {
    console.log(`[${label}] No narrow test targets found beyond noisy verification; skipping check:quick fallback.`);
    process.exit(0);
  }
  console.log(`[${label}] No runnable test targets found; falling back to check:quick.`);
  npmRun('check:quick');
}
