import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import {
  createEntityId,
  createSourceRecordId,
  type EntityId,
  type SourceRecordId,
} from '../../src/domain/shared/types/index.js';
import type { EnrichedSilverRecord, ProposedAlias } from '../../scripts/etl/types.js';
import type { TestFixtureAlias } from '../integration/helpers/test-container.js';

const GOLD_CATALOG_PATH = path.resolve(process.cwd(), 'data', 'gold-wine-catalog.jsonl');
const FIXTURE_SCRAPED_AT = '2026-04-22T00:00:00.000Z';
const FIXTURE_ALIAS_SOURCE = 'fixture:core_korean_icon_alias_v1';

const CatalogEntrySchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  producer: z.string().min(1),
  country: z.string().min(1),
  region: z.string().min(1),
  appellation: z.string().min(1).optional(),
  grapes: z.array(z.string().min(1)).min(1),
  wineType: z.enum(['red', 'white', 'sparkling', 'dessert', 'rosé', 'fortified']),
  vintageYear: z.number().int().min(1900).max(2030),
  priceUsd: z.number().finite().positive(),
  body: z.number().int().min(1).max(5).nullable(),
  tannin: z.number().int().min(1).max(5).nullable(),
  acidity: z.number().int().min(1).max(5).nullable(),
  criticScore: z.number().int().min(0).max(100),
  style: z.string().min(1),
  koreanAliases: z.array(z.string().min(1)).max(20),
}).strict();

type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export interface CoreKoreanEntityCase {
  readonly query: string;
  readonly expectedEntityId: string;
}

export const CORE_KOREAN_ICON_QUERY_CASES: readonly CoreKoreanEntityCase[] = [
  { query: '샤토 라투르', expectedEntityId: 'w-chateau-latour-2016' },
  { query: '샤또 라피트', expectedEntityId: 'w-chateau-lafite-rothschild-2016' },
  { query: '샤또 무통', expectedEntityId: 'w-chateau-mouton-rothschild-2018' },
  { query: '샤또 오브리옹', expectedEntityId: 'w-chateau-haut-brion-2015' },
  { query: '페트뤼스', expectedEntityId: 'w-petrus-2016' },
  { query: '슈발 블랑', expectedEntityId: 'w-cheval-blanc-2015' },
  { query: '로마네 콩티', expectedEntityId: 'w-drc-romanee-conti-2017' },
  { query: '아르망 루소', expectedEntityId: 'w-armand-rousseau-chambertin-2018' },
  { query: '코쉬 뒤리', expectedEntityId: 'w-coche-dury-corton-charlemagne-2019' },
  { query: '크뤼그', expectedEntityId: 'w-krug-grande-cuvee-170eme-nv' },
  { query: '돔 페리뇽', expectedEntityId: 'w-dom-perignon-2013' },
  { query: '루이 로드레 크리스탈', expectedEntityId: 'w-louis-roederer-cristal-2014' },
  { query: '사시카이아', expectedEntityId: 'w-sassicaia-2018' },
  { query: '티냐넬로', expectedEntityId: 'w-tignanello-2019' },
  { query: '오르넬라이아', expectedEntityId: 'w-ornellaia-2018' },
  { query: '자코모 콘테르노', expectedEntityId: 'w-giacomo-conterno-monfortino-2015' },
  { query: '베가 시실리아', expectedEntityId: 'w-vega-sicilia-unico-2012' },
  { query: '핑구스', expectedEntityId: 'w-pingus-2019' },
  { query: '알마비바', expectedEntityId: 'w-almaviva-2019' },
  { query: '돈 멜초', expectedEntityId: 'w-don-melchor-2019' },
  { query: '스크리밍 이글', expectedEntityId: 'w-screaming-eagle-2018' },
  { query: '할란 이스테이트', expectedEntityId: 'w-harlan-estate-2016' },
  { query: '펜폴즈 그레인지', expectedEntityId: 'w-penfolds-grange-2017' },
  { query: '에곤 뮐러', expectedEntityId: 'w-egon-muller-scharzhofberger-kabinett-2020' },
  { query: '샤또 디켐', expectedEntityId: 'w-chateau-dyquem-2015' },
] as const;

export interface CoreKoreanIconFixtureBundle {
  readonly cases: readonly CoreKoreanEntityCase[];
  readonly fixtureAliases: readonly TestFixtureAlias[];
  readonly fixtureDocuments: readonly RetrievalDocument[];
  readonly runtimeRecords: readonly EnrichedSilverRecord[];
  readonly entityIdBySourceId: ReadonlyMap<SourceRecordId, EntityId>;
}

let fixtureBundlePromise: Promise<CoreKoreanIconFixtureBundle> | undefined;

