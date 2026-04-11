#!/usr/bin/env tsx
/**
 * ADR-004 external fixture governance verification.
 *
 * Verifies that:
 *  1. the external fixture repository is present and structurally readable
 *  2. fixture-repo integrity scripts pass
 *  3. the engine FixtureLoader can load all suites/cases/thresholds
 *  4. target-entity mapping covers all exact-entity evaluation cases
 *
 * This is the operational gate for "fixture repo exists" vs
 * "engine can actually consume the repo as benchmark truth".
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import { FixtureLoader, type BenchmarkCase } from '../../src/infrastructure/fixture/fixture-loader.js';
import { ALL_SUITE_IDS, type SuiteId } from '../../src/infrastructure/fixture/suite-registry.js';

const execFile = promisify(execFileCb);

type ExactEntityMode = 'exact_entity_top1' | 'exact_entity_topk';

function resolveFixtureRoot(): string {
  return resolve(
    process.env['FIXTURE_REPO_PATH'] ?? resolve(process.cwd(), '..', 'wine-engine-fixture'),
  );
}

function isExactEntityMode(mode: BenchmarkCase['evaluation']['mode']): mode is ExactEntityMode {
  return mode === 'exact_entity_top1' || mode === 'exact_entity_topk';
}

async function runFixtureRepoScript(
  fixtureRoot: string,
  scriptPath: string,
  args: readonly string[] = [],
): Promise<void> {
  await execFile(
    'npx',
    [
      '--yes',
      '--prefix',
      fixtureRoot,
      'tsx',
      resolve(fixtureRoot, scriptPath),
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: process.env,
    },
  );
}

function assertAllSuitesPresent(
  suiteCount: number,
  expectedSuiteCount: number,
): void {
  if (suiteCount !== expectedSuiteCount) {
    throw new Error(
      `FixtureLoader loaded ${suiteCount} suites, expected ${expectedSuiteCount}. ` +
      `This indicates fixture schema drift or missing suite files.`,
    );
  }
}

function assertThresholdCoverage(
  thresholds: Readonly<Record<string, unknown>>,
): void {
  const missing = (ALL_SUITE_IDS as readonly SuiteId[]).filter((suiteId) => !(suiteId in thresholds));
  if (missing.length > 0) {
    throw new Error(`Thresholds missing for suites: ${missing.join(', ')}`);
  }
}

function assertCaseCoverage(
  caseCounts: Readonly<Record<SuiteId, number>>,
): void {
  const emptySuites = Object.entries(caseCounts)
    .filter(([, count]) => count === 0)
    .map(([suiteId]) => suiteId);
  if (emptySuites.length > 0) {
    throw new Error(`Fixture suites with zero cases: ${emptySuites.join(', ')}`);
  }
}

function assertExactEntityTargetCoverage(
  cases: readonly BenchmarkCase[],
  targetEntityMap: Readonly<Record<string, string>>,
): void {
  const uncovered = cases
    .filter((benchmarkCase) => isExactEntityMode(benchmarkCase.evaluation.mode))
    .filter((benchmarkCase) => targetEntityMap[benchmarkCase.id] === undefined)
    .map((benchmarkCase) => benchmarkCase.id);

  if (uncovered.length > 0) {
    throw new Error(
      `Exact-entity benchmark cases missing target-entity-map entries: ${uncovered.join(', ')}`,
    );
  }
}

function printSummary(
  fixtureRoot: string,
  suiteCount: number,
  caseCounts: Readonly<Record<SuiteId, number>>,
  exactCaseCount: number,
  thresholdCount: number,
): void {
  console.log('ADR-004 external fixture governance verification');
  console.log(`fixture_root=${fixtureRoot}`);
  console.log(`suite_count=${suiteCount}`);
  console.log(`threshold_count=${thresholdCount}`);
  console.log(`exact_entity_case_count=${exactCaseCount}`);
  for (const suiteId of ALL_SUITE_IDS) {
    console.log(`cases.${suiteId}=${caseCounts[suiteId]}`);
  }
  console.log('result=passed');
}

async function main(): Promise<void> {
  const fixtureRoot = resolveFixtureRoot();
  const loader = new FixtureLoader(fixtureRoot);

  if (!loader.isAvailable()) {
    throw new Error(
      `Fixture repository not available at "${fixtureRoot}". ` +
      `Set FIXTURE_REPO_PATH or clone wine-engine-fixture as a sibling directory.`,
    );
  }

  await runFixtureRepoScript(fixtureRoot, 'scripts/validate-integrity.ts');
  await runFixtureRepoScript(fixtureRoot, 'scripts/generate-target-entity-map.ts', ['--verify']);

  const [suites, thresholds, caseCounts, cases, targetEntityMap, aliasCatalog] = await Promise.all([
    loader.loadAllSuites(),
    loader.loadThresholds(),
    loader.getCaseCounts(),
    loader.loadAllCases(),
    loader.loadTargetEntityMap(),
    loader.loadKoreanAliasCatalog(),
  ]);

  assertAllSuitesPresent(suites.length, ALL_SUITE_IDS.length);
  assertThresholdCoverage(thresholds);
  assertCaseCoverage(caseCounts);
  assertExactEntityTargetCoverage(cases, targetEntityMap);

  if (aliasCatalog.length === 0) {
    throw new Error('Korean alias catalog is empty; fixture repo is not benchmark-ready.');
  }

  const exactCaseCount = cases.filter((benchmarkCase) => isExactEntityMode(benchmarkCase.evaluation.mode)).length;
  printSummary(
    fixtureRoot,
    suites.length,
    caseCounts,
    exactCaseCount,
    Object.keys(thresholds).length,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
