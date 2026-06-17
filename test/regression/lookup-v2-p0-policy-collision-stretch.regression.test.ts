import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadLookupPolicyConflictRegistrySync } from '../../scripts/eval/lookup-v2-policy-conflict-registry.js';

const STRETCH_FIXTURE = join(process.cwd(), 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl');

const P0_AMBIGUOUS_SURFACES = [
  '라뚜르',
  '그랜지',
  '베가 시실리아',
  '자코모 콘테르노',
  '라피트',
  '무통',
] as const;

interface StretchRow {
  readonly query: string;
  readonly expected_status: string;
  readonly class?: string;
}

function loadStretchRows(): StretchRow[] {
  return readFileSync(STRETCH_FIXTURE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StretchRow);
}

describe('lookup-v2 P0 policy-collision stretch parity (append-only)', () => {
  it('keeps the six reviewed policy-conflict surfaces aligned with stretch corpus ambiguity rows', () => {
    const registry = loadLookupPolicyConflictRegistrySync();
    expect(registry.map((row) => row.surface)).toEqual([...P0_AMBIGUOUS_SURFACES]);

    const stretchByQuery = new Map(loadStretchRows().map((row) => [row.query, row]));
    const offenders: string[] = [];

    for (const surface of P0_AMBIGUOUS_SURFACES) {
      const stretchRow = stretchByQuery.get(surface);
      if (stretchRow === undefined) {
        offenders.push(`${surface}: missing from stretch corpus`);
        continue;
      }
      if (stretchRow.expected_status !== 'ambiguous') {
        offenders.push(`${surface}: expected ambiguous, got ${stretchRow.expected_status}`);
      }
      const registryRow = registry.find((row) => row.surface === surface);
      if (registryRow === undefined) {
        offenders.push(`${surface}: missing from policy-conflict registry`);
        continue;
      }
      if (registryRow.stretchExpectedStatus !== 'ambiguous') {
        const stretchStatus: string = registryRow.stretchExpectedStatus;
        offenders.push(`${surface}: registry stretchExpectedStatus=${stretchStatus}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