function parseNdjsonLines<T>(content: string, schema: z.ZodType<T>, filePath: string): readonly T[] {
  const records: T[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    const parsed = schema.safeParse(JSON.parse(line) as unknown);
    if (!parsed.success) {
      throw new Error(
        `Schema validation failed at ${filePath}:${index + 1}: ${parsed.error.message}`,
      );
    }
    records.push(parsed.data);
  }
  return records;
}

function normalizeSensoryNullable(value: number | null): number | null {
  return value === null ? null : Number((value / 5).toFixed(3));
}

function normalizeSensory(value: number | null): number | undefined {
  return value === null ? undefined : Number((value / 5).toFixed(3));
}

function inferSweetness(wineType: CatalogEntry['wineType']): number {
  switch (wineType) {
    case 'dessert':
      return 0.95;
    case 'sparkling':
      return 0.2;
    default:
      return 0.1;
  }
}

function derivePriceBand(priceUsd: number): 'value' | 'mid' | 'premium' | 'luxury' {
  if (priceUsd < 25) {
    return 'value';
  }
  if (priceUsd < 60) {
    return 'mid';
  }
  if (priceUsd <= 200) {
    return 'premium';
  }
  return 'luxury';
}

function buildSearchTextKo(entry: CatalogEntry, koreanAliases: readonly string[]): string {
  return [
    ...koreanAliases,
    entry.region,
    ...(entry.appellation !== undefined ? [entry.appellation] : []),
    ...entry.grapes,
    entry.style,
  ].join(' ');
}

function buildSearchTextEn(entry: CatalogEntry): string {
  return [
    entry.canonicalLabel,
    entry.producer,
    entry.region,
    ...(entry.appellation !== undefined ? [entry.appellation] : []),
    ...entry.grapes,
    entry.style,
  ].join(' ');
}

function collectCaseQueriesByEntityId(
  cases: readonly CoreKoreanEntityCase[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const testCase of cases) {
    const existing = grouped.get(testCase.expectedEntityId) ?? [];
    if (!existing.includes(testCase.query)) {
      existing.push(testCase.query);
    }
    grouped.set(testCase.expectedEntityId, existing);
  }
  return grouped;
}

function uniqueSurfaceList(values: Iterable<string>): readonly string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function buildFixtureAliasRows(
  entry: CatalogEntry,
  entityId: EntityId,
  caseQueries: readonly string[],
): readonly TestFixtureAlias[] {
  const surfaces = uniqueSurfaceList([
    entry.canonicalLabel,
    ...entry.koreanAliases,
    ...caseQueries,
  ]);

  return surfaces.map((surface) => ({
    surfaceForm: surface,
    entityId,
    confidence: surface === entry.canonicalLabel ? 1 : 0.95,
  }));
}

function toRetrievalDocument(
  entry: CatalogEntry,
  entityId: EntityId,
  caseQueries: readonly string[],
): RetrievalDocument {
  const identitySafe = uniqueSurfaceList([
    entry.canonicalLabel,
    ...entry.koreanAliases,
    ...caseQueries,
  ]);
  const noisyRecall = uniqueSurfaceList([
    ...entry.koreanAliases,
    ...caseQueries,
  ]);

  return {
    entityId,
    entityType: 'wine',
    canonicalLabel: entry.canonicalLabel,
    aliasesIdentitySafe: identitySafe,
    aliasesNoisyRecall: noisyRecall,
    producer: entry.producer,
    region: entry.region,
    grapes: entry.grapes,
    searchTextKo: buildSearchTextKo(entry, noisyRecall),
    searchTextEn: buildSearchTextEn(entry),
    semanticSummary: `${entry.canonicalLabel}. ${entry.style}.`,
    body: normalizeSensory(entry.body),
    sweetness: inferSweetness(entry.wineType),
    style: entry.style,
    priceBand: derivePriceBand(entry.priceUsd),
    pairing: [],
    availability: true,
    popularityScore: Number(Math.max(0.75, entry.criticScore / 100).toFixed(3)),
    vintageYear: entry.vintageYear,
    acidity: normalizeSensory(entry.acidity),
    tannin: normalizeSensory(entry.tannin),
    wineType: entry.wineType,
    grapePrimary: entry.grapes[0],
    country: entry.country,
    appellation: entry.appellation ?? entry.region,
    producerPrestige: Number((entry.criticScore / 100).toFixed(3)),
    criticScoreNormalized: Number((entry.criticScore / 100).toFixed(3)),
    ratingAvg: Number((entry.criticScore / 20).toFixed(2)),
    ratingsCount: 1_000,
    priceUsd: entry.priceUsd,
  };
}

