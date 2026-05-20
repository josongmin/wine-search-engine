import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedFeature } from './load.js';
import type { Feature } from '../schema/feature.schema.js';

export interface LintIssue {
  readonly featureId: string;
  readonly sourcePath: string;
  readonly severity: 'error' | 'warn';
  readonly message: string;
}

const STALE_REVIEW_DAYS = 180;

function collectFileRefs(feature: Feature): readonly string[] {
  const tests = feature.tests ?? {
    unit: [],
    e2e: [],
    bench: [],
    regression: [],
  };
  return [
    ...feature.key_files,
    ...tests.unit,
    ...tests.e2e,
    ...tests.bench,
    ...tests.regression,
    ...feature.related_rfcs,
  ];
}

function detectCycle(
  startId: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean {
  const visited = new Set<string>();
  const stack: string[] = [...(adjacency.get(startId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node === startId) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const dep of adjacency.get(node) ?? []) {
      stack.push(dep);
    }
  }
  return false;
}

export function lintFeatures(
  features: readonly LoadedFeature[],
  repoRoot: string,
): readonly LintIssue[] {
  const issues: LintIssue[] = [];
  const idCounts = new Map<string, number>();
  for (const { feature } of features) {
    idCounts.set(feature.id, (idCounts.get(feature.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push({
        featureId: id,
        sourcePath: '<multiple>',
        severity: 'error',
        message: `Duplicate feature id "${id}" (${count} occurrences)`,
      });
    }
  }

  const idSet = new Set(features.map((f) => f.feature.id));

  for (const { feature, sourcePath } of features) {
    for (const p of collectFileRefs(feature)) {
      if (!existsSync(join(repoRoot, p))) {
        issues.push({
          featureId: feature.id,
          sourcePath,
          severity: 'error',
          message: `Referenced file does not exist: ${p}`,
        });
      }
    }

    for (const dep of feature.depends_on) {
      if (dep === feature.id) {
        issues.push({
          featureId: feature.id,
          sourcePath,
          severity: 'error',
          message: `Feature cannot depend on itself`,
        });
      } else if (!idSet.has(dep)) {
        issues.push({
          featureId: feature.id,
          sourcePath,
          severity: 'error',
          message: `depends_on references unknown feature id: ${dep}`,
        });
      }
    }

    if (!feature.id.startsWith(`${feature.category}.`)) {
      issues.push({
        featureId: feature.id,
        sourcePath,
        severity: 'warn',
        message: `Feature id should start with category prefix "${feature.category}."`,
      });
    }

    const reviewedMs = new Date(feature.last_reviewed).getTime();
    if (Number.isFinite(reviewedMs)) {
      const ageDays = (Date.now() - reviewedMs) / (1000 * 60 * 60 * 24);
      if (ageDays > STALE_REVIEW_DAYS) {
        issues.push({
          featureId: feature.id,
          sourcePath,
          severity: 'warn',
          message: `last_reviewed is ${Math.round(ageDays)} days old (>${STALE_REVIEW_DAYS}) — consider refreshing`,
        });
      }
    }
  }

  const adjacency = new Map<string, readonly string[]>();
  for (const { feature } of features) adjacency.set(feature.id, feature.depends_on);
  for (const id of adjacency.keys()) {
    if (detectCycle(id, adjacency)) {
      issues.push({
        featureId: id,
        sourcePath: '<derived>',
        severity: 'error',
        message: `Dependency cycle detected involving "${id}"`,
      });
    }
  }

  return issues;
}
