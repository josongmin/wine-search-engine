/**
 * FixtureLoader — reads benchmark cases and suites from the external
 * wine-engine-fixture repository (ADR-004: Central Benchmark Fixture Governance).
 *
 * The fixture repository path is resolved in priority order:
 *   1. Constructor argument
 *   2. FIXTURE_REPO_PATH env var
 *   3. Default: sibling directory `../wine-engine-fixture` relative to cwd
 *
 * All external data is validated with Zod before use (Rule 12: never cast JSON directly).
 *
 * **Unknown key policy (Rule 10):**
 * All case/suite Zod schemas use `.strict()` to reject unrecognised keys.
 * The fixture JSON Schemas (`schema/*.schema.json`) also have `additionalProperties: false`.
 * Both contracts must stay in sync — adding a field to fixture files requires updating
 * BOTH the JSON schema AND the Zod schema in this file, with a corresponding
 * changelog entry in the fixture repo.
 *
 * Exception to Rule 10 does NOT apply here: fixture files are version-controlled data,
 * not LLM-generated tool-call payloads. `.strict()` is correct and intentional.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { z } from 'zod';

import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { ALL_SUITE_IDS, CASE_PREFIX_TO_SUITE, SUITE_ID_TO_DIR, type SuiteId } from './suite-registry.js';

export type { SuiteId } from './suite-registry.js';

const log = bootstrapLogger.child({ component: 'FixtureLoader' });

// ---------------------------------------------------------------------------
// Max-bounds (domain: suites have O(100) cases, catalogs O(1000) entries)
// ---------------------------------------------------------------------------

/** Maximum cases loaded per suite (prevents runaway directory scans). */
const MAX_CASES_PER_SUITE = 500;

/** Maximum entries in a catalog file. */
const MAX_CATALOG_ENTRIES = 2000;

/** Maximum allowed top_k value in exact_entity_topk evaluation (>20 is nonsensical for wine search). */
const MAX_TOP_K = 20;

/** Minimum query string length. */
const MIN_QUERY_LENGTH = 1;

/** Maximum query string length (domain: no realistic wine search exceeds 500 chars). */
const MAX_QUERY_LENGTH = 500;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
/** 20 MB — maximum NDJSON corpus size for full in-memory load.
 *  Based on: largest expected gold corpus ~2K entries × ~500 bytes/entry = ~1 MB.
 *  20 MB is a 20× safety margin; files beyond this must use streaming readline. */
const MAX_CORPUS_LOAD_MB = 20;
const MAX_CORPUS_LOAD_BYTES = MAX_CORPUS_LOAD_MB * BYTES_PER_MB;

// ---------------------------------------------------------------------------
// Zod schemas — strict() to catch schema drift at the source boundary
// ---------------------------------------------------------------------------

const SuiteIdSchema = z.enum(ALL_SUITE_IDS);

// .strict() is applied to every schema — fixture files are version-controlled data
// (not LLM output), so unknown keys indicate schema drift and must surface as errors.
// Mirrors the `additionalProperties: false` constraint in schema/*.schema.json.

const EvaluationSchema = z.object({
  mode: z.enum([
    'exact_entity_top1',
    'exact_entity_topk',
    'clarify_allowed',
    'tool_sequence',
    'answer_rubric',
    'latency_slo',
    'throughput_slo',
  ]),
  target_entity_id: z.string().optional(),
  top_k: z.number().int().min(1).max(MAX_TOP_K).optional(),
  clarify_acceptable: z.boolean().optional(),
  confident_wrong_top1_forbidden: z.boolean().optional(),
  expected_tools: z.array(z.object({
    tool: z.string(),
    input_contains: z.array(z.string()).optional(),
    optional: z.boolean().default(false),
  }).strict()).optional(),
  answer_must_match: z.array(z.string()).optional(),
  answer_must_not_match: z.array(z.string()).optional(),
  rubric: z.string().optional(),
  max_steps: z.number().int().min(1).optional(),
  max_duration_ms: z.number().int().min(1).optional(),
  latency_slo_ms: z.object({
    p50: z.number().int().optional(),
    p95: z.number().int().optional(),
    p99: z.number().int().optional(),
  }).strict().optional(),
  throughput_slo_rps: z.number().optional(),
  concurrency: z.number().int().optional(),
}).strict();

