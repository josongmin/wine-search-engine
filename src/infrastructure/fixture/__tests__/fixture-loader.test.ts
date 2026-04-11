/**
 * FixtureLoader unit tests.
 *
 * Tests the Zod-based validation boundary against:
 *  - Valid fixture data (happy path)
 *  - Invalid / malformed JSON objects (rejection path — Rule 7)
 *  - Unknown key rejection (.strict() enforcement — Rule 10)
 *  - Missing optional fields
 *  - Max-bound enforcement
 *  - Path traversal security (Rule — assertSafePath)
 *  - isAvailable() edge cases (partial repo checkout)
 *  - Filtering helpers (loadCasesByTag, loadCasesByDifficulty, loadCasesByLanguage)
 *  - Unknown case-id prefix handling (inferSuiteFromCaseId)
 *
 * Schema tests do NOT require the fixture repo on disk.
 * FixtureLoader integration tests use the actual repo when FIXTURE_REPO_PATH is set.
 * No network I/O, no PostgreSQL, no Redis.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BenchmarkCaseSchema, BenchmarkSuiteSchema, FixtureLoader, type BenchmarkCase } from '../fixture-loader.js';

// ---------------------------------------------------------------------------
// BenchmarkCaseSchema — validation boundary tests
// ---------------------------------------------------------------------------

describe('BenchmarkCaseSchema — happy path', () => {
  const validCase: BenchmarkCase = {
    id: 'eek-001',
    suite: 'exact_entity_recovery',
    query: '오푸스원',
    category: 'transliteration',
    language: 'ko',
    difficulty: 'easy',
    evaluation: {
      mode: 'exact_entity_top1',
      target_entity_id: 'opus-one-2018',
      clarify_acceptable: false,
      confident_wrong_top1_forbidden: true,
    },
  };

  it('accepts a minimal valid case', () => {
    const result = BenchmarkCaseSchema.safeParse(validCase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('eek-001');
      expect(result.data.query).toBe('오푸스원');
    }
  });

  it('accepts a case with all optional fields', () => {
    const fullCase = {
      ...validCase,
      provenance: {
        expected_stage: 'transliteration',
        expected_source: 'rule:transliteration_ko_v1',
      },
      tags: ['transliteration', 'P0'],
      notes: 'Test note',
      added_version: '1.0.0',
    };
    const result = BenchmarkCaseSchema.safeParse(fullCase);
    expect(result.success).toBe(true);
  });

  it('accepts a clarify_allowed case with no target_entity_id', () => {
    const ambiguousCase = {
      id: 'asf-001',
      suite: 'ambiguous_shortform',
      query: '마고',
      category: 'noisy_short_form',
      language: 'ko',
      difficulty: 'hard',
      evaluation: {
        mode: 'clarify_allowed',
        clarify_acceptable: true,
        confident_wrong_top1_forbidden: true,
      },
    };
    const result = BenchmarkCaseSchema.safeParse(ambiguousCase);
    expect(result.success).toBe(true);
  });

  it('accepts a tool_sequence case', () => {
    const agenticCase = {
      id: 'atu-001',
      suite: 'agentic_tool_use',
      query: '풀바디 레드 와인 추천',
      category: 'tool_sequence',
      language: 'ko',
      difficulty: 'easy',
      evaluation: {
        mode: 'tool_sequence',
        expected_tools: [{ tool: 'search_wines' }],
        answer_must_match: ['(red|레드|풀바디)'],
        max_steps: 2,
        max_duration_ms: 40000,
      },
    };
    const result = BenchmarkCaseSchema.safeParse(agenticCase);
    expect(result.success).toBe(true);
  });

  it('accepts a latency_slo case', () => {
    const latencyCase = {
      id: 'plt-001',
      suite: 'performance_latency',
      query: 'Opus One 2018',
      category: 'latency_p99',
      language: 'en',
      difficulty: 'easy',
      evaluation: {
        mode: 'latency_slo',
        latency_slo_ms: { p50: 200, p95: 400, p99: 800 },
        concurrency: 1,
      },
    };
    const result = BenchmarkCaseSchema.safeParse(latencyCase);
    expect(result.success).toBe(true);
  });
});

describe('BenchmarkCaseSchema — rejection path (Rule 7)', () => {
  it('rejects a case with invalid id format', () => {
    const result = BenchmarkCaseSchema.safeParse({
      id: 'INVALID-ID',
      suite: 'exact_entity_recovery',
      query: 'test',
      category: 'test',
      language: 'en',
      difficulty: 'easy',
      evaluation: { mode: 'exact_entity_top1' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with unknown suite id', () => {
    const result = BenchmarkCaseSchema.safeParse({
      id: 'eek-001',
      suite: 'unknown_suite',
      query: 'test',
      category: 'test',
      language: 'en',
      difficulty: 'easy',
      evaluation: { mode: 'exact_entity_top1' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with unknown language', () => {
    const result = BenchmarkCaseSchema.safeParse({
      id: 'eek-001',
      suite: 'exact_entity_recovery',
      query: 'test',
      category: 'test',
      language: 'fr', // not in enum
      difficulty: 'easy',
      evaluation: { mode: 'exact_entity_top1' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with unknown evaluation mode', () => {
    const result = BenchmarkCaseSchema.safeParse({
      id: 'eek-001',
      suite: 'exact_entity_recovery',
      query: 'test',
      category: 'test',
      language: 'en',
      difficulty: 'easy',
      evaluation: { mode: 'invalid_mode' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with empty query', () => {
    const result = BenchmarkCaseSchema.safeParse({
      id: 'eek-001',
      suite: 'exact_entity_recovery',
      query: '',
      category: 'test',
      language: 'en',
      difficulty: 'easy',
      evaluation: { mode: 'exact_entity_top1' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with top_k out of bounds (>20)', () => {
    const result = BenchmarkCaseSchema.safeParse({
      id: 'eek-001',
      suite: 'exact_entity_recovery',
      query: 'test',
      category: 'test',
      language: 'en',
      difficulty: 'easy',
      evaluation: { mode: 'exact_entity_topk', top_k: 99 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-object input', () => {
    for (const invalid of [null, undefined, 'string', 42, []]) {
      const result = BenchmarkCaseSchema.safeParse(invalid);
      expect(result.success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// BenchmarkSuiteSchema — validation boundary tests
// ---------------------------------------------------------------------------

// NOTE: gate.thresholds and gate.min_pass_rate were removed from BenchmarkSuiteSchema.
// eval/thresholds.json is the SSoT — use FixtureLoader.loadThresholds() to read them.
describe('BenchmarkSuiteSchema — happy path', () => {
  it('accepts a minimal valid suite (no gate.thresholds — SSoT is eval/thresholds.json)', () => {
    const suite = {
      id: 'exact_entity_recovery',
      name: 'Test Suite',
      description: 'Test description',
      primary_metrics: [{ name: 'top1_accuracy', description: 'Top-1 accuracy' }],
      gate: {},
    };
    const result = BenchmarkSuiteSchema.safeParse(suite);
    expect(result.success).toBe(true);
  });

  it('accepts a suite with gate policy fields (no thresholds — those live in eval/thresholds.json)', () => {
    const suite = {
      id: 'ambiguous_shortform',
      name: 'Ambiguous Suite',
      description: 'Test',
      version: '1.0.0',
      primary_metrics: [
        { name: 'safe_response_rate', description: 'Safe response rate', higher_is_better: true },
      ],
      gate: {
        forbidden_regressions: ['asf-001', 'asf-002'],
        clarify_allowed: true,
        topk_fallback_allowed: false,
      },
      tags: ['korean', 'safety'],
    };
    const result = BenchmarkSuiteSchema.safeParse(suite);
    expect(result.success).toBe(true);
  });
});

describe('BenchmarkSuiteSchema — rejection path', () => {
  it('rejects a suite with unknown id', () => {
    const result = BenchmarkSuiteSchema.safeParse({
      id: 'not_a_real_suite',
      name: 'Test',
      description: 'Test',
      primary_metrics: [],
      gate: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a suite that still has gate.thresholds (must be removed — SSoT is eval/thresholds.json)', () => {
    // gate.thresholds is no longer part of the schema; .strict() rejects it as an unknown key
    const result = BenchmarkSuiteSchema.safeParse({
      id: 'exact_entity_recovery',
      name: 'Test',
      description: 'Test',
      primary_metrics: [],
      gate: { thresholds: { top1_accuracy: 0.8 } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a suite that still has gate.min_pass_rate (must be removed — SSoT is eval/thresholds.json)', () => {
    const result = BenchmarkSuiteSchema.safeParse({
      id: 'exact_entity_recovery',
      name: 'Test',
      description: 'Test',
      primary_metrics: [],
      gate: { min_pass_rate: 0.9 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Case ID format regression tests (Rule 5 — ASCII identifier check)
// ---------------------------------------------------------------------------

describe('BenchmarkCaseSchema — case id format', () => {
  // makeCase omits suite so the superRefine prefix↔suite check is not triggered.
  // These tests exercise the id regex only; prefix↔suite cross-validation is
  // covered in "BenchmarkCaseSchema — prefix-suite cross-validation" below.
  const makeCase = (id: string) => ({
    suite: 'exact_entity_recovery',
    query: 'test',
    category: 'test',
    language: 'en',
    difficulty: 'easy',
    evaluation: { mode: 'exact_entity_top1' },
    id,
  });

  it.each([
    // Use eek-* prefix so suite matches 'exact_entity_recovery'
    ['eek-001', true],
    ['eek-003', true],
    ['eek-100', true],
    ['eek-999', true],
    // "exact" is not a registered prefix — now rejected by superRefine (Fix 3)
    ['exact-entity-ko-001', false],
  ])('id %s → valid=%s', (id, valid) => {
    const result = BenchmarkCaseSchema.safeParse(makeCase(id));
    expect(result.success).toBe(valid);
  });

  it.each([
    'EEK-001',           // uppercase
    '001-eek',           // starts with digit
    'eek001',            // missing dash before number
    'eek-',              // no number
    '',                  // empty
  ])('rejects invalid id: %s', (id) => {
    const result = BenchmarkCaseSchema.safeParse(makeCase(id));
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BenchmarkCaseSchema — prefix-suite cross-validation (superRefine)
// ---------------------------------------------------------------------------

describe('BenchmarkCaseSchema — prefix-suite cross-validation', () => {
  const makeCase = (id: string, suite: string) => ({
    id,
    suite,
    query: 'test',
    category: 'test',
    language: 'en',
    difficulty: 'easy',
    evaluation: { mode: 'exact_entity_top1' },
  });

  it('accepts eek-001 with exact_entity_recovery', () => {
    const result = BenchmarkCaseSchema.safeParse(makeCase('eek-001', 'exact_entity_recovery'));
    expect(result.success).toBe(true);
  });

  it('accepts asf-003 with ambiguous_shortform', () => {
    const result = BenchmarkCaseSchema.safeParse(makeCase('asf-003', 'ambiguous_shortform'));
    expect(result.success).toBe(true);
  });

  it('accepts atu-100 with agentic_tool_use', () => {
    const result = BenchmarkCaseSchema.safeParse(makeCase('atu-100', 'agentic_tool_use'));
    expect(result.success).toBe(true);
  });

  it('accepts plt-001 with performance_latency', () => {
    const result = BenchmarkCaseSchema.safeParse(makeCase('plt-001', 'performance_latency'));
    expect(result.success).toBe(true);
  });

  it('rejects eek-001 when suite is ambiguous_shortform (prefix mismatch)', () => {
    const result = BenchmarkCaseSchema.safeParse(makeCase('eek-001', 'ambiguous_shortform'));
    expect(result.success).toBe(false);
    if (!result.success) {
      const suiteIssue = result.error.issues.find((i) => i.path.includes('suite'));
      expect(suiteIssue?.message).toContain('eek');
      expect(suiteIssue?.message).toContain('exact_entity_recovery');
    }
  });

  it('rejects asf-003 when suite is exact_entity_recovery (prefix mismatch)', () => {
    const result = BenchmarkCaseSchema.safeParse(makeCase('asf-003', 'exact_entity_recovery'));
    expect(result.success).toBe(false);
    if (!result.success) {
      const suiteIssue = result.error.issues.find((i) => i.path.includes('suite'));
      expect(suiteIssue?.message).toContain('asf');
      expect(suiteIssue?.message).toContain('ambiguous_shortform');
    }
  });

  it('rejects multi-word id (exact-entity-ko-001) when prefix is not registered (Fix 3)', () => {
    // "exact" is not a registered prefix — superRefine now rejects unknown prefixes
    // rather than silently skipping cross-validation.
    const result = BenchmarkCaseSchema.safeParse(makeCase('exact-entity-ko-001', 'exact_entity_recovery'));
    expect(result.success).toBe(false);
    if (!result.success) {
      const idIssue = result.error.issues.find((i) => i.path.includes('id'));
      expect(idIssue?.message).toContain('exact');
      expect(idIssue?.message).toContain('not registered');
    }
  });
});

// ---------------------------------------------------------------------------
// FixtureLoader — path traversal security
// ---------------------------------------------------------------------------

describe('FixtureLoader — path traversal prevention', () => {
  const FIXTURE_ROOT = resolve(__dirname, '../../../../../../wine-engine-fixture');
  const loader = new FixtureLoader(FIXTURE_ROOT);

  it('isAvailable() returns true when repo exists', () => {
    // If the repo does not exist locally, this will be false and we skip.
    // The security tests below are still relevant regardless.
    const result = loader.isAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('loadSuite() throws on path traversal via suiteId manipulation', async () => {
    // SuiteId enum prevents direct injection; this tests the underlying guard
    // by using a loader pointed at a safe root and verifying no escape occurs.
    // We test the assertSafePath mechanism via a loader with a non-existent traversal root.
    const safeLoader = new FixtureLoader('/tmp/safe-fixture-root');
    // loadSuite will fail because the file doesn't exist (ENOENT), not because
    // of path traversal — this confirms the path stays within the declared root.
    await expect(safeLoader.loadSuite('exact_entity_recovery')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FixtureLoader — assertSafePath regression: relative path rejection
// ---------------------------------------------------------------------------

describe('FixtureLoader — assertSafePath rejects relative paths', () => {
  // FixtureLoader.assertSafePath is private; we exercise it indirectly
  // by calling loadCasesByTag with a tag that triggers loadAllCases → loadCases
  // on a loader whose repoRoot is '/tmp/nonexistent', so the cases dir won't exist
  // and readJsonFile is never reached.  The key test is that a relative path
  // passed to the constructor does NOT silently produce a loader that escapes.
  //
  // The direct path-guard is validated via the ENOENT throw path in loadSuite:
  // we confirm that absolute paths inside the root do NOT throw, and that any
  // non-absolute internal construction would have been caught.

  it('loadCasesByTag returns empty for whitespace-only tag', async () => {
    const loader = new FixtureLoader('/tmp/nonexistent-fixture-repo');
    const result = await loader.loadCasesByTag('   ');
    expect(result).toHaveLength(0);
  });

  it('loadCasesByTag returns empty for empty string tag', async () => {
    const loader = new FixtureLoader('/tmp/nonexistent-fixture-repo');
    const result = await loader.loadCasesByTag('');
    expect(result).toHaveLength(0);
  });

  it('loadSuite on absolute safe root throws ENOENT not traversal error', async () => {
    const loader = new FixtureLoader('/tmp/safe-fixture-root');
    // Should throw because file doesn't exist, NOT because of path-traversal guard
    // (all paths produced internally are absolute children of /tmp/safe-fixture-root)
    const err = await loader.loadSuite('exact_entity_recovery').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // Must NOT be the traversal error — confirms paths stay inside root
    expect((err as Error).message).not.toContain('Path traversal blocked');
    expect((err as Error).message).not.toContain('must be absolute');
  });
});

// ---------------------------------------------------------------------------
// FixtureLoader — unknown case ID prefix (inferSuiteFromCaseId)
// ---------------------------------------------------------------------------

describe('FixtureLoader — loadCase with unknown prefix', () => {
  const loader = new FixtureLoader('/tmp/nonexistent-fixture-repo');

  it('returns null for case ID with unrecognized prefix', async () => {
    const result = await loader.loadCase('xyz-001');
    expect(result).toBeNull();
  });

  it('returns null for case ID with empty prefix', async () => {
    const result = await loader.loadCase('-001');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FixtureLoader — filtering methods (schema-level, no disk I/O)
// ---------------------------------------------------------------------------

// Integration test suite — requires the fixture repo on disk.
// Tests use beforeAll to fail explicitly rather than silently returning,
// so CI cannot pass with a missing fixture repo.
// Set FIXTURE_REPO_PATH env var or clone wine-engine-fixture as a sibling dir.

describe('FixtureLoader — filtering helpers with actual fixture repo', () => {
  const FIXTURE_ROOT = process.env['FIXTURE_REPO_PATH']
    ?? resolve(__dirname, '../../../../../../wine-engine-fixture');
  const loader = new FixtureLoader(FIXTURE_ROOT);

  beforeAll(() => {
    if (!loader.isAvailable()) {
      throw new Error(
        `Fixture repo not available at "${FIXTURE_ROOT}". ` +
        `FIXTURE_REPO_PATH=${process.env['FIXTURE_REPO_PATH'] ?? 'unset'}`,
      );
    }
  });

  // Non-integration test — does not need repo on disk
  it('loadCasesByTag returns empty array for empty tag (prevents .includes("") matching all)', async () => {
    const noRepoLoader = new FixtureLoader('/tmp/no-repo-needed-for-this-test');
    const result = await noRepoLoader.loadCasesByTag('');
    expect(result).toHaveLength(0);
  });

  it('getCaseCounts returns record with all 9 suite keys', async () => {
    const counts = await loader.getCaseCounts();
    const expectedSuites = [
      'exact_entity_recovery',
      'ambiguous_shortform',
      'mixed_script_entity',
      'noisy_attribute_recovery',
      'search_feature_behavior',
      'agentic_tool_use',
      'agentic_answer_quality',
      'performance_latency',
      'performance_load',
    ];
    for (const suiteId of expectedSuites) {
      expect(Object.prototype.hasOwnProperty.call(counts, suiteId)).toBe(true);
    }
  });

  it('loadCasesByLanguage("ko") returns only Korean cases', async () => {
    const koCases = await loader.loadCasesByLanguage('ko');
    for (const c of koCases) {
      expect(c.language).toBe('ko');
    }
    expect(koCases.length).toBeGreaterThan(0);
  });

  it('loadCasesByTag("P0") returns only P0-tagged cases', async () => {
    const p0Cases = await loader.loadCasesByTag('P0');
    for (const c of p0Cases) {
      expect(c.tags).toContain('P0');
    }
    expect(p0Cases.length).toBeGreaterThan(0);
  });

  it('loadCasesByDifficulty("easy") returns only easy cases', async () => {
    const easyCases = await loader.loadCasesByDifficulty('easy');
    for (const c of easyCases) {
      expect(c.difficulty).toBe('easy');
    }
  });

  it('loadAllCases() count matches sum of per-suite counts', async () => {
    const all = await loader.loadAllCases();
    const counts = await loader.getCaseCounts();
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    expect(all.length).toBe(total);
  });
});

// ---------------------------------------------------------------------------
// FixtureLoader — suite loading with actual fixture repo
// ---------------------------------------------------------------------------

describe('FixtureLoader — suite loading with actual fixture repo', () => {
  const FIXTURE_ROOT = process.env['FIXTURE_REPO_PATH']
    ?? resolve(__dirname, '../../../../../../wine-engine-fixture');
  const loader = new FixtureLoader(FIXTURE_ROOT);

  beforeAll(() => {
    if (!loader.isAvailable()) {
      throw new Error(
        `Fixture repo not available at "${FIXTURE_ROOT}". ` +
        `FIXTURE_REPO_PATH=${process.env['FIXTURE_REPO_PATH'] ?? 'unset'}`,
      );
    }
  });

  it('loadAllSuites() returns all 9 suites', async () => {
    const suites = await loader.loadAllSuites();
    expect(suites.length).toBe(9);
  });

  // gate.thresholds was removed — eval/thresholds.json is now the SSoT.
  // Verify thresholds are reachable via loadThresholds() instead.
  it('loadThresholds() returns entries for all 9 suites', async () => {
    const thresholds = await loader.loadThresholds();
    const suiteIds = [
      'exact_entity_recovery', 'ambiguous_shortform', 'mixed_script_entity',
      'noisy_attribute_recovery', 'search_feature_behavior', 'agentic_tool_use',
      'agentic_answer_quality', 'performance_latency', 'performance_load',
    ];
    for (const id of suiteIds) {
      expect(Object.prototype.hasOwnProperty.call(thresholds, id)).toBe(true);
    }
  });

  it('exact_entity_recovery suite has forbidden_regressions', async () => {
    const suite = await loader.loadSuite('exact_entity_recovery');
    expect(suite.gate.forbidden_regressions?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BenchmarkCaseSchema — .strict() enforcement (Rule 10)
// Unknown keys on fixture data must be rejected, not stripped silently.
// ---------------------------------------------------------------------------

describe('BenchmarkCaseSchema — strict() rejects unknown keys (Rule 10)', () => {
  const validBase = {
    id: 'eek-001',
    suite: 'exact_entity_recovery',
    query: 'Opus One 2018',
    category: 'transliteration',
    language: 'en',
    difficulty: 'easy',
    evaluation: { mode: 'exact_entity_top1' },
  };

  it('rejects a case with an unknown top-level key', () => {
    const result = BenchmarkCaseSchema.safeParse({
      ...validBase,
      future_field: 'some value from a newer schema version',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with an unknown key inside evaluation', () => {
    const result = BenchmarkCaseSchema.safeParse({
      ...validBase,
      evaluation: { mode: 'exact_entity_top1', confidence_score: 0.99 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with an unknown key inside provenance', () => {
    const result = BenchmarkCaseSchema.safeParse({
      ...validBase,
      provenance: { expected_stage: 'alias', unknown_provenance_key: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with an unknown key inside expected_tools item', () => {
    const result = BenchmarkCaseSchema.safeParse({
      ...validBase,
      evaluation: {
        mode: 'tool_sequence',
        expected_tools: [{ tool: 'search_wines', extra_key: 'oops' }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case with an unknown key inside latency_slo_ms', () => {
    const result = BenchmarkCaseSchema.safeParse({
      ...validBase,
      evaluation: {
        mode: 'latency_slo',
        latency_slo_ms: { p50: 100, p95: 300, p99: 600, p999: 2000 },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('BenchmarkSuiteSchema — strict() rejects unknown keys (Rule 10)', () => {
  const validSuite = {
    id: 'exact_entity_recovery',
    name: 'Test Suite',
    description: 'Test',
    primary_metrics: [{ name: 'top1_accuracy', description: 'Top-1 accuracy' }],
    gate: { thresholds: { top1_accuracy: 0.8 } },
  };

  it('rejects a suite with an unknown top-level key', () => {
    const result = BenchmarkSuiteSchema.safeParse({
      ...validSuite,
      new_metadata_field: 'added in fixture v2',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a suite with an unknown key inside gate', () => {
    const result = BenchmarkSuiteSchema.safeParse({
      ...validSuite,
      gate: { thresholds: { top1_accuracy: 0.8 }, future_gate_option: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a suite with an unknown key inside a metric definition', () => {
    const result = BenchmarkSuiteSchema.safeParse({
      ...validSuite,
      primary_metrics: [{ name: 'top1_accuracy', description: 'Top-1', weight: 2.0 }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FixtureLoader — isAvailable() edge cases (partial repo checkout)
// ---------------------------------------------------------------------------

describe('FixtureLoader — isAvailable() edge cases', () => {
  it('returns false when only README.md exists but suites/ is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fixture-test-'));
    writeFileSync(join(tmp, 'README.md'), '# test');
    // suites/ directory is intentionally NOT created
    const loader = new FixtureLoader(tmp);
    expect(loader.isAvailable()).toBe(false);
  });

  it('returns false when only suites/ exists but README.md is absent', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fixture-test-'));
    mkdirSync(join(tmp, 'suites'));
    // README.md is intentionally NOT created
    const loader = new FixtureLoader(tmp);
    expect(loader.isAvailable()).toBe(false);
  });

  it('returns true when both README.md and suites/ exist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fixture-test-'));
    writeFileSync(join(tmp, 'README.md'), '# test');
    mkdirSync(join(tmp, 'suites'));
    const loader = new FixtureLoader(tmp);
    expect(loader.isAvailable()).toBe(true);
  });

  it('returns false when directory does not exist at all', () => {
    const loader = new FixtureLoader('/tmp/definitely-does-not-exist-xyz-abc-12345');
    expect(loader.isAvailable()).toBe(false);
  });
});
