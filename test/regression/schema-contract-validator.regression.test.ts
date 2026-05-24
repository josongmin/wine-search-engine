/**
 * Regression: tools/schema-contract/validate.ts must correctly classify the
 * three failure modes documented in RFC-018:
 *
 *   1. Bidirectional drift between vespa/app/schemas/wine_entity.sd and
 *      tools/schema-contract/field-ownership-matrix.yaml — always ERROR.
 *   2. Coverage shortfall against `coverage_required`:
 *        - fail_action: must → ERROR
 *        - fail_action: warn → WARN
 *        - fail_action: optional → silent (INFO)
 *   3. Boundary correctness: a measured value JUST under the threshold must
 *      fire COVERAGE_FAIL; JUST at or above the threshold must NOT.
 *
 * Append-only regression suite — never delete (CLAUDE.md test discipline).
 *
 * The test also asserts that the SHIPPED matrix (field-ownership-matrix.yaml)
 * is in sync with the SHIPPED wine_entity.sd — RFC-018 §2 invariant
 * "row count == .sd field declaration count". This is the cheap CI gate that
 * catches matrix/.sd drift on every test run.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseSchemaFieldNames,
  loadFieldOwnershipMatrix,
  measureFieldCoverage,
  classifyFindings,
  parsePreparedFeedNdjson,
  type FieldOwnershipRow,
  type Finding,
} from '../../tools/schema-contract/validate.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SHIPPED_SCHEMA = resolve(REPO_ROOT, 'vespa/app/schemas/wine_entity.sd');
const SHIPPED_MATRIX = resolve(REPO_ROOT, 'tools/schema-contract/field-ownership-matrix.yaml');

// ---------------------------------------------------------------------------
// Test fixtures — built inline so the test never depends on synthetic temp
// dir state. Vespa .sd grammar excerpt is minimal but realistic.
// ---------------------------------------------------------------------------

const SYNTHETIC_SCHEMA = `
schema wine_entity {
  document wine_entity {
    field entity_id type string { indexing: summary | attribute }
    field canonical_label type string { indexing: summary | attribute | index }
    field appellation type string { indexing: summary | attribute | index }
    field soil_type type string { indexing: summary | attribute }
    field rare_field type string { indexing: summary | attribute }
    # comment line — should be ignored: field commented_out type string
  }
  fieldset default {
    fields: canonical_label, appellation
  }
  document-summary minimal {
    summary entity_id {}
    summary canonical_label {}
  }
}
`;

const SYNTHETIC_MATRIX_YAML = `
fields:
  - field: entity_id
    source: silver(test)
    coverage_required: 1.0
    fail_action: must
    rationale: "Identity field — always required."

  - field: canonical_label
    source: silver(test)
    coverage_required: 1.0
    fail_action: must
    rationale: "Identity field — always required."

  - field: appellation
    source: silver(test) + ETL backfill PENDING
    coverage_required: 0.0
    fail_action: warn
    rationale: "Not yet backfilled — tracked for Wave 4."
    ticket: "TODO-test"

  - field: soil_type
    source: unknown
    coverage_required: 0.0
    fail_action: warn
    rationale: "No writer exists — tracked TODO."
    ticket: "TODO-test"

  - field: rare_field
    source: derived(test)
    coverage_required: 0.0
    fail_action: optional
    rationale: "Optional substrate; presence is informational only."
`;

function buildDoc(fields: Record<string, unknown>): { id: string; fields: Record<string, unknown> } {
  const rawId = fields['entity_id'];
  const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : 'unknown';
  return { id, fields };
}

// ---------------------------------------------------------------------------
// SHIPPED-artifact gates (.sd ↔ matrix.yaml)
// ---------------------------------------------------------------------------

describe('schema-contract: shipped artifacts stay in sync (RFC-018 §2)', () => {
  it('matrix row count matches wine_entity.sd field declaration count', () => {
    const schemaSource = readFileSync(SHIPPED_SCHEMA, 'utf-8');
    const matrixSource = readFileSync(SHIPPED_MATRIX, 'utf-8');
    const schemaFields = parseSchemaFieldNames(schemaSource);
    const matrix = loadFieldOwnershipMatrix(matrixSource, SHIPPED_MATRIX);
    expect(matrix.length).toBe(schemaFields.length);
  });

  it('every shipped matrix row references a declared .sd field', () => {
    const schemaSource = readFileSync(SHIPPED_SCHEMA, 'utf-8');
    const matrixSource = readFileSync(SHIPPED_MATRIX, 'utf-8');
    const schemaSet = new Set(parseSchemaFieldNames(schemaSource));
    const matrix = loadFieldOwnershipMatrix(matrixSource, SHIPPED_MATRIX);
    const stale = matrix.filter((row) => !schemaSet.has(row.field)).map((row) => row.field);
    expect(stale).toEqual([]);
  });

  it('every shipped .sd field has a matrix row', () => {
    const schemaSource = readFileSync(SHIPPED_SCHEMA, 'utf-8');
    const matrixSource = readFileSync(SHIPPED_MATRIX, 'utf-8');
    const matrixSet = new Set(
      loadFieldOwnershipMatrix(matrixSource, SHIPPED_MATRIX).map((r) => r.field),
    );
    const schemaFields = parseSchemaFieldNames(schemaSource);
    const missing = schemaFields.filter((f) => !matrixSet.has(f));
    expect(missing).toEqual([]);
  });

  it('every shipped matrix row uses a valid fail_action enum', () => {
    const matrixSource = readFileSync(SHIPPED_MATRIX, 'utf-8');
    const matrix = loadFieldOwnershipMatrix(matrixSource, SHIPPED_MATRIX);
    const valid = new Set(['must', 'warn', 'optional']);
    for (const row of matrix) {
      expect(valid.has(row.fail_action)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure-helper behavior
// ---------------------------------------------------------------------------

describe('parseSchemaFieldNames', () => {
  it('extracts every top-level field declaration once, sorted', () => {
    const fields = parseSchemaFieldNames(SYNTHETIC_SCHEMA);
    expect(fields).toEqual(['appellation', 'canonical_label', 'entity_id', 'rare_field', 'soil_type']);
  });

  it('ignores comments containing the word "field"', () => {
    const src = `
      # field commented_out type string
      field real_one type string { indexing: attribute }
    `;
    expect(parseSchemaFieldNames(src)).toEqual(['real_one']);
  });

  it('ignores summary entries inside document-summary blocks', () => {
    const fields = parseSchemaFieldNames(SYNTHETIC_SCHEMA);
    // Even though the synthetic schema has `summary entity_id {}` and
    // `summary canonical_label {}` inside `document-summary minimal`, those
    // do NOT inflate the count beyond the 5 real fields.
    expect(fields.length).toBe(5);
  });
});

describe('loadFieldOwnershipMatrix', () => {
  it('parses a well-formed matrix and returns rows in declaration order', () => {
    const rows = loadFieldOwnershipMatrix(SYNTHETIC_MATRIX_YAML, 'synthetic');
    expect(rows.map((r) => r.field)).toEqual(['entity_id', 'canonical_label', 'appellation', 'soil_type', 'rare_field']);
  });

  it('throws on duplicate field rows', () => {
    const dup = `
fields:
  - field: foo
    source: a
    coverage_required: 1.0
    fail_action: must
    rationale: "first"
  - field: foo
    source: b
    coverage_required: 1.0
    fail_action: must
    rationale: "duplicate"
`;
    expect(() => loadFieldOwnershipMatrix(dup, 'synthetic')).toThrow(/duplicate matrix entry/u);
  });

  it('rejects unknown fail_action values', () => {
    const bad = `
fields:
  - field: foo
    source: a
    coverage_required: 1.0
    fail_action: panic
    rationale: "invalid action"
`;
    expect(() => loadFieldOwnershipMatrix(bad, 'synthetic')).toThrow();
  });

  it('rejects coverage_required outside [0,1]', () => {
    const bad = `
fields:
  - field: foo
    source: a
    coverage_required: 1.5
    fail_action: warn
    rationale: "out of range"
`;
    expect(() => loadFieldOwnershipMatrix(bad, 'synthetic')).toThrow();
  });

  it('rejects extra top-level keys (strict shape)', () => {
    const bad = `
fields:
  - field: foo
    source: a
    coverage_required: 1.0
    fail_action: warn
    rationale: "ok"
    bogus_key: "should fail"
`;
    expect(() => loadFieldOwnershipMatrix(bad, 'synthetic')).toThrow();
  });
});

describe('parsePreparedFeedNdjson', () => {
  it('parses NDJSON with one prepared doc per non-blank line', () => {
    const src = `${JSON.stringify({ id: 'a', fields: { entity_id: 'a' } })}
${JSON.stringify({ id: 'b', fields: { entity_id: 'b' } })}

${JSON.stringify({ id: 'c', fields: { entity_id: 'c' } })}
`;
    const docs = parsePreparedFeedNdjson(src, 'synthetic');
    expect(docs.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('throws on a malformed prepared-feed line', () => {
    expect(() => parsePreparedFeedNdjson('not-json', 'synthetic')).toThrow();
  });

  it('throws on a prepared-feed line missing the {id, fields} shape', () => {
    expect(() => parsePreparedFeedNdjson('{"id":"a"}', 'synthetic')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// classifyFindings — the heart of the validator
// ---------------------------------------------------------------------------

function buildMatrix(rows: readonly FieldOwnershipRow[]): readonly FieldOwnershipRow[] {
  return rows;
}

function severitySet(findings: readonly Finding[], kind: Finding['kind']): readonly Finding[] {
  return findings.filter((f) => f.kind === kind);
}

describe('classifyFindings — drift detection (RFC-018 §4.2 step 3)', () => {
  it('reports DRIFT_MISSING_MATRIX_ENTRY when schema declares a field absent from the matrix', () => {
    const findings = classifyFindings({
      schemaFields: ['canonical_label', 'extra_unmapped_field'],
      matrix: buildMatrix([
        {
          field: 'canonical_label',
          source: 'test',
          coverage_required: 1.0,
          fail_action: 'must',
          rationale: 'id',
        },
      ]),
      coverage: undefined,
    });
    const drift = severitySet(findings, 'DRIFT_MISSING_MATRIX_ENTRY');
    expect(drift.length).toBe(1);
    expect(drift[0]?.field).toBe('extra_unmapped_field');
    expect(drift[0]?.severity).toBe('ERROR');
  });

  it('reports DRIFT_STALE_MATRIX_ENTRY when matrix references a field absent from the schema', () => {
    const findings = classifyFindings({
      schemaFields: ['canonical_label'],
      matrix: buildMatrix([
        {
          field: 'canonical_label',
          source: 'test',
          coverage_required: 1.0,
          fail_action: 'must',
          rationale: 'id',
        },
        {
          field: 'removed_field',
          source: 'test',
          coverage_required: 0.0,
          fail_action: 'warn',
          rationale: 'should be removed',
        },
      ]),
      coverage: undefined,
    });
    const drift = severitySet(findings, 'DRIFT_STALE_MATRIX_ENTRY');
    expect(drift.length).toBe(1);
    expect(drift[0]?.field).toBe('removed_field');
    expect(drift[0]?.severity).toBe('ERROR');
  });
});

describe('classifyFindings — coverage classification (RFC-018 §5)', () => {
  const schemaFields = ['entity_id', 'canonical_label', 'appellation', 'soil_type', 'rare_field'];
  const matrix: readonly FieldOwnershipRow[] = loadFieldOwnershipMatrix(
    SYNTHETIC_MATRIX_YAML,
    'synthetic',
  );

  it('fail_action=must with coverage shortfall → ERROR', () => {
    const docs = [
      buildDoc({ entity_id: 'a' }), // canonical_label MISSING
      buildDoc({ entity_id: 'b', canonical_label: 'B' }),
    ];
    const coverage = measureFieldCoverage(docs, schemaFields);
    const findings = classifyFindings({ schemaFields, matrix, coverage });
    const fails = findings.filter((f) => f.kind === 'COVERAGE_FAIL' && f.field === 'canonical_label');
    expect(fails.length).toBe(1);
    expect(fails[0]?.severity).toBe('ERROR');
  });

  it('fail_action=warn with coverage shortfall → WARN (not ERROR)', () => {
    // appellation requires 0.0 — so any value passes; intentionally raise the
    // bar via a custom matrix for this specific case to force a shortfall.
    const customMatrix: readonly FieldOwnershipRow[] = [
      {
        field: 'appellation',
        source: 'test',
        coverage_required: 0.5,
        fail_action: 'warn',
        rationale: 'half required for the test',
      },
    ];
    const docs = [
      buildDoc({ entity_id: 'a', appellation: 'Margaux' }),
      buildDoc({ entity_id: 'b' }),
      buildDoc({ entity_id: 'c' }),
      buildDoc({ entity_id: 'd' }),
    ];
    const coverage = measureFieldCoverage(docs, ['appellation']);
    const findings = classifyFindings({
      schemaFields: ['appellation'],
      matrix: customMatrix,
      coverage,
    });
    const fails = findings.filter((f) => f.kind === 'COVERAGE_FAIL');
    expect(fails.length).toBe(1);
    expect(fails[0]?.severity).toBe('WARN');
  });

  it('fail_action=optional is silent regardless of coverage', () => {
    // rare_field is `optional` in the synthetic matrix.
    const docs = [
      buildDoc({ entity_id: 'a' }),
      buildDoc({ entity_id: 'b' }),
    ];
    const coverage = measureFieldCoverage(docs, schemaFields);
    const findings = classifyFindings({ schemaFields, matrix, coverage });
    const rare = findings.filter((f) => f.field === 'rare_field');
    // Optional rows still emit one INFO entry (COVERAGE_SKIPPED) for the report,
    // but never produce ERROR/WARN.
    expect(rare.every((f) => f.severity === 'INFO')).toBe(true);
    expect(rare.some((f) => f.kind === 'COVERAGE_SKIPPED')).toBe(true);
  });

  it('coverage at exactly the threshold → OK (boundary just-at)', () => {
    const customMatrix: readonly FieldOwnershipRow[] = [
      {
        field: 'appellation',
        source: 'test',
        coverage_required: 0.5,
        fail_action: 'must',
        rationale: 'exactly half',
      },
    ];
    const docs = [
      buildDoc({ entity_id: 'a', appellation: 'X' }),
      buildDoc({ entity_id: 'b' }),
    ];
    const coverage = measureFieldCoverage(docs, ['appellation']);
    expect(coverage.get('appellation')).toBe(0.5);
    const findings = classifyFindings({
      schemaFields: ['appellation'],
      matrix: customMatrix,
      coverage,
    });
    expect(findings.find((f) => f.kind === 'COVERAGE_OK' && f.field === 'appellation')).toBeDefined();
    expect(findings.find((f) => f.kind === 'COVERAGE_FAIL')).toBeUndefined();
  });

  it('coverage just under the threshold → COVERAGE_FAIL (boundary just-under)', () => {
    const customMatrix: readonly FieldOwnershipRow[] = [
      {
        field: 'appellation',
        source: 'test',
        coverage_required: 0.5,
        fail_action: 'must',
        rationale: 'exactly half',
      },
    ];
    // 1 out of 3 = 0.333, below 0.5.
    const docs = [
      buildDoc({ entity_id: 'a', appellation: 'X' }),
      buildDoc({ entity_id: 'b' }),
      buildDoc({ entity_id: 'c' }),
    ];
    const coverage = measureFieldCoverage(docs, ['appellation']);
    const findings = classifyFindings({
      schemaFields: ['appellation'],
      matrix: customMatrix,
      coverage,
    });
    const fail = findings.find((f) => f.kind === 'COVERAGE_FAIL' && f.field === 'appellation');
    expect(fail).toBeDefined();
    expect(fail?.severity).toBe('ERROR');
  });

  it('100% coverage on a `must` row → COVERAGE_OK', () => {
    const docs = [
      buildDoc({ entity_id: 'a', canonical_label: 'A' }),
      buildDoc({ entity_id: 'b', canonical_label: 'B' }),
    ];
    const coverage = measureFieldCoverage(docs, schemaFields);
    const findings = classifyFindings({ schemaFields, matrix, coverage });
    const ok = findings.find((f) => f.kind === 'COVERAGE_OK' && f.field === 'canonical_label');
    expect(ok).toBeDefined();
    expect(ok?.severity).toBe('INFO');
  });
});

describe('classifyFindings — excluded_from_live_probe (RFC-018 §5 amendment)', () => {
  // Fields like `embedding` are intentionally omitted from
  // `document-summary full` in wine_entity.sd. The live Vespa probe always
  // reads via summary=full, so those fields look 0% even when ingest is healthy.
  // The matrix row may set `excluded_from_live_probe: true` (+ reason) to skip
  // coverage enforcement ONLY in live mode — prepared-feed mode still enforces.

  const excludedRow: FieldOwnershipRow = {
    field: 'canonical_label',
    source: 'derived(test)',
    coverage_required: 1.0,
    fail_action: 'must',
    rationale: 'required',
    excluded_from_live_probe: true,
    excluded_from_live_probe_reason: 'omitted from document-summary full by design',
  };

  it('live mode + excluded_from_live_probe → COVERAGE_SKIPPED (no ERROR on that field)', () => {
    const docs = [
      buildDoc({ entity_id: 'a' }), // canonical_label missing — live probe simulation
      buildDoc({ entity_id: 'b' }),
    ];
    const coverage = measureFieldCoverage(docs, ['canonical_label']);
    expect(coverage.get('canonical_label')).toBe(0);
    const findings = classifyFindings({
      schemaFields: ['canonical_label'],
      matrix: [excludedRow],
      coverage,
      coverageSource: 'live',
    });
    const failsForField = findings.filter((f) => f.field === 'canonical_label' && f.severity === 'ERROR');
    expect(failsForField.length).toBe(0);
    const skipped = findings.find((f) => f.kind === 'COVERAGE_SKIPPED' && f.field === 'canonical_label');
    expect(skipped).toBeDefined();
    expect(skipped?.message).toContain('omitted from document-summary full by design');
  });

  it('prepared-feed mode + excluded_from_live_probe → still enforces (ERROR)', () => {
    const docs = [
      buildDoc({ entity_id: 'a' }),
      buildDoc({ entity_id: 'b' }),
    ];
    const coverage = measureFieldCoverage(docs, ['canonical_label']);
    const findings = classifyFindings({
      schemaFields: ['canonical_label'],
      matrix: [excludedRow],
      coverage,
      coverageSource: 'prepared-feed',
    });
    const fail = findings.find((f) => f.kind === 'COVERAGE_FAIL' && f.field === 'canonical_label');
    expect(fail).toBeDefined();
    expect(fail?.severity).toBe('ERROR');
  });

  it('undefined coverageSource + excluded_from_live_probe → still enforces (defensive default)', () => {
    const docs = [buildDoc({ entity_id: 'a' })];
    const coverage = measureFieldCoverage(docs, ['canonical_label']);
    const findings = classifyFindings({
      schemaFields: ['canonical_label'],
      matrix: [excludedRow],
      coverage,
      // coverageSource intentionally omitted — defaults to full enforcement
    });
    const fail = findings.find((f) => f.kind === 'COVERAGE_FAIL' && f.field === 'canonical_label');
    expect(fail).toBeDefined();
  });

  it('matrix YAML: excluded_from_live_probe=true REQUIRES a reason', () => {
    const yamlMissingReason = `
fields:
  - field: embedding
    source: derived(test)
    coverage_required: 1.0
    fail_action: must
    rationale: required
    excluded_from_live_probe: true
`;
    expect(() => loadFieldOwnershipMatrix(yamlMissingReason, 'synthetic')).toThrow(
      /excluded_from_live_probe_reason/u,
    );
  });

  it('shipped matrix: every excluded_from_live_probe row carries a non-empty reason', () => {
    const matrixSource = readFileSync(SHIPPED_MATRIX, 'utf-8');
    const matrix = loadFieldOwnershipMatrix(matrixSource, SHIPPED_MATRIX);
    const excludedRows = matrix.filter((row) => row.excluded_from_live_probe === true);
    // Invariant: at least one (embedding); guarded so future removal triggers review.
    expect(excludedRows.length).toBeGreaterThan(0);
    for (const row of excludedRows) {
      expect(row.excluded_from_live_probe_reason).toBeDefined();
      expect(row.excluded_from_live_probe_reason?.length).toBeGreaterThan(0);
    }
  });
});

describe('measureFieldCoverage — populated-value semantics', () => {
  it('treats empty string as not populated', () => {
    const coverage = measureFieldCoverage(
      [buildDoc({ entity_id: 'a', canonical_label: '' })],
      ['canonical_label'],
    );
    expect(coverage.get('canonical_label')).toBe(0);
  });

  it('treats empty array as not populated', () => {
    const coverage = measureFieldCoverage(
      [buildDoc({ entity_id: 'a', grapes: [] })],
      ['grapes'],
    );
    expect(coverage.get('grapes')).toBe(0);
  });

  it('treats null and undefined as not populated', () => {
    const coverage = measureFieldCoverage(
      [
        buildDoc({ entity_id: 'a', appellation: null }),
        buildDoc({ entity_id: 'b' }),
      ],
      ['appellation'],
    );
    expect(coverage.get('appellation')).toBe(0);
  });

  it('treats numeric zero and boolean false as populated (valid values)', () => {
    const coverage = measureFieldCoverage(
      [
        buildDoc({ entity_id: 'a', body: 0 }),
        buildDoc({ entity_id: 'b', availability: false }),
      ],
      ['body', 'availability'],
    );
    expect(coverage.get('body')).toBe(0.5);
    expect(coverage.get('availability')).toBe(0.5);
  });
});
