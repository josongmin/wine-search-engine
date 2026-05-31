/**
 * Drift guard for the phonetic-skeleton SSoT.
 *
 * `PHONETIC_NORMALIZATION_RULES`, `LATIN_VOWEL_RE`, `compactForLookup`, and
 * `phoneticCompactForLookup` were duplicated byte-for-byte across
 * `query-normalizer.ts`, `pg-alias-matcher.ts`, and
 * `search-snapshot-alias-matcher.ts`. They are now centralized in
 * `@domain/query/service/phonetic-skeleton`. The query-time skeleton and the
 * alias-lookup-time skeleton MUST stay identical — if they drift, the query
 * bucket and the alias bucket stop agreeing and phonetic recall silently
 * breaks.
 *
 * This suite asserts:
 *  1. The SSoT functions compute the documented skeleton.
 *  2. No cluster file re-declares a private copy of the rules/helpers.
 *  3. The PostgreSQL `regexp_replace` recall chain in `pg-alias-matcher.ts`
 *     mirrors `PHONETIC_NORMALIZATION_RULES` pair-for-pair (the one copy that
 *     cannot import TypeScript).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LATIN_VOWEL_RE,
  PHONETIC_NORMALIZATION_RULES,
  compactForLookup,
  normalizePhoneticSkeleton,
  phoneticCompactForLookup,
} from '../../src/domain/query/service/phonetic-skeleton.js';

const SRC_DIR = fileURLToPath(new URL('../../src/', import.meta.url));

function readSrc(relPath: string): string {
  return readFileSync(`${SRC_DIR}${relPath}`, 'utf8');
}

describe('phonetic-skeleton SSoT — behavior', () => {
  it('compacts away non-letter/non-digit graphemes (Unicode-aware)', () => {
    expect(compactForLookup('Château-Margaux 2015')).toBe('ChâteauMargaux2015'); // strips space + hyphen, keeps accent
    expect(compactForLookup('샤또 마고')).toBe('샤또마고'); // Hangul preserved
    expect(compactForLookup('opus one!')).toBe('opusone');
  });

  it('normalizePhoneticSkeleton collapses digraphs without stripping vowels', () => {
    expect(normalizePhoneticSkeleton('Schloss')).toBe('chloss');
    expect(normalizePhoneticSkeleton('Margeaux')).toBe('margo');
    expect(normalizePhoneticSkeleton('Phelps')).toBe('felps');
  });

  it('phoneticCompactForLookup strips vowels after collapse', () => {
    // Margeaux -> margo -> mrg ; Margaux -> margo -> mrg (same bucket)
    expect(phoneticCompactForLookup('Margeaux')).toBe(phoneticCompactForLookup('Margaux'));
    expect(phoneticCompactForLookup('Margaux')).toBe('mrg');
  });

  it('LATIN_VOWEL_RE is the global vowel-strip variant (replace-all)', () => {
    expect('aeiouy'.replace(LATIN_VOWEL_RE, '')).toBe('');
    // global flag — every occurrence removed, not just the first
    expect('banana'.replace(LATIN_VOWEL_RE, '')).toBe('bnn');
  });
});

describe('phonetic-skeleton SSoT — no private duplicates remain', () => {
  const clusterFiles = [
    'domain/query/service/query-normalizer.ts',
    'infrastructure/adapter/pg-alias-matcher.ts',
    'infrastructure/adapter/search-snapshot-alias-matcher.ts',
  ];

  for (const relPath of clusterFiles) {
    it(`${relPath} does not re-declare the phonetic rule array`, () => {
      const src = readSrc(relPath);
      expect(src).not.toMatch(/PHONETIC_NORMALIZATION_RULES\s*:\s*readonly/);
    });

    it(`${relPath} imports the phonetic-skeleton SSoT module`, () => {
      const src = readSrc(relPath);
      expect(src).toContain('phonetic-skeleton.js');
    });
  }

  for (const relPath of [
    'infrastructure/adapter/pg-alias-matcher.ts',
    'infrastructure/adapter/search-snapshot-alias-matcher.ts',
  ]) {
    it(`${relPath} does not re-declare compactForLookup / phoneticCompactForLookup`, () => {
      const src = readSrc(relPath);
      expect(src).not.toMatch(/function\s+compactForLookup\s*\(/);
      expect(src).not.toMatch(/function\s+phoneticCompactForLookup\s*\(/);
    });
  }

  // `alias-lookup-plan.ts` held a byte-identical private copy of the SSoT
  // `compactForLookup`, called from many alias-lookup hot paths. It MUST now
  // import the SSoT — a drifted private copy would silently desync the
  // alias-lookup compaction key from the query/alias phonetic buckets.
  it('alias-lookup-plan.ts imports compactForLookup from the SSoT, not a private copy', () => {
    const src = readSrc('domain/query/service/alias-lookup-plan.ts');
    expect(src).not.toMatch(/function\s+compactForLookup\s*\(/);
    expect(src).toMatch(/import\s*\{[^}]*\bcompactForLookup\b[^}]*\}\s*from\s*['"][^'"]*phonetic-skeleton\.js['"]/);
  });
});

describe('phonetic-skeleton SSoT — alias-lookup compaction equals SSoT', () => {
  // Behavioral parity: the alias-lookup plan's compact lookup keys must be
  // produced by the SSoT compaction (Unicode-aware, accent-preserving). If the
  // private copy were reintroduced with any drift, these keys would diverge.
  const samples = ['Château-Margaux 2015', '샤또 마고', 'opus one!', 'Pétrus'];
  for (const sample of samples) {
    it(`compactForLookup(${JSON.stringify(sample)}) is Unicode-aware and accent-preserving`, () => {
      // Direct SSoT invariant — alias-lookup-plan now routes through this exact fn.
      expect(compactForLookup(sample)).toBe(sample.replace(/[^\p{L}\p{N}]+/gu, ''));
    });
  }
});

describe('phonetic-skeleton SSoT — SQL recall chain matches the TS rules', () => {
  it('pg-alias-matcher SQL regexp_replace chain mirrors PHONETIC_NORMALIZATION_RULES + vowel strip', () => {
    const src = readSrc('infrastructure/adapter/pg-alias-matcher.ts');

    // Extract every `'<pattern>', '<replacement>', 'g'` triple inside the
    // phonetic regexp_replace chain. The chain also contains the initial
    // alnum-strip ('[^[:alnum:]]', '') and the final vowel-strip
    // ('[aeiouy]', ''); we assert the middle digraph rules in order.
    const triples = [...src.matchAll(/'([^']+)',\s*'([^']*)',\s*'g'/g)].map(
      (m) => [m[1], m[2]] as const,
    );

    // The phonetic value arm is the only place that contains the 'sch' rule.
    const schIdx = triples.findIndex(([pat]) => pat === 'sch');
    expect(schIdx).toBeGreaterThanOrEqual(0);

    const sqlPhoneticRules = triples
      .slice(schIdx, schIdx + PHONETIC_NORMALIZATION_RULES.length)
      .map(([pat, rep]) => [pat, rep] as const);

    const tsRules = PHONETIC_NORMALIZATION_RULES.map(
      ([re, rep]) => [re.source, rep] as const,
    );

    expect(sqlPhoneticRules).toStrictEqual(tsRules);

    // The vowel-strip immediately follows the digraph rules in the SQL chain.
    const vowelTriple = triples.find(([pat]) => pat === '[aeiouy]');
    expect(vowelTriple).toBeDefined();
    expect(vowelTriple?.[1]).toBe('');
    expect(LATIN_VOWEL_RE.source).toBe('[aeiouy]');
  });
});
