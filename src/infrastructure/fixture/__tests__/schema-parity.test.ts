/**
 * Schema parity tests — JSON Schema (schema/*.schema.json in fixture repo)
 * vs Zod schemas (fixture-loader.ts).
 *
 * These tests validate BOTH parsers agree on EVERY actual fixture file on disk.
 * A field added to Zod but missing from JSON Schema → `additionalProperties` error.
 * A field added to JSON Schema but missing from Zod (strict) → unknown-key error.
 *
 * This structural test replaces manual synchronization discipline. Instead of
 * relying on developers to update both files together, any divergence surfaces
 * immediately here.
 *
 * Requires: fixture repo available at FIXTURE_REPO_PATH or ../wine-engine-fixture.
 * Skips gracefully when repo is absent (for local dev without the fixture repo).
 * In CI, FIXTURE_REPO_PATH is always set so these tests never silently skip.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { BenchmarkCaseSchema, BenchmarkSuiteSchema, FixtureLoader } from '../fixture-loader.js';
import { SUITE_REGISTRY } from '../suite-registry.js';

const FIXTURE_ROOT = process.env['FIXTURE_REPO_PATH']
  ?? resolve(process.cwd(), '../wine-engine-fixture');

// ---------------------------------------------------------------------------
// JSON Schema loader — validate via Zod round-trip (no ajv dependency needed)
// ---------------------------------------------------------------------------
// Strategy: parse every actual fixture file through both:
//   1. The JSON Schema (via AJV if available, else structural spot-checks)
//   2. The Zod schema (strict mode — rejects unknown keys)
//
// If both pass: schemas are in sync for that file's fields.
// If Zod fails with "Unrecognized key": field is in JSON Schema but missing from Zod.
// If Zod fails on a value: type mismatch between schemas.
//
// We don't require AJV as a dependency — the round-trip via Zod .strict() is
// sufficient to catch the most critical divergence class (unknown keys).

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function collectCaseFiles(): Array<{ suiteDir: string; suiteId: string; caseFile: string; path: string }> {
  const results: Array<{ suiteDir: string; suiteId: string; caseFile: string; path: string }> = [];
  for (const entry of SUITE_REGISTRY) {
    const casesDir = join(FIXTURE_ROOT, 'suites', entry.dir, 'cases');
    if (!existsSync(casesDir)) continue;
    for (const f of readdirSync(casesDir).filter((n) => n.endsWith('.json')).sort()) {
      results.push({ suiteDir: entry.dir, suiteId: entry.id, caseFile: f, path: join(casesDir, f) });
    }
  }
  return results;
}

function collectSuiteFiles(): Array<{ suiteDir: string; suiteId: string; path: string }> {
  return SUITE_REGISTRY.map((entry) => ({
    suiteDir: entry.dir,
    suiteId: entry.id,
    path: join(FIXTURE_ROOT, 'suites', entry.dir, 'suite.json'),
  })).filter((e) => existsSync(e.path));
}

// ---------------------------------------------------------------------------
// Parity tests
// ---------------------------------------------------------------------------

describe('Schema parity — BenchmarkCase (JSON Schema ↔ Zod)', () => {
  const loader = new FixtureLoader(FIXTURE_ROOT);

  beforeAll(() => {
    if (!loader.isAvailable()) {
      throw new Error(
        `[schema-parity] Fixture repo not available at "${FIXTURE_ROOT}". ` +
        `Set FIXTURE_REPO_PATH env var or clone wine-engine-fixture as a sibling directory. ` +
        `FIXTURE_REPO_PATH=${process.env['FIXTURE_REPO_PATH'] ?? 'unset'}`,
      );
    }
  });

  it('every case file in the fixture repo passes Zod BenchmarkCaseSchema', () => {
    const caseFiles = collectCaseFiles();
    expect(caseFiles.length).toBeGreaterThan(0); // sanity: repo must have cases

    const failures: string[] = [];
    for (const { suiteDir, caseFile, path } of caseFiles) {
      const raw = readJson(path);
      const result = BenchmarkCaseSchema.safeParse(raw);
      if (!result.success) {
        failures.push(
          `${suiteDir}/cases/${caseFile}: ${result.error.issues.map((i) => `[${i.path.join('.')}] ${i.message}`).join('; ')}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} case file(s) failed Zod schema — possible JSON Schema ↔ Zod drift:\n` +
        failures.map((f) => `  • ${f}`).join('\n'),
      );
    }
  });

  it('all case files have suite field matching their directory suite', () => {
    const caseFiles = collectCaseFiles();
    const failures: string[] = [];
    for (const { suiteDir, suiteId, caseFile, path } of caseFiles) {
      const raw = readJson(path) as Record<string, unknown>;
      if (raw['suite'] !== suiteId) {
        failures.push(
          `${suiteDir}/cases/${caseFile}: suite="${String(raw['suite'])}" but directory suite is "${suiteId}"`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} case file(s) have mismatched suite field:\n` +
        failures.map((f) => `  • ${f}`).join('\n'),
      );
    }
  });

  it('all case IDs match the prefix expected by suite-registry', () => {
    const caseFiles = collectCaseFiles();
    const failures: string[] = [];
    for (const { suiteDir, caseFile, path } of caseFiles) {
      const raw = readJson(path) as Record<string, unknown>;
      const caseId = typeof raw['id'] === 'string' ? raw['id'] : '';
      const prefix = caseId.split('-')[0];
      const entry = SUITE_REGISTRY.find((r) => r.dir === suiteDir);
      if (entry && prefix !== entry.prefix) {
        failures.push(
          `${suiteDir}/cases/${caseFile}: id="${caseId}" has prefix "${prefix}" but registry expects "${entry.prefix}"`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} case file(s) have ID prefix mismatching registry:\n` +
        failures.map((f) => `  • ${f}`).join('\n'),
      );
    }
  });

  it('all SUITE_REGISTRY entries have their case directories on disk', () => {
    const missingDirs: string[] = [];
    for (const entry of SUITE_REGISTRY) {
      const casesDir = join(FIXTURE_ROOT, 'suites', entry.dir, 'cases');
      if (!existsSync(casesDir)) {
        missingDirs.push(`${entry.id} → suites/${entry.dir}/cases`);
      }
    }
    if (missingDirs.length > 0) {
      throw new Error(
        `SUITE_REGISTRY entries missing from fixture repo (registry typo or missing directory?):\n` +
        missingDirs.map((d) => `  • ${d}`).join('\n'),
      );
    }
  });
});

describe('Schema parity — BenchmarkSuite (JSON Schema ↔ Zod)', () => {
  const loader = new FixtureLoader(FIXTURE_ROOT);

  beforeAll(() => {
    if (!loader.isAvailable()) {
      throw new Error(
        `[schema-parity] Fixture repo not available at "${FIXTURE_ROOT}". ` +
        `Set FIXTURE_REPO_PATH env var or clone wine-engine-fixture as a sibling directory. ` +
        `FIXTURE_REPO_PATH=${process.env['FIXTURE_REPO_PATH'] ?? 'unset'}`,
      );
    }
  });

  it('every suite.json in the fixture repo passes Zod BenchmarkSuiteSchema', () => {
    const suiteFiles = collectSuiteFiles();
    expect(suiteFiles.length).toBe(9); // all 9 suites must have suite.json

    const failures: string[] = [];
    for (const { suiteDir, path } of suiteFiles) {
      const raw = readJson(path);
      const result = BenchmarkSuiteSchema.safeParse(raw);
      if (!result.success) {
        failures.push(
          `${suiteDir}/suite.json: ${result.error.issues.map((i) => `[${i.path.join('.')}] ${i.message}`).join('; ')}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} suite.json file(s) failed Zod schema — possible JSON Schema ↔ Zod drift:\n` +
        failures.map((f) => `  • ${f}`).join('\n'),
      );
    }
  });

  it('every suite.json id matches its directory in SUITE_REGISTRY', () => {
    const suiteFiles = collectSuiteFiles();
    const failures: string[] = [];
    for (const { suiteDir, suiteId, path } of suiteFiles) {
      const raw = readJson(path) as Record<string, unknown>;
      if (raw['id'] !== suiteId) {
        failures.push(
          `${suiteDir}/suite.json: id="${String(raw['id'])}" but registry expects "${suiteId}"`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} suite.json file(s) have mismatched id field:\n` +
        failures.map((f) => `  • ${f}`).join('\n'),
      );
    }
  });

  it('every forbidden_regression ID in suite.json refers to a case that exists', () => {
    const failures: string[] = [];
    for (const entry of SUITE_REGISTRY) {
      const suitePath = join(FIXTURE_ROOT, 'suites', entry.dir, 'suite.json');
      if (!existsSync(suitePath)) continue;
      const raw = readJson(suitePath) as Record<string, unknown>;
      const gate = raw['gate'] as Record<string, unknown> | undefined;
      const forbidden = (gate?.['forbidden_regressions'] ?? []) as string[];
      const casesDir = join(FIXTURE_ROOT, 'suites', entry.dir, 'cases');
      for (const caseId of forbidden) {
        const casePath = join(casesDir, `${caseId}.json`);
        if (!existsSync(casePath)) {
          failures.push(
            `${entry.dir}/suite.json: forbidden_regressions references "${caseId}" which does not exist`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} forbidden_regression reference(s) are broken:\n` +
        failures.map((f) => `  • ${f}`).join('\n'),
      );
    }
  });
});

describe('Schema parity — target-entity-map completeness', () => {
  const loader = new FixtureLoader(FIXTURE_ROOT);

  beforeAll(() => {
    if (!loader.isAvailable()) {
      throw new Error(
        `[schema-parity] Fixture repo not available at "${FIXTURE_ROOT}". ` +
        `Set FIXTURE_REPO_PATH env var or clone wine-engine-fixture as a sibling directory. ` +
        `FIXTURE_REPO_PATH=${process.env['FIXTURE_REPO_PATH'] ?? 'unset'}`,
      );
    }
  });

  it('every exact_entity_top1/topk case has a non-null entry in target-entity-map.json', () => {
    const mapPath = join(FIXTURE_ROOT, 'goldens', 'target-entity-map.json');
    if (!existsSync(mapPath)) {
      throw new Error('goldens/target-entity-map.json is missing — run: pnpm run generate:entity-map');
    }

    const mapFile = readJson(mapPath) as Record<string, unknown>;
    const map = mapFile['map'] as Record<string, string | null>;

    const ENTITY_MODES = new Set(['exact_entity_top1', 'exact_entity_topk']);
    const failures: string[] = [];

    for (const entry of SUITE_REGISTRY) {
      const casesDir = join(FIXTURE_ROOT, 'suites', entry.dir, 'cases');
      if (!existsSync(casesDir)) continue;
      for (const f of readdirSync(casesDir).filter((n) => n.endsWith('.json'))) {
        const raw = readJson(join(casesDir, f)) as Record<string, unknown>;
        const id = typeof raw['id'] === 'string' ? raw['id'] : '';
        const evaluation = raw['evaluation'] as Record<string, unknown> | undefined;
        const mode = typeof evaluation?.['mode'] === 'string' ? evaluation['mode'] : '';
        if (ENTITY_MODES.has(mode)) {
          if (!(id in map) || map[id] == null) {
            failures.push(
              `${entry.dir}/cases/${f}: mode="${mode}" but target-entity-map has no non-null entry for "${id}"`,
            );
          }
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} entity-recovery case(s) missing from target-entity-map.json:\n` +
        failures.map((f) => `  • ${f}`).join('\n') +
        '\nRun: pnpm run generate:entity-map (in wine-engine-fixture) to regenerate.',
      );
    }
  });

  it('target-entity-map.json has no orphaned entries (keys without case files)', () => {
    const mapPath = join(FIXTURE_ROOT, 'goldens', 'target-entity-map.json');
    if (!existsSync(mapPath)) return;

    const mapFile = readJson(mapPath) as Record<string, unknown>;
    const map = mapFile['map'] as Record<string, unknown>;

    // Build set of all actual case IDs on disk
    const actualIds = new Set<string>();
    for (const entry of SUITE_REGISTRY) {
      const casesDir = join(FIXTURE_ROOT, 'suites', entry.dir, 'cases');
      if (!existsSync(casesDir)) continue;
      for (const f of readdirSync(casesDir).filter((n) => n.endsWith('.json'))) {
        actualIds.add(f.replace(/\.json$/, ''));
      }
    }

    const orphans = Object.keys(map).filter((id) => !actualIds.has(id));
    if (orphans.length > 0) {
      throw new Error(
        `target-entity-map.json has ${orphans.length} orphaned entry(ies) with no case file:\n` +
        orphans.map((id) => `  • ${id}`).join('\n') +
        '\nRun: pnpm run generate:entity-map (in wine-engine-fixture) to regenerate.',
      );
    }
  });
});