const ProvenanceSchema = z.object({
  expected_stage: z.string().optional(),
  expected_source: z.string().optional(),
}).strict().optional();

/** Validated benchmark case contract. */
export const BenchmarkCaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]+-\d{3,}$/),
  suite: SuiteIdSchema,
  query: z.string().min(MIN_QUERY_LENGTH).max(MAX_QUERY_LENGTH),
  category: z.string(),
  language: z.enum(['ko', 'en', 'mixed']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  evaluation: EvaluationSchema,
  provenance: ProvenanceSchema,
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  added_version: z.string().optional(),
}).strict().superRefine((val, ctx) => {
  const prefix = val.id.split('-')[0];
  if (prefix == null || CASE_PREFIX_TO_SUITE[prefix] === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: `Case ID prefix "${prefix ?? ''}" is not registered in SUITE_REGISTRY (known prefixes: ${Object.keys(CASE_PREFIX_TO_SUITE).sort().join(', ')})`,
    });
    return z.NEVER;
  }
  const expectedSuite = CASE_PREFIX_TO_SUITE[prefix];
  if (expectedSuite !== val.suite) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['suite'],
      message: `Case ID prefix "${prefix}" implies suite "${expectedSuite}" but suite field is "${val.suite}"`,
    });
  }
});

export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

// NOTE: thresholds and min_pass_rate have been removed from GateSchema.
// eval/thresholds.json is the single source of truth for all threshold values.
// Benchmark runners must call loadThresholds() instead of reading gate.thresholds.
const GateSchema = z.object({
  forbidden_regressions: z.array(z.string()).optional(),
  clarify_allowed: z.boolean().optional(),
  topk_fallback_allowed: z.boolean().optional(),
}).strict();

const MetricDefSchema = z.object({
  name: z.string(),
  description: z.string(),
  higher_is_better: z.boolean().optional(),
}).strict();

/** Validated benchmark suite definition. */
export const BenchmarkSuiteSchema = z.object({
  id: SuiteIdSchema,
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  primary_metrics: z.array(MetricDefSchema),
  gate: GateSchema,
  tags: z.array(z.string()).optional(),
}).strict();

type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;

const AliasSurfaceEntrySchema = z.object({
  surface_form: z.string(),
  entity_id: z.string(),
  canonical_label: z.string(),
  confidence: z.number().finite().min(0).max(1),
  variant_type: z.string().optional(),
  provenance: z.string().optional(),
  notes: z.string().optional(),
}).strict();

type AliasSurfaceEntry = z.infer<typeof AliasSurfaceEntrySchema>;

// ---------------------------------------------------------------------------
// FixtureLoader
// ---------------------------------------------------------------------------

/**
 * Reads and validates benchmark fixtures from the external wine-engine-fixture
 * repository.
 *
 * All data is validated with Zod at the external-data boundary. Unknown keys
 * are REJECTED (schemas use `.strict()`) so that schema drift between the
 * fixture repo and this engine surfaces immediately rather than silently.
 * To add a new field to fixture files, update both the JSON schema in the
 * fixture repo and the Zod schema in this file.
 */
export class FixtureLoader {
  private readonly repoRoot: string;

