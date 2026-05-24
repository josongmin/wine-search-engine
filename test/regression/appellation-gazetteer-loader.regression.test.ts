/**
 * Regression: appellation gazetteer loader.
 *
 * Covers schema enforcement, dataset shape contract (size, required fields),
 * and module-scope caching semantics for
 * `tools/wikidata-backfill/appellation-matcher.ts`.
 *
 * Loaded gazetteer underwrites Vespa's `appellation` field — silent shape
 * regressions would corrupt the production index, so the loader fails closed
 * on any malformed entry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAppellationGazetteer,
  __resetGazetteerCacheForTests,
} from '../../tools/wikidata-backfill/appellation-matcher.js';

const MIN_REQUIRED_ENTRIES = 500;

describe('appellation gazetteer loader', () => {
  beforeEach(() => {
    __resetGazetteerCacheForTests();
  });

  it('loads the shipped gazetteer with at least the contracted entry count', () => {
    const g = loadAppellationGazetteer();
    expect(g.data.version).toBe(1);
    expect(g.data.entries.length).toBeGreaterThanOrEqual(MIN_REQUIRED_ENTRIES);
  });

  it('shipped gazetteer entries all carry the required fields (appellation, country, region)', () => {
    const g = loadAppellationGazetteer();
    for (const entry of g.data.entries) {
      expect(entry.appellation.length).toBeGreaterThan(0);
      expect(entry.country.length).toBeGreaterThan(0);
      expect(entry.region.length).toBeGreaterThan(0);
    }
  });

  it('shipped gazetteer has no duplicate appellation names (case-sensitive canonical)', () => {
    const g = loadAppellationGazetteer();
    const seen = new Set<string>();
    for (const entry of g.data.entries) {
      expect(seen.has(entry.appellation)).toBe(false);
      seen.add(entry.appellation);
    }
  });

  it('shipped gazetteer alias index does not collide with another canonical name from a DIFFERENT country', () => {
    // Aliases that resolve to the same country are fine (e.g. "Brunello" → "Brunello di Montalcino DOCG").
    // Aliases that resolve to a different country break the country-consistency safety check.
    const g = loadAppellationGazetteer();
    const aliasToCanonical = new Map<string, string>();
    for (const entry of g.data.entries) {
      for (const alias of entry.aliases ?? []) {
        const key = alias.toLowerCase();
        if (aliasToCanonical.has(key)) {
          // collision permitted only if both canonicals share country
          // (handled by gazetteer construction discipline)
          continue;
        }
        aliasToCanonical.set(key, entry.appellation);
      }
    }
    // The loader's nameToCanonical map merges aliases — make sure no canonical
    // entry's bare lowercase name is ALSO present as a different entry's alias.
    for (const entry of g.data.entries) {
      const aliasOwner = aliasToCanonical.get(entry.appellation.toLowerCase());
      if (aliasOwner !== undefined && aliasOwner !== entry.appellation) {
        const aliasOwnerEntry = g.byCanonical.get(aliasOwner);
        expect(aliasOwnerEntry?.country).toBe(entry.country);
      }
    }
  });

  it('caches the compiled gazetteer on the second call (same instance returned)', () => {
    const first = loadAppellationGazetteer();
    const second = loadAppellationGazetteer();
    expect(second).toBe(first);
  });

  it('cache is keyed by path: distinct paths produce distinct compiled instances', () => {
    const first = loadAppellationGazetteer();
    const tmpDir = mkdtempSync(join(tmpdir(), 'gazetteer-cache-'));
    const altPath = join(tmpDir, 'alt.json');
    writeFileSync(
      altPath,
      JSON.stringify({
        version: 1,
        rationale: 'test',
        entries: [{ appellation: 'TestOnly', country: 'France', region: 'TestRegion' }],
      }),
      'utf-8',
    );
    const alt = loadAppellationGazetteer(altPath);
    expect(alt).not.toBe(first);
    expect(alt.data.entries.length).toBe(1);
  });

  it('rejects malformed JSON with a diagnostic error', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gazetteer-bad-json-'));
    const badPath = join(tmpDir, 'bad.json');
    writeFileSync(badPath, '{ not valid json', 'utf-8');
    expect(() => loadAppellationGazetteer(badPath)).toThrow(/invalid JSON/iu);
  });

  it('rejects an entry missing the required `country` field via Zod', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gazetteer-missing-country-'));
    const badPath = join(tmpDir, 'bad.json');
    writeFileSync(
      badPath,
      JSON.stringify({
        version: 1,
        rationale: 'test',
        entries: [{ appellation: 'NoCountry', region: 'Somewhere' }],
      }),
      'utf-8',
    );
    expect(() => loadAppellationGazetteer(badPath)).toThrow(/schema validation/iu);
  });

  it('rejects an entry with empty string fields (Zod min(1) enforced)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gazetteer-empty-field-'));
    const badPath = join(tmpDir, 'bad.json');
    writeFileSync(
      badPath,
      JSON.stringify({
        version: 1,
        rationale: 'test',
        entries: [{ appellation: '', country: 'France', region: 'Bordeaux' }],
      }),
      'utf-8',
    );
    expect(() => loadAppellationGazetteer(badPath)).toThrow(/schema validation/iu);
  });

  it('rejects a gazetteer file with a duplicate appellation entry', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gazetteer-dup-'));
    const dupPath = join(tmpDir, 'dup.json');
    writeFileSync(
      dupPath,
      JSON.stringify({
        version: 1,
        rationale: 'test',
        entries: [
          { appellation: 'Pomerol', country: 'France', region: 'Bordeaux' },
          { appellation: 'Pomerol', country: 'France', region: 'Bordeaux' },
        ],
      }),
      'utf-8',
    );
    expect(() => loadAppellationGazetteer(dupPath)).toThrow(/duplicate/iu);
  });

  it('rejects an unknown top-level field (strict schema)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gazetteer-extra-key-'));
    const path = join(tmpDir, 'extra.json');
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        rationale: 'test',
        entries: [{ appellation: 'A', country: 'France', region: 'R' }],
        extraneous: true,
      }),
      'utf-8',
    );
    expect(() => loadAppellationGazetteer(path)).toThrow(/schema validation/iu);
  });
});
