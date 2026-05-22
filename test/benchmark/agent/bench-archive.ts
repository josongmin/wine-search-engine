/**
 * Archive a finished bench report to `data/bench-archive/<gitsha>-<utc>.json`.
 *
 * Why archive at all:
 *   - /tmp gets nuked between sessions; we have lost full bench runs multiple
 *     times. Archives sit under data/bench-archive/ which IS visible in the
 *     workspace but is .gitignored so the diff stays clean.
 *   - bench-compare CLI (C2) loads two archive JSONs and runs the paired
 *     bootstrap against them.
 *
 * File-name format:
 *   `<sha>-<utc>.json`
 *   sha = first 8 chars of `git rev-parse HEAD` (or 'nogit' if unavailable)
 *   utc = ISO 8601 with `:` → `-` so the file name is filesystem-safe.
 *
 * Manifest:
 *   Alongside the report, write a `<sha>-<utc>.manifest.json` that contains
 *   ONLY `summary.environment` + `summary.environmentHash` + minimal index
 *   fields. This is what `list` or `latest-by-hash` queries read; the full
 *   report is only loaded when bench-compare needs the per-scenario detail.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EnvManifest } from './env-manifest.js';

/** Default archive directory, resolved relative to repo root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_ARCHIVE_DIR = join(REPO_ROOT, 'data', 'bench-archive');

/** Slice length applied to git sha when used in file names (matches manifestHash). */
const FILE_SHA_LENGTH = 8;

/**
 * Manifest fields kept in `<sha>-<utc>.manifest.json` for cheap index loads.
 */
export interface BenchArchiveManifest {
  readonly capturedAt: string;
  readonly gitSha: string;
  readonly profile: string;
  readonly model: string;
  readonly judgeModel: string;
  readonly scenarioCount: number;
  readonly overallScore: number;
  readonly criticalFailureCount: number;
  readonly environmentHash: string;
  readonly environment: EnvManifest;
  /** Relative path (under archive dir) to the corresponding full report JSON. */
  readonly reportFile: string;
}

/** Subset of the bench report this module actually consumes. */
interface ArchivableReport {
  readonly timestamp: string;
  readonly model: string;
  readonly judgeModel: string | null;
  readonly scenarioCount: number;
  readonly criticalFailureCount: number;
  readonly summary: {
    readonly overallScore: number;
    readonly environment: EnvManifest;
    readonly environmentHash: string;
  };
}

/**
 * Write the report JSON and a sibling manifest into the archive directory.
 * Idempotent on collision — if the target file exists it is overwritten.
 *
 * Returns the absolute path of the archived report so callers can log it.
 */
async function archiveBenchReport(
  report: ArchivableReport,
  reportJson: string,
  options?: {
    /** Override the archive dir (used by unit tests; otherwise default = data/bench-archive). */
    readonly archiveDir?: string;
    /** Override profile name (passes through env manifest by default). */
    readonly profile?: string;
  },
): Promise<{ reportPath: string; manifestPath: string }> {
  const archiveDir = options?.archiveDir ?? DEFAULT_ARCHIVE_DIR;
  await fs.mkdir(archiveDir, { recursive: true });

  const env = report.summary.environment;
  const sha = (env.gitSha === '<unknown>' ? 'nogit' : env.gitSha.slice(0, FILE_SHA_LENGTH));
  const utcSafe = sanitizeUtc(report.timestamp);
  const baseName = `${sha}-${utcSafe}`;

  const reportPath = join(archiveDir, `${baseName}.json`);
  const manifestPath = join(archiveDir, `${baseName}.manifest.json`);

  await fs.writeFile(reportPath, reportJson, 'utf8');

  const manifest: BenchArchiveManifest = {
    capturedAt: report.timestamp,
    gitSha: env.gitSha,
    profile: options?.profile ?? env.profile,
    model: report.model,
    judgeModel: report.judgeModel === null ? 'disabled' : report.judgeModel,
    scenarioCount: report.scenarioCount,
    overallScore: report.summary.overallScore,
    criticalFailureCount: report.criticalFailureCount,
    environmentHash: report.summary.environmentHash,
    environment: env,
    reportFile: `${baseName}.json`,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.error(`  [BENCH-ARCHIVE] wrote ${reportPath}`);
  return { reportPath, manifestPath };
}

/**
 * List archive manifests sorted descending by `capturedAt` (newest first).
 * Returns an empty array when the archive dir doesn't exist or contains
 * nothing — never throws on a missing dir.
 */
export async function listArchiveManifests(
  archiveDir: string = DEFAULT_ARCHIVE_DIR,
): Promise<readonly BenchArchiveManifest[]> {
  let entries: readonly string[];
  try {
    entries = await fs.readdir(archiveDir);
  } catch {
    return [];
  }
  const out: BenchArchiveManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.manifest.json')) continue;
    try {
      const raw = await fs.readFile(join(archiveDir, entry), 'utf8');
      // CLAUDE.md rule 12: never JSON.parse(...) as T — narrow first.
      const json = JSON.parse(raw) as unknown;
      if (!isBenchArchiveManifest(json)) continue;
      out.push(json);
    } catch {
      // Skip unreadable / corrupted manifests; never crash the lister.
    }
  }
  out.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return out;
}

/** Reader for a full archived report. Returns null when the path is absent or malformed. */
async function loadArchivedReport(reportPath: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(reportPath, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Test-only export — surfaces the default archive dir for assertions. */
export function defaultArchiveDir(): string {
  return DEFAULT_ARCHIVE_DIR;
}

// ─── helpers ──────────────────────────────────────────────────────────────

function sanitizeUtc(utc: string): string {
  // Replace ':' with '-' and drop fractional seconds + trailing 'Z' to keep
  // the file name short and POSIX-safe across filesystems.
  // 2026-05-22T13:45:00.000Z  →  2026-05-22T13-45-00
  return utc.replace(/:/gu, '-').replace(/\.\d+Z$/u, '').replace(/Z$/u, '');
}

function isBenchArchiveManifest(value: unknown): value is BenchArchiveManifest {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['capturedAt'] === 'string'
    && typeof v['gitSha'] === 'string'
    && typeof v['profile'] === 'string'
    && typeof v['model'] === 'string'
    && typeof v['scenarioCount'] === 'number'
    && typeof v['overallScore'] === 'number'
    && typeof v['environmentHash'] === 'string'
    && typeof v['reportFile'] === 'string';
}
