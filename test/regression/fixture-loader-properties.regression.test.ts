/**
 * Fixture loader — property-based regression suite (append-only).
 *
 * Locks SOTA++ invariants for `src/infrastructure/fixture/fixture-loader.ts`:
 *
 *   - **Schema enforcement**: malformed payloads NEVER parse silently — Zod
 *     surfaces a typed failure (Rule 7, Rule 12 of CLAUDE.md).
 *   - **Determinism**: parsing the same bytes always yields a deeply equal
 *     object (no Date.now leak, no Map iteration order leak, no env probe).
 *   - **Path safety**: assertSafePath rejects all relative paths and any
 *     absolute path that resolves outside the declared root (defence-in-depth
 *     against `../` traversal regardless of OS path normalisation).
 *   - **Encoding stability**:
 *       * UTF-8 BOM is stripped at the boundary (real-world: git autocrlf,
 *         Windows editors). A BOM-prefixed JSON file MUST parse identically
 *         to the same file without the BOM.
 *       * Korean strings are normalised to NFC at the boundary (real-world:
 *         macOS HFS+ filesystem returns NFD-decomposed code points). NFD
 *         input MUST be readable AND compare === to its NFC equivalent.
 *   - **Bounded size**: per-file reads have a domain-justified upper bound
 *     (DoS guard) — files beyond the bound throw a typed error rather than
 *     consuming unbounded heap.
 *   - **Empty / missing**: missing file paths propagate ENOENT, not a silent
 *     `undefined` or empty default that hides corpus loss.
 *
 * Append-only — never delete. See CLAUDE.md "Test discipline".
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  BenchmarkCaseSchema,
  BenchmarkSuiteSchema,
  FixtureLoader,
  MAX_FIXTURE_JSON_BYTES,
} from '../../src/infrastructure/fixture/fixture-loader.js';
import { ALL_SUITE_IDS, SUITE_ID_TO_DIR } from '../../src/infrastructure/fixture/suite-registry.js';

const FC_RUNS = 100;

// ---------------------------------------------------------------------------
// Helpers — build a synthetic fixture repo with arbitrary JSON content
// ---------------------------------------------------------------------------

function makeRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'fixture-loader-props-'));
  writeFileSync(join(root, 'README.md'), '# synthetic fixture repo');
  mkdirSync(join(root, 'suites'));
  return root;
}

function writeSuiteFile(root: string, suiteDir: string, body: string): string {
  const dir = join(root, 'suites', suiteDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'suite.json');
  writeFileSync(path, body, 'utf8');
  return path;
}

function writeCaseFile(root: string, suiteDir: string, fileName: string, body: string): string {
  const dir = join(root, 'suites', suiteDir, 'cases');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, body, 'utf8');
  return path;
}

const VALID_SUITE_BODY = JSON.stringify({
  id: 'exact_entity_recovery',
  name: 'Synthetic',
  description: 'For tests',
  primary_metrics: [{ name: 'top1_accuracy', description: 'Top-1' }],
  gate: {},
});

const MIN_CASE = {
  id: 'eek-001',
  suite: 'exact_entity_recovery',
  query: 'Opus One 2018',
  category: 'transliteration',
  language: 'en',
  difficulty: 'easy',
  evaluation: { mode: 'exact_entity_top1' },
};

// ---------------------------------------------------------------------------
// Property 1 — schema enforcement: malformed input NEVER parses
// ---------------------------------------------------------------------------

describe('property: malformed payload is always rejected (no silent default)', () => {
  it('arbitrary non-object input is rejected by BenchmarkCaseSchema', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.double(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.anything()),
        ),
        (notAnObject) => {
          const result = BenchmarkCaseSchema.safeParse(notAnObject);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('arbitrary string for evaluation.mode is rejected unless in enum', () => {
    const validModes = new Set([
      'exact_entity_top1', 'exact_entity_topk', 'clarify_allowed',
      'tool_sequence', 'answer_rubric', 'latency_slo', 'throughput_slo',
    ]);
    fc.assert(
      fc.property(fc.string(), (mode) => {
        const result = BenchmarkCaseSchema.safeParse({
          ...MIN_CASE,
          evaluation: { mode },
        });
        if (validModes.has(mode)) {
          expect(result.success).toBe(true);
        } else {
          expect(result.success).toBe(false);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('any unknown top-level key triggers .strict() rejection', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((k) =>
          !['id', 'suite', 'query', 'category', 'language', 'difficulty',
            'evaluation', 'provenance', 'tags', 'notes', 'added_version',
            'schema_version'].includes(k),
        ),
        fc.anything(),
        (extraKey, extraValue) => {
          const result = BenchmarkCaseSchema.safeParse({
            ...MIN_CASE,
            [extraKey]: extraValue,
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2 — determinism: same bytes → same parsed object
// ---------------------------------------------------------------------------

describe('property: same bytes parse to deeply equal output (determinism)', () => {
  it('BenchmarkCaseSchema.parse is deterministic over re-runs', () => {
    fc.assert(
      fc.property(
        // tag value influences nothing else — narrow but rich variation
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => /^[a-zA-Z0-9_-]+$/.test(s)),
        (tag) => {
          const payload = { ...MIN_CASE, tags: [tag] };
          const a = BenchmarkCaseSchema.safeParse(payload);
          const b = BenchmarkCaseSchema.safeParse(payload);
          expect(a.success).toBe(true);
          expect(b.success).toBe(true);
          if (a.success && b.success) {
            expect(a.data).toStrictEqual(b.data);
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('readJsonFile yields deeply-equal objects across two reads of the same file', async () => {
    const root = makeRepoRoot();
    try {
      const path = writeCaseFile(root, 'exact-entity-ko', 'eek-001.json', JSON.stringify(MIN_CASE));
      void path;
      const loader = new FixtureLoader(root);
      const a = await loader.loadCase('eek-001');
      const b = await loader.loadCase('eek-001');
      expect(a).toStrictEqual(b);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Property 3 — path safety
// ---------------------------------------------------------------------------

describe('property: assertSafePath always rejects traversal', () => {
  it('relative paths are rejected via loadCorpusNdjson when they escape root', async () => {
    const root = makeRepoRoot();
    try {
      const loader = new FixtureLoader(root);
      // Property: a path with arbitrary leading `../` segments that resolves
      // outside the repo root MUST throw.
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.string({ minLength: 1, maxLength: 16 }).filter((s) => /^[a-z0-9_-]+$/.test(s)),
          async (depth, leaf) => {
            const traversal = `${'../'.repeat(depth)}${leaf}`;
            // corpusPath applies assertSafePath synchronously
            expect(() => loader.corpusPath(traversal)).toThrow(/Path traversal blocked/);
          },
        ),
        { numRuns: FC_RUNS },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('paths that resolve INSIDE root are accepted regardless of `.` segments', () => {
    const root = makeRepoRoot();
    try {
      const loader = new FixtureLoader(root);
      // joining `./foo` inside root must succeed (no false positive)
      const safe = loader.corpusPath('corpora/sub/file.jsonl');
      expect(safe.startsWith(root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Property 4 — encoding stability
// ---------------------------------------------------------------------------

describe('encoding: UTF-8 BOM stripping and Korean NFC normalisation', () => {
  it('UTF-8 BOM-prefixed JSON parses identically to non-BOM version', async () => {
    const root = makeRepoRoot();
    try {
      const body = JSON.stringify(MIN_CASE);
      writeCaseFile(root, 'exact-entity-ko', 'eek-001.json', '﻿' + body);
      const loader = new FixtureLoader(root);
      const result = await loader.loadCase('eek-001');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('eek-001');
      expect(result?.query).toBe('Opus One 2018');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NFD-decomposed Korean is normalised to NFC at the boundary', async () => {
    const root = makeRepoRoot();
    try {
      const nfd = '오푸스원'.normalize('NFD');
      const nfc = '오푸스원'.normalize('NFC');
      // sanity: NFD and NFC are genuinely different byte sequences for Hangul
      expect(nfd).not.toBe(nfc);
      const body = JSON.stringify({ ...MIN_CASE, query: nfd, notes: nfd });
      writeCaseFile(root, 'exact-entity-ko', 'eek-001.json', body);
      const loader = new FixtureLoader(root);
      const result = await loader.loadCase('eek-001');
      expect(result).not.toBeNull();
      // After NFC normalisation at boundary, the string MUST equal the NFC form
      expect(result?.query).toBe(nfc);
      expect(result?.notes).toBe(nfc);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('property: any Korean syllable in NFD form round-trips to NFC after load', async () => {
    const root = makeRepoRoot();
    try {
      const loader = new FixtureLoader(root);
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[가-힣]{1,8}$/u),
          async (koWord) => {
            const nfd = koWord.normalize('NFD');
            const nfc = koWord.normalize('NFC');
            const fileName = 'eek-001.json';
            writeCaseFile(root, 'exact-entity-ko', fileName, JSON.stringify({ ...MIN_CASE, notes: nfd }));
            const result = await loader.loadCase('eek-001');
            expect(result).not.toBeNull();
            // SOTA: post-boundary string must be NFC regardless of input form
            expect(result?.notes).toBe(nfc);
          },
        ),
        { numRuns: FC_RUNS },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Property 5 — bounded size (DoS guard)
// ---------------------------------------------------------------------------

describe('DoS guard: per-file size cap', () => {
  it('readJsonFile rejects files larger than MAX_FIXTURE_JSON_BYTES with a typed error', async () => {
    const root = makeRepoRoot();
    try {
      // Exercise the throwing public path (`loadSuite`) directly. Keep case
      // files untouched so this test does not emit incidental "Failed to read
      // case file" warnings from the nullable `loadCase` surface.
      const padding = 'a'.repeat(MAX_FIXTURE_JSON_BYTES + 1024);
      const loader = new FixtureLoader(root);
      writeSuiteFile(root, 'exact-entity-ko', JSON.stringify({
        ...JSON.parse(VALID_SUITE_BODY),
        description: padding,
      }));
      await expect(loader.loadSuite('exact_entity_recovery')).rejects.toThrow(/exceeds .* byte limit|exceeds .* size limit|size limit/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('MAX_FIXTURE_JSON_BYTES is a positive finite constant', () => {
    expect(Number.isFinite(MAX_FIXTURE_JSON_BYTES)).toBe(true);
    expect(MAX_FIXTURE_JSON_BYTES).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Property 6 — empty / missing file behaviour
// ---------------------------------------------------------------------------

describe('missing-file semantics: typed Error, not silent undefined', () => {
  it('loadSuite throws when the suite.json is missing (does NOT silently return null)', async () => {
    const root = makeRepoRoot();
    try {
      const loader = new FixtureLoader(root);
      // Property: every registered suiteId is a string and loadSuite on each
      // of them throws when the underlying file is absent.
      for (const suiteId of ALL_SUITE_IDS) {
        const err = await loader.loadSuite(suiteId).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loadCase returns null (typed absence) when the case file is missing', async () => {
    const root = makeRepoRoot();
    try {
      const loader = new FixtureLoader(root);
      const result = await loader.loadCase('eek-999');
      expect(result).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('property: any well-formed unknown case ID returns null, never throws', async () => {
    const root = makeRepoRoot();
    try {
      const loader = new FixtureLoader(root);
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...Object.keys(SUITE_ID_TO_DIR).map((id) => id)),
          fc.integer({ min: 100, max: 999 }),
          async (_suiteId, n) => {
            // Use a registered prefix to exercise the "missing file" branch
            const result = await loader.loadCase(`eek-${n}`);
            expect(result).toBeNull();
          },
        ),
        { numRuns: FC_RUNS },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Property 7 — schema invariant: id prefix↔suite cross-validation never silently bypassed
// ---------------------------------------------------------------------------

describe('property: prefix↔suite cross-validation is total', () => {
  it('any case whose id prefix maps to a registered suite must match that suite field', () => {
    const prefixes = ['eek', 'asf', 'mse', 'nar', 'sfb', 'atu', 'aaq', 'plt', 'plo'] as const;
    const expectedSuite: Record<string, string> = {
      eek: 'exact_entity_recovery', asf: 'ambiguous_shortform', mse: 'mixed_script_entity',
      nar: 'noisy_attribute_recovery', sfb: 'search_feature_behavior', atu: 'agentic_tool_use',
      aaq: 'agentic_answer_quality', plt: 'performance_latency', plo: 'performance_load',
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...prefixes),
        fc.constantFrom(...prefixes),
        fc.integer({ min: 1, max: 999 }),
        (idPrefix, suitePrefix, n) => {
          const padded = String(n).padStart(3, '0');
          const id = `${idPrefix}-${padded}`;
          const suite = expectedSuite[suitePrefix];
          if (suite === undefined) return; // type-guard, can't happen
          const result = BenchmarkCaseSchema.safeParse({
            ...MIN_CASE,
            id,
            suite,
          });
          if (idPrefix === suitePrefix) {
            expect(result.success).toBe(true);
          } else {
            expect(result.success).toBe(false);
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8 — BenchmarkSuiteSchema strictness mirrors case schema
// ---------------------------------------------------------------------------

describe('property: BenchmarkSuiteSchema rejects unknown keys regardless of value type', () => {
  it('arbitrary extra key on suite payload triggers .strict() failure', () => {
    const baseSuite = {
      id: 'exact_entity_recovery',
      name: 'X',
      description: 'X',
      primary_metrics: [{ name: 'top1_accuracy', description: 'T' }],
      gate: {},
    };
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((k) =>
          !['id', 'name', 'description', 'version', 'primary_metrics', 'gate', 'tags'].includes(k),
        ),
        fc.anything(),
        (extraKey, extraValue) => {
          const result = BenchmarkSuiteSchema.safeParse({ ...baseSuite, [extraKey]: extraValue });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});