  constructor(repoPath?: string) {
    const rawPath = repoPath
      ?? process.env['FIXTURE_REPO_PATH']
      ?? resolve(process.cwd(), '..', 'wine-engine-fixture');

    // Path normalisation — resolve to absolute, strip trailing separators.
    this.repoRoot = normalize(isAbsolute(rawPath) ? rawPath : resolve(rawPath));

    if (!existsSync(this.repoRoot)) {
      log.warn(
        { repoRoot: this.repoRoot },
        'Fixture repository not found — benchmark tests will be skipped. ' +
        'Set FIXTURE_REPO_PATH or clone wine-engine-fixture as a sibling directory.',
      );
    }
  }

  /**
   * Guards all internal file reads against path traversal.
   *
   * Two checks are applied:
   * 1. Relative paths are rejected unconditionally — a relative path like
   *    `../etc/passwd` would pass `normalize()` intact and then fail the
   *    `startsWith(repoRoot)` test only if repoRoot itself doesn't start with
   *    that prefix.  Requiring absolute paths is a defence-in-depth layer that
   *    removes the ambiguity entirely.
   * 2. After normalization the path must be inside repoRoot (or equal to it).
   *
   * @throws if the path is relative or escapes repoRoot.
   */
  private assertSafePath(filePath: string): void {
    if (!isAbsolute(filePath)) {
      throw new Error(
        `Fixture path must be absolute: "${filePath}"`,
      );
    }
    const normalized = normalize(filePath);
    if (!normalized.startsWith(this.repoRoot + sep) && normalized !== this.repoRoot) {
      throw new Error(
        `Path traversal blocked: "${filePath}" resolves outside fixture root "${this.repoRoot}"`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Suite-level loading
  // ---------------------------------------------------------------------------

  /**
   * Loads and validates the suite.json definition for a given suite.
   *
   * @throws if the suite.json is missing or fails Zod validation.
   */
  async loadSuite(suiteId: SuiteId): Promise<BenchmarkSuite> {
    const dir = SUITE_ID_TO_DIR[suiteId];
    const path = join(this.repoRoot, 'suites', dir, 'suite.json');
    const raw = await this.readJsonFile(path);
    const result = BenchmarkSuiteSchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `suite.json validation failed for ${suiteId}: ${result.error.message}`,
      );
    }
    return result.data;
  }

  /**
   * Loads all suite definitions from the suites/ directory in parallel.
   *
   * **Error handling differs from `loadSuite()`** by design:
   * - `loadSuite()` throws — callers that request a specific suite must know
   *   about failures so they can abort or report accurately.
   * - `loadAllSuites()` skips with a warning — one corrupt suite.json should
   *   not prevent the other 8 suites from loading. Callers that need all-or-
   *   nothing semantics must compare the result length against `ALL_SUITE_IDS`.
   *
   * Zod validation failures are logged at `error` level (schema drift, not
   * transient I/O) while missing files are logged at `warn` level.
   */
  async loadAllSuites(): Promise<readonly BenchmarkSuite[]> {
    const results = await Promise.all(
      (ALL_SUITE_IDS as readonly SuiteId[]).map(async (suiteId) => {
        try {
          return await this.loadSuite(suiteId);
        } catch (err) {
          const nodeErr = err as NodeJS.ErrnoException;
          if (nodeErr.code === 'ENOENT') {
            log.warn({ suiteId }, 'Suite file not found — skipping');
          } else if (err instanceof Error && err.message.includes('validation failed')) {
            log.error({ err, suiteId }, 'Suite schema validation failed — possible schema drift');
          } else {
            log.warn({ err, suiteId }, 'Failed to load suite definition — skipping');
          }
          return null;
        }
      }),
    );
    return results.filter((s): s is BenchmarkSuite => s !== null);
  }

  // ---------------------------------------------------------------------------
  // Case loading
  // ---------------------------------------------------------------------------

  /**
   * Loads all benchmark cases for a given suite, validated against
   * BenchmarkCaseSchema. Cases that fail validation are skipped with a warning.
   *
   * @returns Validated cases, capped at MAX_CASES_PER_SUITE.
   */
  async loadCases(suiteId: SuiteId): Promise<readonly BenchmarkCase[]> {
    const dir = SUITE_ID_TO_DIR[suiteId];
    const casesDir = join(this.repoRoot, 'suites', dir, 'cases');

    if (!existsSync(casesDir)) {
      log.warn({ suiteId, casesDir }, 'Cases directory not found — returning empty case list');
      return [];
    }

    let entries: string[];
    try {
      entries = await readdir(casesDir);
    } catch (err) {
      log.warn({ err, casesDir }, 'Failed to read cases directory');
      return [];
    }

    const jsonFiles = entries
      .filter((f) => f.endsWith('.json'))
      .sort() // deterministic order
      .slice(0, MAX_CASES_PER_SUITE);

    const cases: BenchmarkCase[] = [];
    for (const file of jsonFiles) {
      const path = join(casesDir, file);
      try {
        const raw = await this.readJsonFile(path);
        const result = BenchmarkCaseSchema.safeParse(raw);
        if (!result.success) {
          log.warn(
            { path, issues: result.error.issues },
            'Benchmark case failed schema validation — skipping',
          );
          continue;
        }
        cases.push(result.data);
      } catch (err) {
        log.warn({ err, path }, 'Failed to read case file — skipping');
      }
    }

    return cases;
  }

  /**
   * Loads a single benchmark case by its ID.
   *
   * Scans the appropriate suite directory for a file matching the ID prefix.
   * Returns null if not found.
   */
  async loadCase(caseId: string): Promise<BenchmarkCase | null> {
    // Derive suite from the ID prefix (e.g. eek-001 → exact_entity_recovery)
    const suiteId = this.inferSuiteFromCaseId(caseId);
    if (suiteId == null) {
      log.warn({ caseId }, 'Cannot infer suite from case ID — unknown prefix');
      return null;
    }

    const dir = SUITE_ID_TO_DIR[suiteId];
    const path = join(this.repoRoot, 'suites', dir, 'cases', `${caseId}.json`);

    if (!existsSync(path)) {
      return null;
    }

    try {
      const raw = await this.readJsonFile(path);
      const result = BenchmarkCaseSchema.safeParse(raw);
      if (!result.success) {
        log.warn({ path, caseId, issues: result.error.issues }, 'Case failed validation');
        return null;
      }
      return result.data;
    } catch (err) {
      log.warn({ err, path }, 'Failed to read case file');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Catalog loading
  // ---------------------------------------------------------------------------

  /**
   * Loads Korean alias surface-form catalog from catalogs/alias-surface-ko.json.
   * Returns an empty array if the catalog is missing or invalid.
   */
  async loadKoreanAliasCatalog(): Promise<readonly AliasSurfaceEntry[]> {
    const path = join(this.repoRoot, 'catalogs', 'alias-surface-ko.json');
    return this.loadCatalogEntries(path, AliasSurfaceEntrySchema, 'entries');
  }

  /**
   * Loads the canonical entities registry from goldens/canonical-entities.json.
   *
   * Returns raw unknown[] — callers should validate with their own domain schema.
   */
  async loadCanonicalEntities(): Promise<readonly unknown[]> {
    const path = join(this.repoRoot, 'goldens', 'canonical-entities.json');
    try {
      const raw = await this.readJsonFile(path);
      if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as Record<string, unknown>)['entities'])) {
        log.warn({ path }, 'canonical-entities.json has unexpected shape');
        return [];
      }
      return ((raw as Record<string, unknown>)['entities'] as unknown[]).slice(0, MAX_CATALOG_ENTRIES);
    } catch (err) {
      log.warn({ err, path }, 'Failed to load canonical entities');
      return [];
    }
  }

