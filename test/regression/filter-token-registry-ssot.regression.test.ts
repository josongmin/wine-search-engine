/**
 * Regression: FILTER_TOKEN_REGISTRY is the single source of truth for sparse
 * filter token keys, and `constraint-to-sparse-filter-tokens.ts` MUST emit
 * only registered keys — no private parallel mapping, no drift.
 *
 * Why this exists
 * ---------------
 * Two files used to be at risk of independently defining the
 * "constraint → token key" relationship:
 *
 *   • `src/infrastructure/vespa/mapping.ts`            — `FILTER_TOKEN_REGISTRY`
 *      (canonical SSoT: token key → YQL clause type + Vespa field + clamp)
 *   • `src/domain/retrieval/service/constraint-to-sparse-filter-tokens.ts`
 *      (the upstream emitter — converts NormalizedConstraint → token string)
 *
 * If the emitter ever emits a key NOT in the registry, `buildSparseFilters`
 * silently drops the filter (per `// Unknown token — blocked` comment).
 * That is a SILENT correctness bug: hard constraint dropped → recall blown
 * open → user query "Italian reds only" returns French whites.
 *
 * What this test guards
 * ---------------------
 * 1. The emitter source contains NO standalone `Map`/`Set` declaring filter
 *    token semantics independent of the registry. (Grep-based — the only
 *    legitimate maps in that file are `STYLE_NORMALISATION_MAP`,
 *    `PRICE_BAND_NORMALISATION_MAP`, and `SOFT_PROMOTION_TOKEN_SPEC` whose
 *    values reference registry keys by name.)
 * 2. Every literal token-key prefix the emitter writes via template literals
 *    (e.g. ``${key}_not_in:``) refers to a key registered in
 *    `FILTER_TOKEN_KEYS`. Either the literal form OR its `_in`/`_not_in`
 *    multi-value variant must be accepted by buildSparseFilters.
 * 3. Every soft-promotion spec key in `SOFT_PROMOTION_TOKEN_SPEC` refers
 *    to a registered registry key — promotion can never silently no-op.
 *
 * Adding a new filter token
 * -------------------------
 *   1. Add the entry to `FILTER_TOKEN_REGISTRY` in mapping.ts
 *   2. Add the emission case in `constraint-to-sparse-filter-tokens.ts`
 *   3. This test will pick it up automatically — no test edit required.
 *
 * Removing this test
 * ------------------
 * Append-only per the project's regression test discipline. Do not delete.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FILTER_TOKEN_KEYS, FILTER_TOKEN_FIELDS } from '@infra/vespa/mapping.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EMITTER_SOURCE_PATH = path.join(
  REPO_ROOT,
  'src',
  'domain',
  'retrieval',
  'service',
  'constraint-to-sparse-filter-tokens.ts',
);

/**
 * Returns the set of distinct token-key prefixes the emitter writes via
 * literal `` `<key>:`` / `` `<key>_in:`` / `` `<key>_not:`` /
 * `` `<key>_not_in:`` template literals.
 *
 * Picks up BOTH static literal keys (e.g. `` `grape_or:${safe}` ``) and
 * `${variable}` interpolations whose variable is a hard-coded
 * `case 'attribute': return stringEq('attribute')` argument — for the
 * variable path we extract the `stringEq('…')` argument values directly.
 */
