#!/usr/bin/env tsx
/**
 * Feature Catalog CLI.
 *
 *   pnpm run catalog:build      Validate + render dist/*.md
 *   pnpm run catalog:validate   Validate + lint only (CI gate)
 *   pnpm run catalog:stats      Print distribution summary
 *   pnpm run catalog:show <id>  Print one feature's rendered detail
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFeaturesFromDir } from '../lib/load.js';
import { lintFeatures, type LintIssue } from '../lib/lint.js';
import {
  renderByMaturity,
  renderFeatureDetail,
  renderIndex,
} from '../lib/render.js';
import { renderImprovementSummary, renderRoadmap } from '../lib/roadmap.js';
import { computeStats } from '../lib/stats.js';

const TOOL_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const FEATURES_DIR = join(TOOL_ROOT, 'features');
const DIST_DIR = join(TOOL_ROOT, 'dist');
const REPO_ROOT = resolve(TOOL_ROOT, '../..');

/** Depth from dist/CATALOG.md back to repo root: ../../../ */
const INDEX_REPO_ROOT = '../../../';
/** Depth from dist/features/<id>.md back to repo root: ../../../../ */
const DETAIL_REPO_ROOT = '../../../../';

function printIssues(issues: readonly LintIssue[]): void {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warn');
  if (warnings.length > 0) {
    process.stderr.write(`[catalog] ${warnings.length} warning(s):\n`);
    for (const w of warnings) {
      process.stderr.write(`  ! [${w.featureId}] ${w.message}\n`);
    }
  }
  if (errors.length > 0) {
    process.stderr.write(`[catalog] ${errors.length} error(s):\n`);
    for (const e of errors) {
      process.stderr.write(`  x [${e.featureId}] ${e.message}\n`);
    }
  }
}

function commandBuild(): number {
  const features = loadFeaturesFromDir(FEATURES_DIR);
  const issues = lintFeatures(features, REPO_ROOT);
  printIssues(issues);
  if (issues.some((i) => i.severity === 'error')) {
    return 1;
  }

  mkdirSync(join(DIST_DIR, 'features'), { recursive: true });
  const builtAt = new Date().toISOString().slice(0, 10);

  writeFileSync(
    join(DIST_DIR, 'CATALOG.md'),
    renderIndex(features, builtAt, INDEX_REPO_ROOT),
    'utf-8',
  );
  writeFileSync(
    join(DIST_DIR, 'by-maturity.md'),
    renderByMaturity(features, builtAt),
    'utf-8',
  );
  writeFileSync(
    join(DIST_DIR, 'ROADMAP.md'),
    renderRoadmap(features, builtAt),
    'utf-8',
  );
  writeFileSync(
    join(DIST_DIR, 'by-improvement.md'),
    renderImprovementSummary(features),
    'utf-8',
  );
  for (const lf of features) {
    writeFileSync(
      join(DIST_DIR, 'features', `${lf.feature.id}.md`),
      renderFeatureDetail(lf, DETAIL_REPO_ROOT),
      'utf-8',
    );
  }

  const stats = computeStats(features);
  process.stdout.write(
    `[catalog] built ${stats.total} feature(s) -> ${DIST_DIR}\n`,
  );
  const maturityLine = [5, 4, 3, 2, 1]
    .map((m) => `${m}=${stats.byMaturity[m as 1 | 2 | 3 | 4 | 5]}`)
    .join(' ');
  process.stdout.write(`[catalog] maturity: ${maturityLine}\n`);
  return 0;
}

function commandValidate(): number {
  const features = loadFeaturesFromDir(FEATURES_DIR);
  const issues = lintFeatures(features, REPO_ROOT);
  if (issues.length === 0) {
    process.stdout.write(
      `[catalog] ${features.length} feature(s) validated. No issues.\n`,
    );
    return 0;
  }
  printIssues(issues);
  return issues.some((i) => i.severity === 'error') ? 1 : 0;
}

function commandStats(): number {
  const features = loadFeaturesFromDir(FEATURES_DIR);
  const stats = computeStats(features);
  process.stdout.write(`Total: ${stats.total}\n\n`);
  process.stdout.write('By maturity:\n');
  for (const m of [5, 4, 3, 2, 1] as const) {
    process.stdout.write(`  ${m}: ${stats.byMaturity[m]}\n`);
  }
  process.stdout.write('\nBy category:\n');
  for (const [cat, count] of [...stats.byCategory.entries()].sort()) {
    process.stdout.write(`  ${cat}: ${count}\n`);
  }
  process.stdout.write('\nBy status:\n');
  for (const [status, count] of Object.entries(stats.byStatus)) {
    process.stdout.write(`  ${status}: ${count}\n`);
  }
  return 0;
}

function commandShow(id: string): number {
  const features = loadFeaturesFromDir(FEATURES_DIR);
  const found = features.find((f) => f.feature.id === id);
  if (found === undefined) {
    process.stderr.write(`[catalog] feature not found: ${id}\n`);
    return 1;
  }
  process.stdout.write(renderFeatureDetail(found, DETAIL_REPO_ROOT));
  return 0;
}

function main(): number {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'build':
      return commandBuild();
    case 'validate':
      return commandValidate();
    case 'stats':
      return commandStats();
    case 'show': {
      const id = args[0];
      if (id === undefined) {
        process.stderr.write('[catalog] usage: catalog show <id>\n');
        return 1;
      }
      return commandShow(id);
    }
    case 'roadmap':
      return commandRoadmap();
    default:
      process.stderr.write(
        '[catalog] commands: build | validate | stats | show <id> | roadmap\n',
      );
      return 1;
  }
}

function commandRoadmap(): number {
  const features = loadFeaturesFromDir(FEATURES_DIR);
  const builtAt = new Date().toISOString().slice(0, 10);
  process.stdout.write(renderRoadmap(features, builtAt));
  process.stdout.write('\n');
  process.stdout.write(renderImprovementSummary(features));
  return 0;
}

process.exit(main());
