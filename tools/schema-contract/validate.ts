#!/usr/bin/env tsx
/**
 * Schema Contract Validator — RFC-018 Wave 1.
 *
 * Enforces the {@link
 * https://github.com/.../docs/RFC-018-scope-and-field-ownership.md
 * Field Ownership Matrix} against either:
 *   (a) a prepared Vespa feed NDJSON artifact (offline / CI),
 *   (b) a live Vespa endpoint reached via mTLS.
 *
 * Three classes of finding:
 *   - DRIFT  — a field is declared in wine_entity.sd but missing from the
 *              matrix, or vice versa. Always an ERROR.
 *   - COVERAGE_FAIL — measured non-null ratio < coverage_required, and the
 *                     row's fail_action is `must` (ERROR) or `warn` (WARN).
 *   - SCOPE_FAIL — a wine listed in the scope-contract seed JSONL is missing
 *                  from the inspected corpus. ERROR.
 *
 * Exit code 1 on any ERROR (or any WARN when `--warn-as-error` is passed).
 *
 * Pure helpers (parseSchemaFieldNames, loadFieldOwnershipMatrix,
 * classifyFindings, …) are exported so the regression test in
 * test/regression/schema-contract-validator.regression.test.ts can drive them
 * with synthetic fixtures.
 */

import { readFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, fetch as undiciFetch } from 'undici';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Default paths (resolved relative to this file so the tool runs the same
// from any CWD).
// ---------------------------------------------------------------------------

const THIS_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '..', '..');
const DEFAULT_SCHEMA_PATH = resolve(REPO_ROOT, 'vespa', 'app', 'schemas', 'wine_entity.sd');
const DEFAULT_MATRIX_PATH = resolve(THIS_DIR, 'field-ownership-matrix.yaml');

// Live-mode default probe size. 200 hits is large enough to give >5% precision
// on a 50%-coverage field via Wilson 95% CI, small enough to stay within
// Vespa's default `select * limit N` cap. Operators can override with
// --probe-limit when measuring rare fields.
const DEFAULT_PROBE_LIMIT = 200;

// ---------------------------------------------------------------------------
// fail_action enum and Zod schema (RFC-018 §5)
// ---------------------------------------------------------------------------

export const FAIL_ACTIONS = ['must', 'warn', 'optional'] as const;
export type FailAction = (typeof FAIL_ACTIONS)[number];

const MatrixRowSchema = z.object({
  field: z.string().min(1),
  source: z.string().min(1),
  coverage_required: z.number().finite().min(0).max(1),
  fail_action: z.enum(FAIL_ACTIONS),
  rationale: z.string().min(1),
  ticket: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
  // Some indexed fields are intentionally omitted from
  // `document-summary full` (e.g. large tensors like `embedding`). The live
  // Vespa probe fetches via summary=full, so those fields always read 0% on
  // live mode even when ingest succeeded. Set this flag (with a reason) to
  // skip coverage enforcement on live-probe mode ONLY — prepared-feed mode
  // still enforces coverage since feeds carry every field.
  excluded_from_live_probe: z.boolean().optional(),
  excluded_from_live_probe_reason: z.string().min(1).optional(),
}).strict().refine(
  (row) => row.excluded_from_live_probe !== true || (row.excluded_from_live_probe_reason !== undefined && row.excluded_from_live_probe_reason.length > 0),
  { message: 'excluded_from_live_probe=true requires excluded_from_live_probe_reason' },
);

const MatrixFileSchema = z.object({
  fields: z.array(MatrixRowSchema).min(1).max(500),
}).strict();

export type FieldOwnershipRow = z.infer<typeof MatrixRowSchema>;

// ---------------------------------------------------------------------------
// Live Vespa response (only what we need — non-strict on purpose)
// ---------------------------------------------------------------------------

const VespaHitSchema = z.object({
  fields: z.record(z.unknown()).optional(),
}).passthrough();

const VespaResponseSchema = z.object({
  root: z.object({
    children: z.array(VespaHitSchema).optional(),
  }).passthrough(),
}).passthrough();

// ---------------------------------------------------------------------------
// Prepared feed parsing
// ---------------------------------------------------------------------------

const PreparedDocSchema = z.object({
  id: z.string().min(1),
  fields: z.record(z.unknown()),
}).strict();

