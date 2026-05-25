/**
 * Regression: every Vespa schema field referenced by FILTER_TOKEN_REGISTRY
 * must exist in `vespa/app/schemas/wine_entity.sd`.
 *
 * Why this exists
 * ---------------
 * `FILTER_TOKEN_REGISTRY` is the SSoT for the (token key → Vespa field +
 * clause type) mapping. The Vespa schema (`.sd`) is the SSoT for the actual
 * field shape in the Vespa cluster. If the two drift — e.g. a schema rename
 * from `flavor_profiles` → `flavor_profile_tags` lands without updating the
 * registry — every query using that filter will produce YQL that references
 * a non-existent field. Vespa fails the query at parse time or, worse,
 * silently returns zero hits depending on the field name.
 *
 * What this test guards
 * ---------------------
 *   1. Parse `wine_entity.sd` for all `field <name> type ...` declarations.
 *   2. Assert that every field referenced by the registry
 *      (via `FILTER_TOKEN_FIELDS`) appears in the parsed schema field set.
 *
 * Read-only against the schema file — never modifies it.
 *
 * Removing this test
 * ------------------
 * Append-only per the project's regression test discipline. Do not delete.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FILTER_TOKEN_FIELDS } from '@infra/vespa/mapping.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VESPA_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'vespa',
  'app',
  'schemas',
  'wine_entity.sd',
);

/**
 * Extracts the set of field names from a Vespa schema document.
 *
 * `wine_entity.sd` declares fields with the pattern:
 *     field <name> type <type> {
 *
 * Both top-level (inside `document wine_entity { ... }`) and document-level
 * fields use the same syntax — we accept both.
 *
 * We deliberately do not parse the full `.sd` grammar; a regex over
 * "`field <ident> type`" line starts is sufficient and stable against the
 * Vespa SD format. The schema is checked into the repo and changes
 * infrequently — a fragile parser would generate more false-positives than
 * the drift cases we're trying to catch.
 */
function extractSchemaFields(schemaSource: string): ReadonlySet<string> {
  const fields = new Set<string>();
  // Match `field <name> type` at line start (after optional whitespace).
  // <name> is the Vespa identifier syntax: letters/digits/underscore.
  const fieldRe = /^\s*field\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+type\s/gm;
  for (const m of schemaSource.matchAll(fieldRe)) {
    const name = m[1];
    if (typeof name === 'string' && name.length > 0) {
      fields.add(name);
    }
  }
  return fields;
}

describe('filter-token registry ↔ Vespa schema parity', () => {
  const schemaSource = readFileSync(VESPA_SCHEMA_PATH, 'utf8');
  const schemaFields = extractSchemaFields(schemaSource);

  it('parser extracts the expected schema field set (sanity)', () => {
    // Sanity: well-known core fields must be present. Failure here means the
    // parser broke (probably a schema format change), not a registry drift.
    expect(schemaFields.size).toBeGreaterThan(10);
    for (const required of [
      'entity_id',
      'wine_type',
      'country',
      'region',
      'grape_primary',
      'grapes',
      'price_usd',
      'vintage_year',
      'drinking_window_start',
      'drinking_window_end',
    ]) {
      expect(schemaFields.has(required), `schema parser missed "${required}"`).toBe(true);
    }
  });

  it('every Vespa field referenced by FILTER_TOKEN_REGISTRY exists in wine_entity.sd', () => {
    const missing: string[] = [];
    for (const field of FILTER_TOKEN_FIELDS) {
      if (!schemaFields.has(field)) {
        missing.push(field);
      }
    }
    // Surface ALL missing fields at once so an operator updating the schema
    // can fix them in a single pass — failing on the first one would force
    // a tedious whack-a-mole loop.
    expect(missing).toEqual([]);
  });
});
