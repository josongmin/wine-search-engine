import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CURATED_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/entity-alias-catalog.js';
import { KOREAN_WINE_ALIAS_CORRECTION_ENTRIES } from '../../src/domain/query/service/korean-wine-aliases.js';
import { buildNormalizedQueryViews } from '../../src/domain/query/service/query-normalizer.js';
import {
  CORE_KOREAN_ICON_AMBIGUITY_CASES,
  CORE_KOREAN_ICON_QUERY_CASES,
  CORE_KOREAN_ICON_RELEASE_GATE_CASES,
  type CoreKoreanReleaseGateCase,
} from '../support/core-korean-icon-fixtures.js';

const GOLD_CATALOG_PATH = path.resolve(process.cwd(), 'data', 'gold-wine-catalog.jsonl');
const NOISY_BENCHMARK_PATH = path.resolve(process.cwd(), 'data', 'noisy-entity-benchmark.jsonl');
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;

const NOISY_ENTITY_ID_TO_CORE_ENTITY_ID: Readonly<Record<string, string>> = {
  'opus-one-2018': 'w-opus-one-2018',
  'chateau-margaux-2015': 'w-chateau-margaux-2015',
  'romanee-conti-2015': 'w-drc-romanee-conti-2017',
  'penfolds-grange-2017': 'w-penfolds-grange-2017',
  'sauternes-2015': 'w-chateau-dyquem-2015',
  'barolo-giacomo': 'w-giacomo-conterno-monfortino-2015',
  'sassicaia-2018': 'w-sassicaia-2018',
};

const ENTITY_ALIAS_CANONICAL_TO_CORE_ENTITY_ID: Readonly<Record<string, string>> = {
  'Opus One': 'w-opus-one-2018',
  'Almaviva': 'w-almaviva-2019',
  'Pétrus': 'w-petrus-2016',
  'Tignanello': 'w-tignanello-2019',
  'Dom Pérignon': 'w-dom-perignon-2013',
  'Sassicaia': 'w-sassicaia-2018',
  'Château Margaux': 'w-chateau-margaux-2015',
  'Domaine de la Romanée-Conti': 'w-drc-romanee-conti-2017',
  'Château Lafite Rothschild': 'w-chateau-lafite-rothschild-2016',
  'Château Latour': 'w-chateau-latour-2016',
  'Château Mouton Rothschild': 'w-chateau-mouton-rothschild-2018',
  'Château Cheval Blanc': 'w-cheval-blanc-2015',
  'Château Haut-Brion': 'w-chateau-haut-brion-2015',
  'Krug': 'w-krug-grande-cuvee-170eme-nv',
  'Louis Roederer Cristal': 'w-louis-roederer-cristal-2014',
  'Ornellaia': 'w-ornellaia-2018',
  'Penfolds Grange': 'w-penfolds-grange-2017',
  "Château d'Yquem": 'w-chateau-dyquem-2015',
  'Coche-Dury': 'w-coche-dury-corton-charlemagne-2019',
  'Vega Sicilia Único': 'w-vega-sicilia-unico-2012',
  'Dominio de Pingus': 'w-pingus-2019',
  'Don Melchor': 'w-don-melchor-2019',
  'Screaming Eagle': 'w-screaming-eagle-2018',
  'Harlan Estate': 'w-harlan-estate-2016',
  'Egon Müller Scharzhofberger': 'w-egon-muller-scharzhofberger-kabinett-2020',
};

interface GoldCatalogRow {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly koreanAliases: readonly string[];
}

interface NoisyBenchmarkRow {
  readonly benchmark_id: string;
  readonly query: string;
  readonly expected_entity_id: string;
  readonly language: string;
}

function normalizeKeys(surface: string): readonly string[] {
  const views = buildNormalizedQueryViews(surface);
  return [views.strict, views.compact].filter((value, index, values) =>
    value.length > 0 && values.indexOf(value) === index
  );
}

function addSurface(target: Map<string, Set<string>>, entityId: string, surface: string): void {
  const existing = target.get(entityId) ?? new Set<string>();
  for (const key of normalizeKeys(surface)) {
    existing.add(key);
  }
  target.set(entityId, existing);
}

function hasSurface(target: ReadonlyMap<string, ReadonlySet<string>>, entityId: string, surface: string): boolean {
  const keys = target.get(entityId);
  if (keys === undefined) {
    return false;
  }
  return normalizeKeys(surface).some((key) => keys.has(key));
}

function buildReleaseSurfaceIndex(): ReadonlyMap<string, ReadonlySet<string>> {
  const surfaces = new Map<string, Set<string>>();
  for (const testCase of [...CORE_KOREAN_ICON_QUERY_CASES, ...CORE_KOREAN_ICON_RELEASE_GATE_CASES]) {
    addSurface(surfaces, testCase.expectedEntityId, testCase.query);
  }
  for (const testCase of CORE_KOREAN_ICON_AMBIGUITY_CASES) {
    if (testCase.expectedCandidateEntityId !== undefined) {
      addSurface(surfaces, testCase.expectedCandidateEntityId, testCase.query);
    }
  }
  return surfaces;
}

async function loadGoldCatalog(): Promise<readonly GoldCatalogRow[]> {
  const content = await fs.readFile(GOLD_CATALOG_PATH, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GoldCatalogRow);
}