// ---------------------------------------------------------------------------
// Schema file (wine_entity.sd) field-name extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the set of `field <name> type ...` declarations from a Vespa
 * schema file body. Only top-level field declarations are returned — entries
 * inside `document-summary { summary <name> {} }` blocks and `fieldset` lists
 * are ignored.
 *
 * The matcher walks line-by-line so that comments (`#…`) and string literals
 * containing the word "field" cannot generate false positives.
 */
export function parseSchemaFieldNames(schemaSource: string): readonly string[] {
  const fieldDeclRe = /^\s*field\s+([A-Za-z_][A-Za-z0-9_]*)\s+type\s+/u;
  const names = new Set<string>();
  for (const rawLine of schemaSource.split('\n')) {
    const line = rawLine.replace(/#.*$/u, '');
    const match = fieldDeclRe.exec(line);
    if (match && match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// YAML matrix loading
// ---------------------------------------------------------------------------

/**
 * YAML parses missing values as `null`. Strip them recursively so that Zod
 * `.optional()` fires correctly (same trick as the feature-catalog loader).
 */
function stripNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripNulls(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/**
 * Reads + parses the matrix YAML and validates it with Zod. Throws on any
 * structural error so the caller sees the diagnostic directly.
 */
export function loadFieldOwnershipMatrix(
  yamlSource: string,
  sourcePath: string,
): readonly FieldOwnershipRow[] {
  const parsed: unknown = stripNulls(parseYaml(yamlSource));
  const result = MatrixFileSchema.safeParse(parsed);
  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `    - ${e.path.join('.') || '<root>'}: ${e.message}`)
      .join('\n');
    throw new Error(
      `[schema-contract] matrix validation failed in ${sourcePath}:\n${formatted}`,
    );
  }
  // Duplicate-field check — Zod cannot express this on an array directly.
  const seen = new Set<string>();
  for (const row of result.data.fields) {
    if (seen.has(row.field)) {
      throw new Error(
        `[schema-contract] duplicate matrix entry for field "${row.field}" in ${sourcePath}`,
      );
    }
    seen.add(row.field);
  }
  return result.data.fields;
}

// ---------------------------------------------------------------------------
// Prepared feed loading
// ---------------------------------------------------------------------------

interface PreparedDoc {
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

/**
 * Parses a Vespa prepared-feed NDJSON file (one {id, fields} JSON object per
 * non-blank line). Throws on malformed input — silent skip would hide
 * corruption.
 */
export function parsePreparedFeedNdjson(source: string, sourcePath: string): readonly PreparedDoc[] {
  const docs: PreparedDoc[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (line.length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(
        `[schema-contract] invalid JSON at ${sourcePath}:${i + 1}`,
      );
    }
    const parsed = PreparedDocSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `[schema-contract] malformed prepared-feed doc at ${sourcePath}:${i + 1}: ${parsed.error.message}`,
      );
    }
    docs.push(parsed.data);
  }
  return docs;
}

/**
 * If the prepared-feed path points at a directory, concatenate every
 * `.jsonl`/`.json` file under it (sorted) into a single document list. Allows
 * `--from-prepared-feed dist/prepared-feed/` style invocation in CI.
 */
async function loadPreparedFeedDocs(path: string): Promise<readonly PreparedDoc[]> {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const entries = readdirSync(path).sort();
    const all: PreparedDoc[] = [];
    for (const entry of entries) {
      if (!(entry.endsWith('.jsonl') || entry.endsWith('.json'))) continue;
      const child = join(path, entry);
      const raw = readFileSync(child, 'utf-8');
      all.push(...parsePreparedFeedNdjson(raw, child));
    }
    return all;
  }
  const raw = await readFile(path, 'utf-8');
  return parsePreparedFeedNdjson(raw, path);
}

// ---------------------------------------------------------------------------
// Live Vespa fetch
// ---------------------------------------------------------------------------

interface LiveVespaOptions {
  readonly vespaUrl: string;
  readonly certPath?: string;
  readonly keyPath?: string;
  readonly probeLimit: number;
}

async function fetchLiveVespaDocs(opts: LiveVespaOptions): Promise<readonly PreparedDoc[]> {
  // mTLS dispatcher (Vespa Cloud requires it; self-hosted local does not).
  let dispatcher: Agent | undefined;
  if (opts.certPath !== undefined && opts.keyPath !== undefined) {
    const cert = readFileSync(opts.certPath, 'utf-8');
    const key = readFileSync(opts.keyPath, 'utf-8');
    dispatcher = new Agent({ connect: { cert, key } });
  }

  const body = JSON.stringify({
    yql: `select * from sources wine_entity where true limit ${opts.probeLimit}`,
    hits: opts.probeLimit,
    // Force the full document so coverage is measured against actual fields,
    // not just the default summary class.
    presentation: { summary: 'full' },
  });

  const response = await undiciFetch(`${opts.vespaUrl.replace(/\/$/u, '')}/search/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    ...(dispatcher !== undefined ? { dispatcher } : {}),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `[schema-contract] live Vespa probe HTTP ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  const json: unknown = await response.json();
  const parsed = VespaResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `[schema-contract] unexpected Vespa response shape: ${parsed.error.message}`,
    );
  }
  const hits = parsed.data.root.children ?? [];
  return hits.map((hit, idx): PreparedDoc => ({
    id: `live-probe:${idx}`,
    fields: hit.fields ?? {},
  }));
}