function toProposedAliases(
  entry: CatalogEntry,
  caseQueries: readonly string[],
): readonly ProposedAlias[] {
  const proposalSurfaces = uniqueSurfaceList([
    ...entry.koreanAliases,
    ...caseQueries,
  ]);

  return proposalSurfaces.map((value) => ({
    value,
    type: 'translation',
    source: FIXTURE_ALIAS_SOURCE,
    confidencePrior: 0.95,
    needsReview: false,
  }));
}

function toEnrichedSilverRecord(
  entry: CatalogEntry,
  sourceId: SourceRecordId,
  caseQueries: readonly string[],
): EnrichedSilverRecord {
  const identitySafeProjection = uniqueSurfaceList([
    entry.canonicalLabel,
    ...entry.koreanAliases,
    ...caseQueries,
  ]);
  const noisyRecallProjection = uniqueSurfaceList([
    ...entry.koreanAliases,
    ...caseQueries,
  ]);

  return {
    sourceId,
    externalId: entry.entityId,
    canonicalLabel: entry.canonicalLabel,
    producer: entry.producer,
    vintageYear: entry.vintageYear,
    country: entry.country,
    region: entry.region,
    appellation: entry.appellation ?? null,
    wineType: entry.wineType,
    grapePrimary: entry.grapes[0] ?? null,
    grapes: entry.grapes,
    body: normalizeSensoryNullable(entry.body),
    sweetness: inferSweetness(entry.wineType),
    acidity: normalizeSensoryNullable(entry.acidity),
    tannin: normalizeSensoryNullable(entry.tannin),
    pairingTags: [],
    flavorProfiles: [],
    searchTextEn: buildSearchTextEn(entry),
    ratingAvg: Number((entry.criticScore / 20).toFixed(2)),
    ratingsCount: 1_000,
    priceUsd: entry.priceUsd,
    priceBand: derivePriceBand(entry.priceUsd),
    popularityScore: Number(Math.max(0.75, entry.criticScore / 100).toFixed(3)),
    scrapedAt: FIXTURE_SCRAPED_AT,
    alcoholPct: null,
    producerPrestige: Number((entry.criticScore / 100).toFixed(3)),
    isTopRated: entry.criticScore >= 97,
    aliases: {
      proposed: toProposedAliases(entry, caseQueries),
      identitySafeProjection,
      noisyRecallProjection,
    },
  };
}

async function loadCoreCatalogEntries(
  cases: readonly CoreKoreanEntityCase[],
): Promise<readonly CatalogEntry[]> {
  const content = await fs.readFile(GOLD_CATALOG_PATH, 'utf8');
  const records = parseNdjsonLines(content, CatalogEntrySchema, GOLD_CATALOG_PATH);
  const recordByEntityId = new Map(records.map((record) => [record.entityId, record] as const));
  const entries = cases.map((testCase) => {
    const record = recordByEntityId.get(testCase.expectedEntityId);
    if (record === undefined) {
      throw new Error(
        `Missing gold catalog entry for core Korean icon case: ${testCase.expectedEntityId}`,
      );
    }
    return record;
  });

  return uniqueSurfaceList(entries.map((entry) => entry.entityId))
    .map((entityId) => recordByEntityId.get(entityId))
    .filter((entry): entry is CatalogEntry => entry !== undefined);
}

async function buildFixtureBundle(): Promise<CoreKoreanIconFixtureBundle> {
  const cases = CORE_KOREAN_ICON_QUERY_CASES;
  const catalogEntries = await loadCoreCatalogEntries(cases);
  const caseQueriesByEntityId = collectCaseQueriesByEntityId(cases);

  const fixtureAliases: TestFixtureAlias[] = [];
  const fixtureDocuments: RetrievalDocument[] = [];
  const runtimeRecords: EnrichedSilverRecord[] = [];
  const entityIdBySourceId = new Map<SourceRecordId, EntityId>();

  for (const entry of catalogEntries) {
    const entityId = createEntityId(entry.entityId);
    const sourceId = createSourceRecordId(`core-${entry.entityId}`);
    const caseQueries = caseQueriesByEntityId.get(entry.entityId) ?? [];

    fixtureAliases.push(...buildFixtureAliasRows(entry, entityId, caseQueries));
    fixtureDocuments.push(toRetrievalDocument(entry, entityId, caseQueries));
    runtimeRecords.push(toEnrichedSilverRecord(entry, sourceId, caseQueries));
    entityIdBySourceId.set(sourceId, entityId);
  }

  return {
    cases,
    fixtureAliases,
    fixtureDocuments,
    runtimeRecords,
    entityIdBySourceId,
  };
}

export async function loadCoreKoreanIconFixtureBundle(): Promise<CoreKoreanIconFixtureBundle> {
  fixtureBundlePromise ??= buildFixtureBundle();
  return fixtureBundlePromise;
}
