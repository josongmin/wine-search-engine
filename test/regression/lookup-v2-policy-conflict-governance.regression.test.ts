import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CORE_KOREAN_ICON_AMBIGUITY_CASES,
  CORE_KOREAN_ICON_QUERY_CASES,
  CORE_KOREAN_ICON_RELEASE_GATE_CASES,
} from '../support/core-korean-icon-fixtures.js';
import {
  loadLookupPolicyConflictRegistrySync,
} from '../../scripts/eval/lookup-v2-policy-conflict-registry.js';

type FixtureRow = {
  readonly qid: string;
  readonly query: string;
  readonly expected_status: 'resolved' | 'ambiguous' | 'failed' | 'redirect_discovery';
};

function loadJsonl(filePath: string): readonly FixtureRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FixtureRow);
}

describe('lookup-v2 policy-conflict governance', () => {
  const registryRows = loadLookupPolicyConflictRegistrySync();
  const registrySurfaces = registryRows.map((row) => row.surface).sort();
  const famousRows = loadJsonl(path.resolve(process.cwd(), 'test/fixtures/lookup-v2-korean-famous-expanded.jsonl'));
  const stretchRows = loadJsonl(path.resolve(process.cwd(), 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl'));
  const coreRecallOnlySurfaces = CORE_KOREAN_ICON_RELEASE_GATE_CASES
    .filter((testCase) => testCase.identitySafe === false)
    .map((testCase) => testCase.query)
    .sort();
  const coreNonIdentityQuerySurfaces = CORE_KOREAN_ICON_QUERY_CASES
    .filter((testCase) => testCase.identitySafe === false)
    .map((testCase) => testCase.query)
    .sort();
  const registrySurfacesPresentInCoreQueryCases = registrySurfaces
    .filter((surface) => coreNonIdentityQuerySurfaces.includes(surface))
    .sort();
  const coreAmbiguitySurfaces = CORE_KOREAN_ICON_AMBIGUITY_CASES
    .map((testCase) => testCase.query)
    .filter((query) => registrySurfaces.includes(query))
    .sort();

  it('keeps registry-owned policy conflicts aligned with core support fixtures', () => {
    expect(coreRecallOnlySurfaces).toEqual(expect.arrayContaining(registrySurfaces));
    expect(registrySurfacesPresentInCoreQueryCases).toEqual(registrySurfaces);
    expect(coreAmbiguitySurfaces).toEqual(registrySurfaces);
  });

  it('ensures each policy-conflict surface stays ambiguity-owned across famous/stretch fixtures', () => {
    for (const surface of registrySurfaces) {
      const famous = famousRows.find((row) => row.query === surface);
      const stretch = stretchRows.find((row) => row.query === surface);

      if (famous !== undefined) {
        expect(famous.expected_status).toBe('ambiguous');
      }
      expect(stretch?.expected_status).toBe('ambiguous');
    }
  });
});