// ---------------------------------------------------------------------------
// Coverage classification
// ---------------------------------------------------------------------------

export type FindingKind =
  | 'DRIFT_MISSING_MATRIX_ENTRY'
  | 'DRIFT_STALE_MATRIX_ENTRY'
  | 'COVERAGE_FAIL'
  | 'COVERAGE_OK'
  | 'COVERAGE_SKIPPED'
  | 'SCOPE_FAIL';

export interface Finding {
  readonly kind: FindingKind;
  readonly field: string;
  readonly severity: 'ERROR' | 'WARN' | 'INFO';
  readonly observed?: number | undefined;
  readonly required?: number | undefined;
  readonly message: string;
}

/**
 * "Has a value" for coverage purposes — a field counts as populated when
 * the prepared-feed doc carries the key with anything other than `undefined`,
 * `null`, an empty string, or an empty array. Numeric `0`, boolean `false`,
 * empty *object* (e.g. embedding `{values: [...]}` placeholder during
 * roundtrip) all count as populated — the latter is rare in practice and
 * checked at the writer layer.
 */
function isFieldPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Counts non-null values per field across all docs.
 */
export function measureFieldCoverage(
  docs: readonly PreparedDoc[],
  knownFields: readonly string[],
): ReadonlyMap<string, number> {
  const populated = new Map<string, number>();
  for (const field of knownFields) populated.set(field, 0);
  for (const doc of docs) {
    for (const field of knownFields) {
      if (isFieldPopulated(doc.fields[field])) {
        const next = (populated.get(field) ?? 0) + 1;
        populated.set(field, next);
      }
    }
  }
  const ratios = new Map<string, number>();
  const total = docs.length;
  for (const [field, count] of populated.entries()) {
    ratios.set(field, total === 0 ? 0 : count / total);
  }
  return ratios;
}

interface ClassifyArgs {
  readonly schemaFields: readonly string[];
  readonly matrix: readonly FieldOwnershipRow[];
  readonly coverage: ReadonlyMap<string, number> | undefined;
  readonly scopeMisses?: readonly string[];
  // 'live' = field excluded_from_live_probe rows are skipped with
  // COVERAGE_SKIPPED. 'prepared-feed' / undefined = full enforcement.
  readonly coverageSource?: 'live' | 'prepared-feed';
}

/**
 * Produces the deterministic ordered list of findings: drift first
 * (DRIFT_* before any coverage check), then coverage per matrix row in
 * matrix order, then scope-contract misses (if any).
 */