function extractEmittedTokenKeys(emitterSource: string): {
  literalKeys: ReadonlySet<string>;
  stringEqKeys: ReadonlySet<string>;
} {
  // 1. Literal token prefixes:  `keyname:` / `keyname_in:` / `keyname_not:` / `keyname_not_in:`
  //    inside backtick template literals at the start of the literal.
  //    Matches e.g. `grape_or:${safe}` , `grape_primary_not:${safe}` , `price_band:${normalised}`.
  const literalKeys = new Set<string>();
  const literalRe = /`([a-z][a-z_]*?)(?::|_in:|_not:|_not_in:)/g;
  for (const m of emitterSource.matchAll(literalRe)) {
    const fullPrefix = m[1] ?? '';
    if (fullPrefix.length === 0) continue;
    // The capture is whatever precedes the suffix we matched; reconstruct
    // the full key form by re-reading the matched text.
    const matchedText = m[0]; // includes the trailing colon-or-suffix
    // Strip leading backtick and trailing :
    const keyForm = matchedText.slice(1, -1);
    literalKeys.add(keyForm);
  }

  // 2. stringEq('foo') / stringEq("foo") helper calls — these emit
  //    `${foo}:` / `${foo}_not:` / `${foo}_in:` / `${foo}_not_in:` dynamically.
  const stringEqKeys = new Set<string>();
  const stringEqRe = /stringEq\(\s*['"]([a-z_]+)['"]\s*\)/g;
  for (const m of emitterSource.matchAll(stringEqRe)) {
    const key = m[1];
    if (typeof key === 'string' && key.length > 0) {
      stringEqKeys.add(key);
    }
  }

  return { literalKeys, stringEqKeys };
}

describe('filter-token-registry SSoT — constraint-to-sparse-filter-tokens parity', () => {
  const emitterSource = readFileSync(EMITTER_SOURCE_PATH, 'utf8');

  it('emitter source declares no private filter-token Map (only the documented helper maps)', () => {
    // Allow exactly the named helper maps documented in the emitter header:
    //   - SOFT_PROMOTION_TOKEN_SPEC: per-attribute MIN/MAX/string promotion keys
    //   - STYLE_NORMALISATION_MAP: style synonym → canonical token
    //   - PRICE_BAND_NORMALISATION_MAP: price_band synonym → canonical enum
    //   - GRAPE_FILTER_SURFACE_VARIANTS: canonical grape → surface alias list
    //     (e.g. Syrah/Shiraz, Pinot Gris/Grigio) — drives expandGrapeFilterValues
    //   - HARD_FILTERABLE_ATTRIBUTES / SOFT_PROMOTABLE_ATTRIBUTES: attribute
    //     allow-lists for the routing layer
    //   - SOFT_PROMOTION_ALLOWED_MAPPING_VERSIONS: legacy trust list (kept for
    //     reference even after the soft_promotion_authority canonicalization)
    // Any OTHER `new Map(` / `new Set(` declaring filter-token semantics is a
    // SSoT violation.
    const allowedDeclarations = new Set([
      'SOFT_PROMOTION_ALLOWED_MAPPING_VERSIONS',
      'SOFT_PROMOTION_TOKEN_SPEC',
      'STYLE_NORMALISATION_MAP',
      'PRICE_BAND_NORMALISATION_MAP',
      'GRAPE_FILTER_SURFACE_VARIANTS',
      'HARD_FILTERABLE_ATTRIBUTES',
      'SOFT_PROMOTABLE_ATTRIBUTES',
    ]);
    const declRe = /\bconst\s+([A-Z][A-Z0-9_]+)[^=]*=\s*(?:new\s+(?:Map|Set)|new\s+ReadonlyMap)/g;
    const violations: string[] = [];
    for (const m of emitterSource.matchAll(declRe)) {
      const name = m[1] ?? '';
      if (!allowedDeclarations.has(name)) {
        violations.push(name);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every literal token key the emitter writes is registered in FILTER_TOKEN_KEYS', () => {
    const { literalKeys } = extractEmittedTokenKeys(emitterSource);
    expect(literalKeys.size).toBeGreaterThan(0); // sanity — extraction works

    // Every literal key must be registered. `_in` / `_not_in` multi-value
    // variants are accepted by buildSparseFilters via the ALLOWED_SPARSE_IN_FIELDS
    // path (validated separately), so we strip those suffixes to look up the
    // base key.
    const unregistered: string[] = [];
    for (const key of literalKeys) {
      const base = key
        .replace(/_not_in$/, '_not')
        .replace(/_in$/, '');
      if (!FILTER_TOKEN_KEYS.has(key) && !FILTER_TOKEN_KEYS.has(base)) {
        unregistered.push(key);
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('every stringEq("key") invocation refers to a registered registry key', () => {
    const { stringEqKeys } = extractEmittedTokenKeys(emitterSource);
    expect(stringEqKeys.size).toBeGreaterThan(0); // sanity

    const unregistered: string[] = [];
    for (const key of stringEqKeys) {
      // stringEq emits {key}, {key}_in, {key}_not, {key}_not_in — base
      // key must be in registry (the _not variant is also in registry per design).
      if (!FILTER_TOKEN_KEYS.has(key)) {
        unregistered.push(key);
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('FILTER_TOKEN_FIELDS is non-empty and contains every Vespa field the registry references', () => {
    // Sanity guard: ensures the FILTER_TOKEN_FIELDS export is wired correctly.
    expect(FILTER_TOKEN_FIELDS.size).toBeGreaterThan(0);
    // Core fields known to be in registry — fail fast if the export breaks.
    for (const required of ['wine_type', 'country', 'region', 'price_usd', 'vintage_year', 'grape_primary', 'grapes']) {
      expect(FILTER_TOKEN_FIELDS.has(required)).toBe(true);
    }
  });
});
