/**
 * Structural invariant: NO regex in production code may use \\b (ASCII word
 * boundary) with Korean (가-힣) or accented Latin characters.
 *
 * \\b is ASCII-only: it treats Korean/accented chars as non-word, so
 * \\b(?:소고기|스테이크)\\b NEVER matches Korean text. This was the #1 bug
 * class across 32 audit rounds (50+ instances).
 *
 * This test scans ALL source files and fails if any pattern violates the rule.
 * It runs in the dev test lane so violations are caught at PR time.
 *
 * APPEND-ONLY. Never weaken the assertion.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'glob';

const KOREAN_RANGE = /[\uAC00-\uD7AF]/;
const SRC_ROOT = resolve(import.meta.dirname, '../../src');

/**
 * Scans a TypeScript source file for regex literals containing \\b + Korean.
 * Returns an array of { line, text } for each violation.
 */
function findViolations(filePath: string): { line: number; text: string }[] {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const violations: { line: number; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip comments
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;

    // Find regex literals containing \b wrapping a group that has Korean chars.
    // Safe: /\b(?:English)\b|(?:^|\s)Korean/ — \b only wraps English part.
    // Bad:  /\b(?:소고기|English)\b/ — \b wraps a group containing Korean.
    const regexLiterals = line.match(/\/[^/\n]+\/[gimsuy]*/g) ?? [];
    for (const literal of regexLiterals) {
      if (!literal.includes('\\b') || !KOREAN_RANGE.test(literal) || literal.includes('\\p{')) {
        continue;
      }
      // Extract \b(?:...)\b groups and check if ANY group contains Korean
      const groups = literal.match(/\\b\(\?:[^)]+\)\\b/g) ?? [];
      if (groups.some((g) => KOREAN_RANGE.test(g))) {
        violations.push({ line: i + 1, text: line.trim() });
      }
    }
  }
  return violations;
}

describe('Structural invariant: no \\b with Korean in production regex', () => {
  it('zero violations across all src/**/*.ts files', () => {
    const files = globSync('**/*.ts', {
      cwd: SRC_ROOT,
      ignore: ['**/__tests__/**', '**/*.test.ts'],
      absolute: true,
    });

    const allViolations: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const violations = findViolations(file);
      for (const v of violations) {
        allViolations.push({
          file: file.replace(SRC_ROOT + '/', ''),
          ...v,
        });
      }
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map((v) => `  ${v.file}:${v.line} — ${v.text}`)
        .join('\n');
      throw new Error(
        `Found ${allViolations.length} regex pattern(s) using \\b with Korean characters.\n` +
        `\\b is ASCII-only and silently fails on Korean. Use Unicode-aware boundaries.\n\n${report}`,
      );
    }

    expect(allViolations).toHaveLength(0);
  });
});

describe('Structural invariant: exported Korean regex patterns have /u flag', () => {
  it('PAIRING_PATTERNS — all Korean patterns use /u flag', async () => {
    const { PAIRING_PATTERNS } = await import(
      '../../src/domain/query/service/pairing-extractor.js'
    );
    for (const [tag, patterns] of Object.entries(PAIRING_PATTERNS)) {
      for (const pattern of patterns) {
        if (KOREAN_RANGE.test(pattern.source)) {
          expect(
            pattern.flags.includes('u'),
            `PAIRING_PATTERNS.${tag}: ${pattern.toString()} — Korean pattern missing /u flag`,
          ).toBe(true);
        }
      }
    }
  });
});