export function classifyFindings(args: ClassifyArgs): readonly Finding[] {
  const out: Finding[] = [];

  // Drift: bidirectional set difference.
  const schemaSet = new Set(args.schemaFields);
  const matrixSet = new Set(args.matrix.map((r) => r.field));

  for (const f of [...schemaSet].sort()) {
    if (!matrixSet.has(f)) {
      out.push({
        kind: 'DRIFT_MISSING_MATRIX_ENTRY',
        field: f,
        severity: 'ERROR',
        message: `Schema declares "${f}" but the matrix has no row for it. Add a row to field-ownership-matrix.yaml.`,
      });
    }
  }
  for (const f of [...matrixSet].sort()) {
    if (!schemaSet.has(f)) {
      out.push({
        kind: 'DRIFT_STALE_MATRIX_ENTRY',
        field: f,
        severity: 'ERROR',
        message: `Matrix declares "${f}" but the schema has no such field. Remove the row or restore the field in wine_entity.sd.`,
      });
    }
  }

  // Coverage: walk matrix rows in order so the report is deterministic.
  if (args.coverage !== undefined) {
    for (const row of args.matrix) {
      if (!schemaSet.has(row.field)) continue; // drift already reported
      const observed = args.coverage.get(row.field) ?? 0;
      if (args.coverageSource === 'live' && row.excluded_from_live_probe === true) {
        out.push({
          kind: 'COVERAGE_SKIPPED',
          field: row.field,
          severity: 'INFO',
          observed,
          required: row.coverage_required,
          message: `live-probe excluded — ${row.excluded_from_live_probe_reason ?? 'no reason given'}`,
        });
        continue;
      }
      if (row.fail_action === 'optional') {
        out.push({
          kind: 'COVERAGE_SKIPPED',
          field: row.field,
          severity: 'INFO',
          observed,
          required: row.coverage_required,
          message: `optional — observed ${(observed * 100).toFixed(1)}% (no enforcement)`,
        });
        continue;
      }
      if (observed >= row.coverage_required) {
        out.push({
          kind: 'COVERAGE_OK',
          field: row.field,
          severity: 'INFO',
          observed,
          required: row.coverage_required,
          message: `ok — observed ${(observed * 100).toFixed(1)}% ≥ required ${(row.coverage_required * 100).toFixed(1)}%`,
        });
        continue;
      }
      out.push({
        kind: 'COVERAGE_FAIL',
        field: row.field,
        severity: row.fail_action === 'must' ? 'ERROR' : 'WARN',
        observed,
        required: row.coverage_required,
        message: `${row.fail_action} — observed ${(observed * 100).toFixed(1)}% < required ${(row.coverage_required * 100).toFixed(1)}%`,
      });
    }
  }

  if (args.scopeMisses !== undefined) {
    for (const entityId of [...args.scopeMisses].sort()) {
      out.push({
        kind: 'SCOPE_FAIL',
        field: entityId,
        severity: 'ERROR',
        message: `scope-contract: required entity_id "${entityId}" not present in inspected corpus`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function renderFindingsAsTsv(findings: readonly Finding[]): string {
  // status\tkind\tfield\tobserved\trequired\tmessage
  const lines: string[] = ['status\tkind\tfield\tobserved\trequired\tmessage'];
  for (const f of findings) {
    const observed = f.observed !== undefined ? f.observed.toFixed(4) : '';
    const required = f.required !== undefined ? f.required.toFixed(4) : '';
    lines.push(`${f.severity}\t${f.kind}\t${f.field}\t${observed}\t${required}\t${f.message}`);
  }
  return lines.join('\n');
}

interface SummaryCounts {
  readonly error: number;
  readonly warn: number;
  readonly info: number;
}

function summarize(findings: readonly Finding[]): SummaryCounts {
  let error = 0;
  let warn = 0;
  let info = 0;
  for (const f of findings) {
    if (f.severity === 'ERROR') error += 1;
    else if (f.severity === 'WARN') warn += 1;
    else info += 1;
  }
  return { error, warn, info };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly schemaPath: string;
  readonly matrixPath: string;
  readonly mode: 'drift-only' | 'prepared-feed' | 'live';
  readonly preparedFeedPath?: string;
  readonly probeLimit: number;
  readonly warnAsError: boolean;
  readonly scopeContractPath?: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let schemaPath = DEFAULT_SCHEMA_PATH;
  let matrixPath = DEFAULT_MATRIX_PATH;
  let mode: CliArgs['mode'] = 'drift-only';
  let preparedFeedPath: string | undefined;
  let probeLimit = DEFAULT_PROBE_LIMIT;
  let warnAsError = false;
  let scopeContractPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--schema') {
      schemaPath = argv[++i] ?? schemaPath;
    } else if (arg === '--matrix') {
      matrixPath = argv[++i] ?? matrixPath;
    } else if (arg === '--from-prepared-feed') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--from-prepared-feed requires a path argument');
      preparedFeedPath = v;
      mode = 'prepared-feed';
    } else if (arg === '--from-vespa-live') {
      mode = 'live';
    } else if (arg === '--probe-limit') {
      probeLimit = parsePositiveInt(argv[++i], DEFAULT_PROBE_LIMIT);
    } else if (arg === '--warn-as-error') {
      warnAsError = true;
    } else if (arg === '--check-scope-contract') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--check-scope-contract requires a path argument');
      scopeContractPath = v;
    } else if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown CLI flag: ${String(arg)}`);
    }
  }

  return {
    schemaPath,
    matrixPath,
    mode,
    ...(preparedFeedPath !== undefined ? { preparedFeedPath } : {}),
    probeLimit,
    warnAsError,
    ...(scopeContractPath !== undefined ? { scopeContractPath } : {}),
  };
}

function printUsageAndExit(code: number): never {
  const usage =
    'Usage:\n'
    + '  validate.ts [--schema <path>] [--matrix <path>]\n'
    + '              [--from-prepared-feed <path>] [--from-vespa-live]\n'
    + '              [--probe-limit <n>] [--warn-as-error]\n'
    + '              [--check-scope-contract <seed.jsonl>]\n';
  process.stdout.write(usage);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Scope-contract seed loader (Wave 2 — JSONL of {entity_id, label})
// ---------------------------------------------------------------------------

const ScopeSeedSchema = z.object({ entity_id: z.string().min(1) }).passthrough();

async function loadScopeContract(path: string): Promise<readonly string[]> {
  const raw = await readFile(path, 'utf-8');
  const ids: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parsed = ScopeSeedSchema.parse(JSON.parse(trimmed));
    ids.push(parsed.entity_id);
  }
  return ids;
}

function diffScope(seed: readonly string[], docs: readonly PreparedDoc[]): readonly string[] {
  const present = new Set<string>();
  for (const doc of docs) {
    const id = doc.fields['entity_id'];
    if (typeof id === 'string' && id.length > 0) present.add(id);
  }
  return seed.filter((id) => !present.has(id));
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

interface RunResult {
  readonly findings: readonly Finding[];
  readonly summary: SummaryCounts;
  readonly exitCode: 0 | 1;
}

export async function runValidator(args: CliArgs): Promise<RunResult> {
  const schemaSource = await readFile(args.schemaPath, 'utf-8');
  const matrixSource = await readFile(args.matrixPath, 'utf-8');
  const schemaFields = parseSchemaFieldNames(schemaSource);
  const matrix = loadFieldOwnershipMatrix(matrixSource, args.matrixPath);

  let docs: readonly PreparedDoc[] | undefined;
  if (args.mode === 'prepared-feed') {
    if (args.preparedFeedPath === undefined) {
      throw new Error('prepared-feed mode requires --from-prepared-feed <path>');
    }
    docs = await loadPreparedFeedDocs(args.preparedFeedPath);
  } else if (args.mode === 'live') {
    const vespaUrl = process.env['VESPA_URL'];
    if (vespaUrl === undefined || vespaUrl.length === 0) {
      throw new Error('--from-vespa-live requires VESPA_URL env var');
    }
    docs = await fetchLiveVespaDocs({
      vespaUrl,
      ...(process.env['VESPA_CERT_PATH'] !== undefined ? { certPath: process.env['VESPA_CERT_PATH'] } : {}),
      ...(process.env['VESPA_KEY_PATH'] !== undefined ? { keyPath: process.env['VESPA_KEY_PATH'] } : {}),
      probeLimit: args.probeLimit,
    });
  }

  const coverage = docs !== undefined
    ? measureFieldCoverage(docs, schemaFields)
    : undefined;

  let scopeMisses: readonly string[] | undefined;
  if (args.scopeContractPath !== undefined) {
    if (docs === undefined) {
      throw new Error('--check-scope-contract requires a corpus mode (--from-prepared-feed or --from-vespa-live)');
    }
    const seed = await loadScopeContract(args.scopeContractPath);
    scopeMisses = diffScope(seed, docs);
  }

  const coverageSource: 'live' | 'prepared-feed' | undefined =
    args.mode === 'live' ? 'live' : args.mode === 'prepared-feed' ? 'prepared-feed' : undefined;
  const classifyArgs: ClassifyArgs = {
    schemaFields,
    matrix,
    coverage,
    ...(scopeMisses !== undefined ? { scopeMisses } : {}),
    ...(coverageSource !== undefined ? { coverageSource } : {}),
  };
  const findings = classifyFindings(classifyArgs);
  const summary = summarize(findings);
  const exitCode: 0 | 1 = (summary.error > 0 || (args.warnAsError && summary.warn > 0))
    ? 1
    : 0;

  return { findings, summary, exitCode };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    printUsageAndExit(2);
  }
  const result = await runValidator(args);
  process.stdout.write(renderFindingsAsTsv(result.findings));
  process.stdout.write('\n');
  process.stdout.write(
    `\nsummary: ${result.summary.error} error, ${result.summary.warn} warn, ${result.summary.info} info\n`,
  );
  process.exit(result.exitCode);
}

const invokedFromCli = process.argv[1] !== undefined
  && import.meta.url === `file://${process.argv[1]}`;
if (invokedFromCli) {
  void main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`FATAL: ${msg}\n`);
    process.exit(1);
  });
}
