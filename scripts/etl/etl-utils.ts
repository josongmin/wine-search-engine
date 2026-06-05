/**
 * ETL Infrastructure Utilities: atomic writes, file locking, checkpointing.
 *
 * These utilities harden the ETL pipeline against:
 * - File corruption from mid-write crashes (atomic writes via tmp+rename)
 * - Concurrent pipeline runs (advisory file locking)
 * - Lost progress on LLM-heavy steps (per-record checkpoint tracking)
 * - Unrecoverable data loss (backup-before-write)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Atomic file writes
// ---------------------------------------------------------------------------

/**
 * Writes content to `filePath` atomically: writes to a temp file in the same
 * directory, then renames. On crash, the original file remains intact.
 *
 * The rename is atomic on POSIX filesystems (same device guaranteed because
 * the temp file lives in the same directory).
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  await fsp.writeFile(tmp, content, 'utf8');
  try {
    await fsp.rename(tmp, filePath);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

/**
 * Synchronous variant of {@link atomicWriteFile} for scripts that use
 * `fs.writeFileSync`.
 */
export function atomicWriteFileSync(
  filePath: string,
  content: string,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Advisory file locking
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour — stale lock threshold

/**
 * Acquires an advisory lock for an ETL pipeline run.
 * The lock file stores PID + timestamp so stale locks can be detected.
 *
 * @returns An unlock function. Call it in a `finally` block.
 * @throws If the lock is held by another (alive) process.
 */
export async function acquireLock(
  lockPath: string,
): Promise<() => Promise<void>> {
  const dir = path.dirname(lockPath);
  await fsp.mkdir(dir, { recursive: true });

  // Check for existing lock
  try {
    const existing = await fsp.readFile(lockPath, 'utf8').catch(() => null);
    if (existing) {
      const rawParsed: unknown = JSON.parse(existing);
      const rec = (typeof rawParsed === 'object' && rawParsed !== null)
        ? rawParsed as Record<string, unknown>
        : null;
      const rawPid = rec?.['pid'];
      const rawTs = rec?.['ts'];
      // typeof NaN === 'number' is true — must use Number.isFinite() to reject NaN/Infinity.
      // A lock file with NaN pid would call isProcessAlive(NaN) → process.kill(NaN, 0),
      // which has undefined behaviour and could mask stale locks indefinitely.
      if (
        rec === null
        || !Number.isFinite(rawPid)
        || !Number.isFinite(rawTs)
      ) {
        throw new Error(`Invalid lock file format at ${lockPath}`);
      }
      const parsed = { pid: rawPid as number, ts: rawTs as number };
      // Negative age (clock skew / future timestamp) must be treated as stale —
      // a negative value satisfies `age < LOCK_STALE_MS` and would call
      // isProcessAlive() with potentially garbage pid from a corrupted lock.
      const age = Date.now() - parsed.ts;
      if (age >= 0 && age < LOCK_STALE_MS && isProcessAlive(parsed.pid)) {
        throw new Error(
          `ETL lock held by PID ${parsed.pid} (age ${Math.round(age / 1000)}s). ` +
          `If stale, delete ${lockPath}`,
        );
      }
      // Stale lock — clean up
      console.warn(`  Removing stale lock (PID ${parsed.pid}, age ${Math.round(age / 1000)}s)`);
      await fsp.unlink(lockPath).catch(() => {});
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('ETL lock held')) throw e;
    // File doesn't exist or parse error — proceed
  }

  // Attempt atomic lock creation using O_EXCL (fails if file already exists)
  const lockData = JSON.stringify({ pid: process.pid, ts: Date.now() });
  try {
    const handle = await fsp.open(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    await handle.writeFile(lockData, 'utf8');
    await handle.close();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(
        `ETL lock contention: another process acquired the lock while we were checking. ` +
        `If stale, delete ${lockPath}`,
      );
    }
    // Other filesystem errors (EACCES, EIO, etc.) — re-throw instead of silently overwriting
    throw new Error(
      `Failed to create lock file ${lockPath}: ${code ?? (e instanceof Error ? e.message : String(e))}`,
    );
  }

  return async () => {
    try {
      await fsp.unlink(lockPath);
    } catch {
      // Lock file already removed — fine
    }
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Checkpoint tracking for resumable ETL steps
// ---------------------------------------------------------------------------

/**
 * Tracks which records have been processed by a given step.
 * Stored as a JSON file mapping sourceId → step completion status.
 *
 * Usage:
 * ```ts
 * const ckpt = await Checkpoint.load('data/.checkpoint-step1.json');
 * for (const rec of records) {
 *   if (ckpt.isDone(rec.sourceId ?? rec.externalId)) continue;
 *   // ... process ...
 *   ckpt.markDone(rec.sourceId ?? rec.externalId);
 *   if (ckpt.dirtyCount() >= 100) await ckpt.flush();
 * }
 * await ckpt.flush();
 * ```
 */
export class Checkpoint {
  private done: Set<string>;
  private dirty = 0;
  private readonly filePath: string;

  private constructor(filePath: string, done: Set<string>) {
    this.filePath = filePath;
    this.done = done;
  }

  static async load(filePath: string): Promise<Checkpoint> {
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
      return new Checkpoint(filePath, new Set(ids));
    } catch {
      return new Checkpoint(filePath, new Set());
    }
  }

  isDone(id: string): boolean {
    return this.done.has(id);
  }

  markDone(id: string): void {
    this.done.add(id);
    this.dirty++;
  }

  dirtyCount(): number {
    return this.dirty;
  }

  completedCount(): number {
    return this.done.size;
  }

  async flush(): Promise<void> {
    if (this.dirty === 0) return;
    await atomicWriteFile(this.filePath, JSON.stringify([...this.done]));
    this.dirty = 0;
  }

  async clear(): Promise<void> {
    this.done.clear();
    this.dirty = 0;
    try {
      await fsp.unlink(this.filePath);
    } catch {
      // File doesn't exist — fine
    }
  }
}

// ---------------------------------------------------------------------------
// Backup before write
// ---------------------------------------------------------------------------

/**
 * Creates a timestamped backup of `filePath` before overwriting.
 * Backups are stored as `{basename}.bak.{timestamp}` in the same directory.
 * Only the most recent N backups are kept.
 */
export async function backupFile(
  filePath: string,
  maxBackups = 3,
): Promise<string | null> {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch {
    return null; // File doesn't exist, nothing to back up
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const backupPath = path.join(dir, `${base}.bak.${Date.now()}`);
  await fsp.copyFile(filePath, backupPath);

  // Prune old backups
  const entries = await fsp.readdir(dir);
  const backups = entries
    .filter((e) => e.startsWith(`${base}.bak.`))
    .sort()
    .reverse();

  for (const old of backups.slice(maxBackups)) {
    await fsp.unlink(path.join(dir, old)).catch(() => {});
  }

  return backupPath;
}

// ---------------------------------------------------------------------------
// NDJSON helpers for Track C step scripts
// ---------------------------------------------------------------------------

/**
 * Writes an array of records as NDJSON with atomic write + backup.
 * Standard pattern for all Track C step outputs.
 */
export async function writeNdjsonSafe(
  filePath: string,
  records: readonly Record<string, unknown>[],
): Promise<void> {
  await backupFile(filePath);
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await atomicWriteFile(filePath, content);
}

/**
 * Synchronous variant for scripts that use sync I/O.
 */
export function writeNdjsonSafeSync(
  filePath: string,
  records: readonly Record<string, unknown>[],
): void {
  // Backup synchronously
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  if (fs.existsSync(filePath)) {
    const backupPath = path.join(dir, `${base}.bak.${Date.now()}`);
    fs.copyFileSync(filePath, backupPath);
  }
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  atomicWriteFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// Dead-letter queue for failed records
// ---------------------------------------------------------------------------

/**
 * Appends a failed record to a dead-letter file for later investigation.
 * Each line is JSON: `{ sourceId, step, error, timestamp }`.
 */
export async function appendDeadLetter(
  deadLetterPath: string,
  entry: {
    readonly sourceId: string;
    readonly step: string;
    readonly error: string;
  },
): Promise<void> {
  const dir = path.dirname(deadLetterPath);
  await fsp.mkdir(dir, { recursive: true });
  const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
  await fsp.appendFile(deadLetterPath, line, 'utf8');
}

// ---------------------------------------------------------------------------
// Locale-safe numeric string parsing (SCAN4-14)
// ---------------------------------------------------------------------------

/**
 * Parses a numeric string that may use European decimal notation ("87,5") or
 * standard notation ("87.5").
 *
 * SCAN4-14: Vivino and some wine databases use comma as the decimal separator
 * (common in France, Germany, Italy, Spain). Passing such strings directly to
 * `parseFloat()` produces a truncated integer (e.g. parseFloat("87,5") → 87).
 *
 * Algorithm:
 *   1. If the string contains a comma AND no period → treat comma as decimal separator.
 *      e.g. "87,5" → 87.5, "14,4" → 14.4
 *   2. If the string contains both comma and period → comma is a thousands separator.
 *      e.g. "1,234.56" → 1234.56
 *   3. Otherwise → pass through to parseFloat as-is.
 *
 * Always returns NaN for unparseable input. Callers MUST check Number.isFinite()
 * before use (CLAUDE.md schema quality bar).
 *
 * @example
 *   parseLocaleFloat("87,5")    → 87.5
 *   parseLocaleFloat("87.5")    → 87.5
 *   parseLocaleFloat("1,234.5") → 1234.5
 *   parseLocaleFloat("abc")     → NaN
 *   parseLocaleFloat(87)        → 87
 */
export function parseLocaleFloat(value: string | number | null | undefined): number {
  if (value == null) return NaN;
  if (typeof value === 'number') return value;
  const s = value.trim();
  if (s.length === 0) return NaN;

  // European decimal: comma present, no period → replace comma with period
  if (s.includes(',') && !s.includes('.')) {
    return parseFloat(s.replace(',', '.'));
  }
  // Mixed: comma as thousands separator (e.g. "1,234.56") → strip commas
  if (s.includes(',') && s.includes('.')) {
    return parseFloat(s.replace(/,/g, ''));
  }
  return parseFloat(s);
}

// ---------------------------------------------------------------------------
// Content hash for change detection
// ---------------------------------------------------------------------------

/**
 * Returns a SHA-256 hex digest of the given content.
 * Useful for detecting whether a file has changed between steps.
 */
export function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function chunkArray<T>(items: readonly T[], size: number): readonly T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunkArray size must be a positive integer, got ${size}`);
  }
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size) as T[]);
  }
  return chunks;
}
