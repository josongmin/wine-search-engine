#!/usr/bin/env node
/**
 * Static pattern scanner for known-bad code patterns.
 *
 * Runs as part of the pre-push hook and CI pipeline. Exits 1 if any
 * ERROR-severity pattern is detected; WARNs are logged but don't fail.
 *
 * Patterns are derived from the 32 audit rounds (262 findings):
 * - \b with Korean/accented chars (50+ bugs)
 * - Math.max/min(...spread) (5+ stack-overflow bugs)
 * - JSON.parse(...) as T (7+ type-safety bugs)
 * - z.object() without .strict() (2+ schema bugs)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

const SRC_ROOT = resolve(process.cwd(), 'src');
const KOREAN_RANGE = /[\uAC00-\uD7AF]/;

/**
 * Recursive .ts walker — avoids pulling `glob` as a direct dependency.
 * Skips `__tests__` directories and `*.test.ts` files (same filter as the
 * previous globSync call).
 */
function listTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const abs = join(dir, name);
    const s = statSync(abs);
    if (s.isDirectory()) {
      out.push(...listTsFiles(abs));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

/** @typedef {{ name: string; severity: 'error' | 'warn'; test: (line: string, filePath: string, lines: readonly string[], lineIndex: number) => boolean }} Pattern */

function zObjectStatementHasExplicitUnknownKeyPolicy(lines, startIndex) {
  const statementLines = [];
  for (let i = startIndex; i < lines.length && i < startIndex + 120; i++) {
    const line = lines[i];
    statementLines.push(line);
    if (line.trimEnd().endsWith(';')) break;
  }
  const statement = statementLines.join('\n');
  return (
    statement.includes('.strict()') ||
    statement.includes('.passthrough()') ||
    statement.includes('.catchall(')
  );
}

/** @type {Pattern[]} */
const PATTERNS = [
  {
    name: '\\b wrapping Korean chars (ASCII-only word boundary)',
    severity: 'error',
    test: (line) => {
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return false;
      const regexes = line.match(/\/[^/\n]+\/[gimsuy]*/g) ?? [];
      return regexes.some((r) => {
        if (!r.includes('\\b') || !KOREAN_RANGE.test(r) || r.includes('\\p{')) return false;
        // Only flag when \\b is adjacent to a group containing Korean.
        // Pattern: \\b(?:...Korean...)\\b  — the \\b wraps the Korean group.
        // Safe pattern: \\b(?:English)\\b|(?:^|\\s)Korean — \\b only wraps English.
        // Heuristic: find \\b(?: groups and check if the group content has Korean.
        const groups = r.match(/\\b\(\?:[^)]+\)\\b/g) ?? [];
        return groups.some((g) => KOREAN_RANGE.test(g));
      });
    },
  },
  {
    name: 'Math.max/min(...spread) — stack overflow risk',
    severity: 'error',
    test: (line) => /Math\.(max|min)\(\.\.\./i.test(line) && !line.trimStart().startsWith('//'),
  },
  {
    name: 'JSON.parse(...) as T (unsafe cast, use unknown first)',
    severity: 'warn',
    test: (line, filePath) => {
      if (line.trimStart().startsWith('//')) return false;
      if (filePath.includes('__tests__') || filePath.includes('.test.')) return false;
      return /JSON\.parse\([^)]+\)\s+as\s+(?!unknown)/.test(line);
    },
  },
  {
    name: 'z.object() without .strict() in schema file',
    severity: 'warn',
    test: (line, filePath, lines, lineIndex) => {
      if (!filePath.includes('/schemas/')) return false;
      if (line.trimStart().startsWith('//')) return false;
      // Detect z.object({ ... }) whose full statement lacks an
      // explicit unknown-key policy. Multiline schemas are the common
      // style in this repo, so same-line checks produce false positives.
      return (
        /z\.object\(\{/.test(line) &&
        !zObjectStatementHasExplicitUnknownKeyPolicy(lines, lineIndex)
      );
    },
  },
];

let errorCount = 0;
let warnCount = 0;

const files = listTsFiles(SRC_ROOT);

for (const filePath of files) {
  const relPath = relative(SRC_ROOT, filePath);
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      if (pattern.test(line, filePath, lines, i)) {
        const prefix = pattern.severity === 'error' ? '❌ ERROR' : '⚠️  WARN';
        console.log(`${prefix}: ${pattern.name}`);
        console.log(`  ${relPath}:${i + 1}`);
        console.log(`  ${line.trim()}`);
        console.log();
        if (pattern.severity === 'error') errorCount++;
        else warnCount++;
      }
    }
  }
}

console.log(`\nSecurity pattern scan: ${errorCount} error(s), ${warnCount} warning(s)`);
if (errorCount > 0) {
  console.log('❌ FAILED — fix all errors before pushing.');
  process.exit(1);
}
console.log('✅ Passed.');
