/**
 * Regression: deterministic abbreviation-alias ETL emits a stable
 * proposal set per entity and the proposals satisfy the
 * `aliases.alias_type='abbreviation'` UPSERT contract.
 *
 * Why this is a regression test:
 *  - Append-only per CLAUDE.md regression-test discipline. Future ETL
 *    refactors must not silently lose any of the listed compound forms.
 *  - The benchmark contains 9 `abbreviation`-category cases; if the
 *    deterministic rules ever stop emitting "CM 15" or "DRC 19", the
 *    KIL noisy-benchmark regression for `abbreviation` will silently
 *    backslide to ~33% recall@3 (the pre-P1.4 baseline).
 *
 * No DB I/O — `commitProposals` is invoked separately by an integration
 * smoke test that owns the Postgres connection. This regression
 * exercises only the pure-function generation surface.
 */
import { describe, expect, it } from 'vitest';

import {
  generateDeterministicProposals,
  normalizeForLookup,
  deterministicAliasId,
  DETERMINISTIC_SOURCE_TAG,
  DETERMINISTIC_SOURCE_TRUST,
  DEFAULT_ALIAS_SCOPE,
} from '../../scripts/etl/generate-abbreviation-aliases.ts';

const NOW_YEAR = 2026;

interface EntityFixture {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly vintageYear?: number;
}

const FIXTURES: readonly EntityFixture[] = [
  { entityId: 'chateau-margaux-2015', canonicalLabel: 'Château Margaux 2015' },
  { entityId: 'opus-one-2018', canonicalLabel: 'Opus One 2018' },
  { entityId: 'penfolds-grange-2017', canonicalLabel: 'Penfolds Grange 2017' },
  { entityId: 'romanee-conti-2019', canonicalLabel: 'Domaine de la Romanée-Conti 2019' },
  { entityId: 'sassicaia-2018', canonicalLabel: 'Sassicaia 2018' },
  { entityId: 'sauternes-2015', canonicalLabel: "Château d'Yquem Sauternes 2015" },
];

function surfacesFor(fixture: EntityFixture): readonly string[] {
  const proposals = generateDeterministicProposals(
    {
      entityId: fixture.entityId,
      canonicalLabel: fixture.canonicalLabel,
      ...(fixture.vintageYear !== undefined ? { vintageYear: fixture.vintageYear } : {}),
    },
    NOW_YEAR,
    false,
  );
  return proposals.map((p) => p.surface);
}

describe('abbreviation-alias ETL — deterministic rules cover all KIL benchmark cases', () => {
  it('"Château Margaux 2015" emits "CM" + "CM 15" + "CM 2015" + "Margaux 15"', () => {
    const s = surfacesFor(FIXTURES[0]!);
    expect(s).toContain('CM');
    expect(s).toContain('CM 15');
    expect(s).toContain('CM 2015');
    expect(s).toContain('Margaux 15');
  });

  it('"Opus One 2018" emits "OO" + "OO 18" + "Opus 18"', () => {
    const s = surfacesFor(FIXTURES[1]!);
    expect(s).toContain('OO');
    expect(s).toContain('OO 18');
    expect(s).toContain('Opus 18');
  });

  it('"Penfolds Grange 2017" emits "PG" + "PG 17" + "Grange 17" + "Penfolds 17"', () => {
    const s = surfacesFor(FIXTURES[2]!);
    expect(s).toContain('PG');
    expect(s).toContain('PG 17');
    // Both iconic-name AND producer-prefix shorthand must be in the
    // deterministic output — the wine-community uses both conventions
    // and the regression set must keep covering them.
    expect(s).toContain('Grange 17');
    expect(s).toContain('Penfolds 17');
  });

  it('"Domaine de la Romanée-Conti 2019" emits "DRC" + "DRC 19" + "DRC 2019"', () => {
    const s = surfacesFor(FIXTURES[3]!);
    expect(s).toContain('DRC');
    expect(s).toContain('DRC 19');
    expect(s).toContain('DRC 2019');
  });

  it('"Sassicaia 2018" emits "Sassicaia 18" (single-word label; no R1 initialism possible)', () => {
    const s = surfacesFor(FIXTURES[4]!);
    // No 2-letter initialism for a single-word label (MIN_SIGNIFICANT_TOKENS=2).
    expect(s).not.toContain('SS');
    expect(s).toContain('Sassicaia 18');
    expect(s).toContain('sassicaia 18');
  });

  it("\"Château d'Yquem Sauternes 2015\" emits \"Yquem 15\" (strips elided d' article)", () => {
    const s = surfacesFor(FIXTURES[5]!);
    expect(s).toContain('Yquem 15');
    expect(s).toContain('yquem 15');
    // The initialism path strips the d' stop-word; CY (Château+Yquem)
    // and CYS (Château+Yquem+Sauternes) variants live in the set.
    expect(s).toContain('CY');
  });
});

describe('abbreviation-alias ETL — proposal contract', () => {
  it('each emitted proposal carries the abbreviation source tag and a deterministic alias id', () => {
    const fixture = FIXTURES[0]!;
    const proposals = generateDeterministicProposals(
      { entityId: fixture.entityId, canonicalLabel: fixture.canonicalLabel },
      NOW_YEAR,
      true,
    );
    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.entityId).toBe(fixture.entityId);
      expect(p.source).toBe(DETERMINISTIC_SOURCE_TAG);
      expect(p.sourceTrust).toBe(DETERMINISTIC_SOURCE_TRUST);
      expect(p.status).toBe('approved');
      expect(p.confidence).toBeGreaterThan(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
      expect(p.proposalId.length).toBeGreaterThan(0);
      expect(p.normalizedSurface).toBe(normalizeForLookup(p.surface));
    }
  });

  it('the alias id derivation is stable across runs (idempotent UPSERT keys)', () => {
    const id1 = deterministicAliasId(
      'chateau-margaux-2015',
      normalizeForLookup('CM 15'),
      'abbreviation',
      DEFAULT_ALIAS_SCOPE,
    );
    const id2 = deterministicAliasId(
      'chateau-margaux-2015',
      normalizeForLookup('CM 15'),
      'abbreviation',
      DEFAULT_ALIAS_SCOPE,
    );
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^abbr-[0-9a-f]{16}$/u);
  });

  it('autoApprove=false leaves all proposals in pending state', () => {
    const proposals = generateDeterministicProposals(
      { entityId: 'opus-one-2018', canonicalLabel: 'Opus One 2018' },
      NOW_YEAR,
      false,
    );
    for (const p of proposals) {
      expect(p.status).toBe('pending');
    }
  });
});