  /**
   * Loads the target entity map (case-id → entity-id) from goldens/target-entity-map.json.
   * Returns an empty record if unavailable.
   */
  async loadTargetEntityMap(): Promise<Readonly<Record<string, string>>> {
    const path = join(this.repoRoot, 'goldens', 'target-entity-map.json');
    try {
      const raw = await this.readJsonFile(path);
      if (typeof raw !== 'object' || raw === null) return {};
      const map = (raw as Record<string, unknown>)['map'];
      if (typeof map !== 'object' || map === null) return {};
      // Only include entries whose value is a non-null string.
      // Null values (e.g. performance/attribute cases that have no target entity)
      // are intentionally excluded — callers that need to distinguish "no target"
      // from "not found" should check the raw map directly via readJsonFile.
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
        if (typeof v === 'string') {
          result[k] = v;
        }
      }
      return result;
    } catch (err) {
      log.warn({ err, path }, 'Failed to load target entity map');
      return {};
    }
  }

  /**
   * Loads eval thresholds from eval/thresholds.json.
   *
   * Returns the raw `suites` map. Callers are responsible for extracting the
   * specific suite they need.
   */
  async loadThresholds(): Promise<Readonly<Record<string, unknown>>> {
    const path = join(this.repoRoot, 'eval', 'thresholds.json');
    try {
      const raw = await this.readJsonFile(path);
      if (typeof raw !== 'object' || raw === null) return {};
      const suites = (raw as Record<string, unknown>)['suites'];
      if (typeof suites !== 'object' || suites === null) return {};
      return suites as Record<string, unknown>;
    } catch (err) {
      log.warn({ err, path }, 'Failed to load thresholds');
      return {};
    }
  }

  /**
   * ADR-005 Workstream D/E: loads a corpus NDJSON/JSONL file from the
   * external fixture repository.
   *
   * @param corpusRelPath - path relative to fixture repo root, e.g.
   *   `corpora/offline-eval/golden-queries-gate.jsonl`
   * @returns parsed lines as unknown[] (callers validate with Zod or type guards)
   * @throws if the file is missing or cannot be parsed as NDJSON
   */
  async loadCorpusNdjson(corpusRelPath: string): Promise<readonly unknown[]> {
    const path = join(this.repoRoot, corpusRelPath);
    this.assertSafePath(path);
    const content = await readFile(path, 'utf8');
    // Guard: reject corpus files larger than 20 MB to prevent heap exhaustion.
    // Larger corpora must be streamed via corpusPath() + a readline reader.
    if (Buffer.byteLength(content, 'utf8') > MAX_CORPUS_LOAD_BYTES) {
      throw new Error(
        `loadCorpusNdjson: corpus file exceeds 20 MB limit — use corpusPath() for streaming. Path: ${path}`,
      );
    }
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const results: unknown[] = [];
    let malformedLines = 0;
    for (let i = 0; i < lines.length; i++) {
      try {
        results.push(JSON.parse(lines[i]!) as unknown);
      } catch {
        malformedLines++;
        // Skip malformed lines and continue — a single bad line should not
        // corrupt the entire corpus. Callers can detect truncation via length.
        // eslint-disable-next-line no-console
        console.warn(`loadCorpusNdjson: malformed JSON at line ${i + 1} in ${path} — line skipped`);
      }
    }
    if (malformedLines > 0) {
      throw new Error(
        `loadCorpusNdjson: ${malformedLines} malformed line(s) in ${path}. Corpus integrity compromised — fix the source file.`,
      );
    }
    return results;
  }

  /**
   * Returns the absolute path for a corpus file in the fixture repo.
   * Use when callers need to pass the path to a streaming reader.
   */
  corpusPath(corpusRelPath: string): string {
    const path = join(this.repoRoot, corpusRelPath);
    this.assertSafePath(path);
    return path;
  }

  // ---------------------------------------------------------------------------
  // Availability check
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the fixture repository appears complete and readable.
   *
   * Checks both README.md (marker of a valid checkout) AND the suites/
   * directory (marker that case data is present). A repository that has only
   * README.md but no suites/ would return true from a README-only check,
   * causing integration tests to run but load zero cases — silently passing.
   */
  isAvailable(): boolean {
    return existsSync(join(this.repoRoot, 'README.md'))
      && existsSync(join(this.repoRoot, 'suites'));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async readJsonFile(path: string): Promise<unknown> {
    this.assertSafePath(path);
    const raw = await readFile(path, 'utf8');
    // Rule 12: JSON.parse result is cast to unknown first, then validated by callers
    return JSON.parse(raw) as unknown;
  }

  private async loadCatalogEntries<T>(
    path: string,
    schema: z.ZodType<T>,
    arrayKey: string,
  ): Promise<readonly T[]> {
    if (!existsSync(path)) {
      return [];
    }
    try {
      const raw = await this.readJsonFile(path);
      if (typeof raw !== 'object' || raw === null) return [];
      const arr = (raw as Record<string, unknown>)[arrayKey];
      if (!Array.isArray(arr)) return [];
      const results: T[] = [];
      for (const item of (arr as unknown[]).slice(0, MAX_CATALOG_ENTRIES)) {
        const result = schema.safeParse(item);
        if (result.success) {
          results.push(result.data);
        } else {
          log.warn({ path, issues: result.error.issues }, 'Catalog entry failed validation — skipping');
        }
      }
      return results;
    } catch (err) {
      log.warn({ err, path }, 'Failed to load catalog file');
      return [];
    }
  }

  private inferSuiteFromCaseId(caseId: string): SuiteId | null {
    const prefix = caseId.split('-')[0];
    return prefix != null ? (CASE_PREFIX_TO_SUITE[prefix] ?? null) : null;
  }

  // ---------------------------------------------------------------------------
  // Filtering helpers (used by benchmark runners to select subsets)
  // ---------------------------------------------------------------------------

  /**
   * Returns all cases across all suites that match the given tag.
   * Empty or whitespace-only tag returns an empty array (prevents matching
   * everything via `includes('')` and avoids surprising whitespace matches).
   */
  async loadCasesByTag(tag: string): Promise<readonly BenchmarkCase[]> {
    if (tag.trim().length === 0) return [];
    const allCases = await this.loadAllCases();
    return allCases.filter((c) => c.tags != null && c.tags.includes(tag));
  }

  /**
   * Returns all cases across all suites with the given difficulty level.
   */
  async loadCasesByDifficulty(difficulty: 'easy' | 'medium' | 'hard'): Promise<readonly BenchmarkCase[]> {
    const allCases = await this.loadAllCases();
    return allCases.filter((c) => c.difficulty === difficulty);
  }

  /**
   * Returns all cases across all suites for the given language.
   */
  async loadCasesByLanguage(language: 'ko' | 'en' | 'mixed'): Promise<readonly BenchmarkCase[]> {
    const allCases = await this.loadAllCases();
    return allCases.filter((c) => c.language === language);
  }

  /**
   * Loads all cases from all suites in parallel.
   * Results are returned in ALL_SUITE_IDS order, then sorted by case ID within
   * each suite (the per-suite loadCases already sorts files alphabetically).
   */
  async loadAllCases(): Promise<readonly BenchmarkCase[]> {
    const perSuite = await Promise.all((ALL_SUITE_IDS as readonly SuiteId[]).map((id) => this.loadCases(id)));
    return perSuite.flat();
  }

  /**
   * Returns the count of cases per suite in parallel without loading case contents.
   * Useful for CI health checks.
   */
  async getCaseCounts(): Promise<Readonly<Record<SuiteId, number>>> {
    const results = await Promise.all(
      (ALL_SUITE_IDS as readonly SuiteId[]).map(async (suiteId) => {
        const cases = await this.loadCases(suiteId);
        return [suiteId, cases.length] as const;
      }),
    );
    return Object.fromEntries(results) as Record<SuiteId, number>;
  }
}
