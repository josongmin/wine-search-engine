/**
 * Regression: the deploy bootstrap script
 * (`scripts/etl/bootstrap-search-snapshot.sh`) must only invoke `pnpm run`
 * targets that actually exist in package.json, and must cover the full
 * publish chain (not stop at `etl:index` like `etl:full` does).
 *
 * Why this guards a real bug class:
 *   The bootstrap is the single command that takes a fresh PG + Vespa to a
 *   serving state (`GET /ready == 200`). It chains ~12 separate `etl:*`
 *   scripts by name. If any of those scripts is renamed/removed in
 *   package.json, the bootstrap silently breaks at deploy time — exactly
 *   when it is least debuggable. This test fails the build the moment the
 *   script references a non-existent target, or the moment a publish-chain
 *   step (the part beyond `etl:full`) is dropped from the bootstrap.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BOOTSTRAP_PATH = resolve(REPO_ROOT, 'scripts/etl/bootstrap-search-snapshot.sh');
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, 'package.json');

function readBootstrap(): string {
  return readFileSync(BOOTSTRAP_PATH, 'utf8');
}

function readPackageScripts(): Readonly<Record<string, string>> {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/** Extract every `pnpm run <target>` referenced by the bootstrap script. */
function referencedPnpmTargets(script: string): readonly string[] {
  const targets = new Set<string>();
  const re = /pnpm run ([a-zA-Z0-9:_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(script)) !== null) {
    if (m[1] !== undefined) targets.add(m[1]);
  }
  return [...targets];
}

describe('bootstrap-search-snapshot.sh — script drift guard', () => {
  it('references only pnpm targets that exist in package.json', () => {
    const scripts = readPackageScripts();
    const referenced = referencedPnpmTargets(readBootstrap());

    expect(referenced.length).toBeGreaterThan(0);
    const missing = referenced.filter((target) => !(target in scripts));
    expect(missing, `bootstrap references non-existent package.json scripts: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('covers the publish chain beyond etl:full (the steps that make /ready pass)', () => {
    const referenced = new Set(referencedPnpmTargets(readBootstrap()));
    // etl:full stops at etl:index; the bootstrap MUST go further or the
    // runtime never serves search (no published snapshot pointer).
    const publishChainSteps = [
      'etl:build-ambiguity-registry',
      'etl:build-search-snapshot',
      'etl:ingest-canonical-entity-graph',
      'etl:publish-search-snapshot',
      'etl:verify-search-snapshot',
    ];
    const absent = publishChainSteps.filter((step) => !referenced.has(step));
    expect(absent, `bootstrap is missing publish-chain steps: ${absent.join(', ')}`).toEqual([]);
  });

  it('is registered as the etl:bootstrap package.json script', () => {
    const scripts = readPackageScripts();
    expect(scripts['etl:bootstrap']).toBeDefined();
    expect(scripts['etl:bootstrap']).toContain('bootstrap-search-snapshot.sh');
  });
});
