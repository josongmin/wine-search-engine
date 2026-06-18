import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  filterLookupV2StretchRows,
  LOOKUP_V2_STRETCH_POLICY_CONFLICT_QUERIES,
} from '../../../scripts/eval/lookup-v2-stretch-partitions.js';

type StretchStatus = 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';

interface StretchRow {
  readonly qid: string;
  readonly query: string;
  readonly expected_status: StretchStatus;
  readonly class: string;
}

function loadRows(): readonly StretchRow[] {
  return readFileSync(
    join(process.cwd(), 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as StretchRow);
}

describe('lookup-v2 stretch partitions', () => {
  it('keeps deterministic owner partitions over the realworld stretch corpus', () => {
    const rows = loadRows().map((row) => ({
      query: row.query,
      expectedStatus: row.expected_status,
    }));

    const entityOnly = filterLookupV2StretchRows(rows, 'entity-only');
    const discoveryOnly = filterLookupV2StretchRows(rows, 'discovery-only');
    const policyConflict = filterLookupV2StretchRows(rows, 'policy-conflict');
    const entityNoPolicy = filterLookupV2StretchRows(rows, 'entity-no-policy');

    expect(rows.length).toBe(746);
    expect(entityOnly.length).toBe(596);
    expect(discoveryOnly.length).toBe(150);
    expect(policyConflict.length).toBe(6);
    expect(entityNoPolicy.length).toBe(590);

    expect(discoveryOnly.every((row) => row.expectedStatus === 'redirect_discovery')).toBe(true);
    expect(entityOnly.every((row) => row.expectedStatus !== 'redirect_discovery')).toBe(true);
    expect(policyConflict.every((row) => LOOKUP_V2_STRETCH_POLICY_CONFLICT_QUERIES.has(row.query))).toBe(true);
    expect(entityNoPolicy.every(
      (row) => row.expectedStatus !== 'redirect_discovery'
        && !LOOKUP_V2_STRETCH_POLICY_CONFLICT_QUERIES.has(row.query),
    )).toBe(true);
  });
});