async function loadNoisyBenchmark(): Promise<readonly NoisyBenchmarkRow[]> {
  const content = await fs.readFile(NOISY_BENCHMARK_PATH, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as NoisyBenchmarkRow);
}

function correctionSupportsQuery(query: string): boolean {
  const normalizedQuery = query.normalize('NFC');
  return KOREAN_WINE_ALIAS_CORRECTION_ENTRIES.some(([variant, canonical]) =>
    normalizedQuery.includes(variant) || normalizedQuery.includes(canonical)
  );
}

function caseHasGoldSource(testCase: CoreKoreanReleaseGateCase, rows: readonly GoldCatalogRow[]): boolean {
  const row = rows.find((candidate) => candidate.entityId === testCase.expectedEntityId);
  return row !== undefined && row.koreanAliases.some((alias) =>
    normalizeKeys(alias).some((key) => normalizeKeys(testCase.query).includes(key))
  );
}

function caseHasNoisySource(testCase: CoreKoreanReleaseGateCase, rows: readonly NoisyBenchmarkRow[]): boolean {
  return rows.some((row) =>
    NOISY_ENTITY_ID_TO_CORE_ENTITY_ID[row.expected_entity_id] === testCase.expectedEntityId
    && normalizeKeys(row.query).some((key) => normalizeKeys(testCase.query).includes(key))
  );
}

function caseHasEntityAliasCatalogSource(testCase: CoreKoreanReleaseGateCase): boolean {
  return CURATED_ENTITY_ALIAS_CATALOG.some((entry) =>
    ENTITY_ALIAS_CANONICAL_TO_CORE_ENTITY_ID[entry.canonicalValue] === testCase.expectedEntityId
    && normalizeKeys(entry.surface).some((key) => normalizeKeys(testCase.query).includes(key))
  );
}

describe('Core Korean iconic release gate source coverage', () => {
  it('covers Korean aliases from the gold catalog for every gated core entity', async () => {
    const releaseSurfaces = buildReleaseSurfaceIndex();
    const selectedEntityIds = new Set(releaseSurfaces.keys());
    const rows = await loadGoldCatalog();
    const missing = rows
      .filter((row) => selectedEntityIds.has(row.entityId))
      .flatMap((row) =>
        row.koreanAliases
          .filter((alias) => !hasSurface(releaseSurfaces, row.entityId, alias))
          .map((alias) => `${row.entityId}::${alias}`)
      );

    expect(missing).toEqual([]);
  });

  it('covers overlapping Korean noisy benchmark rows as resolve or ambiguity contracts', async () => {
    const releaseSurfaces = buildReleaseSurfaceIndex();
    const rows = await loadNoisyBenchmark();
    const missing = rows
      .filter((row) => HANGUL_RE.test(row.query))
      .map((row) => ({ row, coreEntityId: NOISY_ENTITY_ID_TO_CORE_ENTITY_ID[row.expected_entity_id] }))
      .filter(({ coreEntityId }) => coreEntityId !== undefined)
      .filter(({ row, coreEntityId }) => !hasSurface(releaseSurfaces, coreEntityId, row.query))
      .map(({ row, coreEntityId }) => `${row.benchmark_id}::${coreEntityId}::${row.query}`);

    expect(missing).toEqual([]);
  });

  it('covers curated Hangul entity alias catalog surfaces for the gated core entities', () => {
    const releaseSurfaces = buildReleaseSurfaceIndex();
    const missing = CURATED_ENTITY_ALIAS_CATALOG
      .map((entry) => ({
        entry,
        coreEntityId: ENTITY_ALIAS_CANONICAL_TO_CORE_ENTITY_ID[entry.canonicalValue],
      }))
      .filter(({ entry, coreEntityId }) => coreEntityId !== undefined && HANGUL_RE.test(entry.surface))
      .filter(({ entry, coreEntityId }) => !hasSurface(releaseSurfaces, coreEntityId, entry.surface))
      .map(({ entry, coreEntityId }) => `${coreEntityId}::${entry.surface}`);

    expect(missing).toEqual([]);
  });

  it('keeps release case source tags tied to their declared local source artifacts', async () => {
    const goldRows = await loadGoldCatalog();
    const noisyRows = await loadNoisyBenchmark();
    const missing = CORE_KOREAN_ICON_RELEASE_GATE_CASES.flatMap((testCase) => {
      const failures: string[] = [];
      if (testCase.sources.includes('korean_wine_aliases') && !correctionSupportsQuery(testCase.query)) {
        failures.push(`${testCase.query}::korean_wine_aliases`);
      }
      if (testCase.sources.includes('gold_wine_catalog') && !caseHasGoldSource(testCase, goldRows)) {
        failures.push(`${testCase.query}::gold_wine_catalog`);
      }
      if (testCase.sources.includes('noisy_entity_benchmark') && !caseHasNoisySource(testCase, noisyRows)) {
        failures.push(`${testCase.query}::noisy_entity_benchmark`);
      }
      if (testCase.sources.includes('entity_alias_catalog') && !caseHasEntityAliasCatalogSource(testCase)) {
        failures.push(`${testCase.query}::entity_alias_catalog`);
      }
      return failures;
    });

    expect(missing).toEqual([]);
  });
});
