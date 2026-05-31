/**
 * parseFloat / Number() safety audit.
 *
 * Scans all .ts source files for `parseFloat(` and `Number(` calls that
 * are not followed by a `Number.isFinite()` or `Number.isNaN()` guard
 * within the same statement or the immediately following line.
 *
 * This is a coarse textual check (not AST-based) but catches the most
 * common bug pattern: `parseFloat(x)` flowing into arithmetic or
 * `.toFixed()` without a NaN guard.
 *
 * False positives are expected for:
 *  - parseFloat inside a Zod .refine() (Zod handles NaN via .finite())
 *  - Number() on known-safe values (e.g., literal strings)
 *  - Guarded by a surrounding `if (!Number.isFinite(...))` on a prior line
 *
 * When this test fires, either add a `Number.isFinite()` guard or add
 * the file:line to the allowlist with a justifying comment.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';

const SRC_ROOT = resolve(import.meta.dirname, '../../../src');

// Files/patterns that are known-safe and don't need guards.
const ALLOWLIST: readonly string[] = [
  // Zod schema checks already reject NaN via .finite()/.min()/.max()
  'schemas/search-response.schema.ts',
  'schemas/search-response-v2.schema.ts',
  'schemas/search-request.schema.ts',
  'schemas/batch-search.schema.ts',
  'schemas/search-shared.schema.ts',
  // Test helpers
  '__tests__',
  // Mapping layer already has isNumber/isFinite guards at function level
  'infrastructure/vespa/mapping.ts',
  // Audit round baseline — these 21 existing uses are either:
  // (a) converting status codes (guaranteed small integers)
  // (b) guarded by typeof/truthiness checks upstream
  // (c) using Number() on known-numeric DB fields
  // New parseFloat/Number() calls outside these files WILL hard-fail.
  'domain/ingestion/service/field-normalizer.ts',
  'domain/mixed/service/constraint-overlay.ts',
  'domain/resolver/service/resolver.ts',
  'interface/http/response-builders/machine-response-builder-v2.ts',
  'infrastructure/adapter/pg-gold-set-store.ts',
  'interface/http/routes/http-route-contract-catalog.ts',
  'interface/http/routes/register-contract-route.ts',
  // Guards present but more than 2 lines away from the call (scanner false positives):
  // evidence-auditor.ts: parseFloat() is followed by Number.isFinite() inside the reduce callback
  'domain/evaluation/service/evidence-auditor.ts',
  // slice-evaluator.ts: parseFloat() is guarded by Number.isFinite() on the next line
  'domain/evaluation/service/slice-evaluator.ts',
];

async function findTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__tests__') {
      files.push(...(await findTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function isAllowlisted(filePath: string): boolean {
  return ALLOWLIST.some((pattern) => filePath.includes(pattern));
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

async function scanFile(filePath: string): Promise<Violation[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Match parseFloat( or Number( that aren't inside a comment
    if (
      (line.includes('parseFloat(') || /\bNumber\(/.test(line)) &&
      !line.trimStart().startsWith('//') &&
      !line.trimStart().startsWith('*')
    ) {
      // Check this line and the next 2 lines for a finite/NaN guard
      const context = lines.slice(i, Math.min(i + 3, lines.length)).join(' ');
      if (
        !context.includes('Number.isFinite') &&
        !context.includes('Number.isNaN') &&
        !context.includes('isNaN') &&
        !context.includes('.finite()') && // Zod chain
        !context.includes('isFinite(') &&
        !context.includes('isNumber(') // custom guard
      ) {
        const rel = filePath.replace(SRC_ROOT + '/', '');
        violations.push({ file: rel, line: i + 1, text: line.trim() });
      }
    }
  }

  return violations;
}

describe('parseFloat/Number() safety audit', () => {
  it('every parseFloat/Number() on external input has a finite guard within 2 lines', async () => {
    const files = await findTsFiles(SRC_ROOT);
    const nonAllowlisted = files.filter((f) => !isAllowlisted(f));

    const allViolations: Violation[] = [];
    for (const file of nonAllowlisted) {
      const violations = await scanFile(file);
      allViolations.push(...violations);
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${v.file}:${v.line} — ${v.text}`)
        .join('\n');
      // This is a warning-level check, not a hard fail. Log but don't block CI.
      // Promote to expect.fail() once all existing violations are cleaned up.
      console.warn(
        `[parseFloat safety audit] ${allViolations.length} unguarded parseFloat/Number() calls:\n${report}`,
      );
    }
    // Hard fail: any new unguarded parseFloat/Number() on external input
    // in non-allowlisted files must be caught before merge. Add a
    // Number.isFinite() guard or add the file to ALLOWLIST with a comment.
    if (allViolations.length > 0) {
      const report = allViolations.map((v) => `  ${v.file}:${v.line}`).join('\n');
      expect.fail(
        `Found ${allViolations.length} unguarded parseFloat/Number() calls:\n${report}`,
      );
    }
  });
});
