#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BronzeRow, EnrichedSilverRecord, SilverWineRecord } from './types.js';
import { parseNdjson } from './ndjson.js';
import { transformRow, dedup, normalizePopularity } from './vivino-to-silver.js';
import { generateAliases } from './generate-aliases.js';
import { deterministicEmbedding, silverToRetrievalDoc } from './index-to-vespa.js';
import {
  SILVER_QUALITY_GATES,
  validateSilverRecords,
  type SilverQualityGateThresholds,
} from './validate-silver.js';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import { atomicWriteFile } from './etl-utils.js';
import { VespaSearchIndex } from '../../src/infrastructure/vespa/vespa-search-index.js';
import { toVespaFields } from '../../src/infrastructure/vespa/mapping.js';

const VESPA_URL = process.env['VESPA_URL'] ?? 'http://localhost:18080';
const VESPA_NAMESPACE = 'wine';
const VESPA_DOC_TYPE = 'wine_entity';

const SMOKE_GATES: SilverQualityGateThresholds = {
  ...SILVER_QUALITY_GATES,
  minRecords: 2,
  minTastingNotesCoverage: 0.5,
  minAliasMeanCount: 2,
};

function makeBronzeFixtures(): BronzeRow[] {
  return [
    {
      id: 1,
      external_id: 'opus-one-2018',
      display_name: 'Opus One',
      producer: 'Opus One Winery',
      vintage_year: 2018,
      region: 'Napa Valley',
      country: 'United States',
      wine_style: 'red wine',
      rating: 4.7,
      price: 420,
      currency: 'USD',
      scraped_at: '2026-04-06T00:00:00.000Z',
      source_url: 'https://example.test/opus-one-2018',
      payload: {
        winery: { name: 'Opus One Winery', id: 1 },
        vintage: { year: 2018 },
        style: {
          description: 'Dense blackberry, cedar, graphite, and polished oak.',
          body_description: 'Full-bodied and structured.',
          acidity_description: 'Fresh but integrated acidity.',
        },
        statistics: {
          ratings_average: 4.7,
          ratings_count: 812,
          labels_count: 12,
        },
        grapes: [{ name: 'Cabernet Sauvignon' }, { name: 'Merlot' }],
        food_pairings: ['steak', 'aged cheese'],
        region: {
          name: 'Napa Valley',
          country: { name: 'United States', code: 'US' },
        },
        taste: {
          structure: {
            acidity: 3,
            fizziness: 0,
            intensity: 5,
            sweetness: 1,
            tannin: 4,
          },
          flavor: [
            { group: 'black-fruit', stats: { count: 25 } },
            { group: 'oak', stats: { count: 18 } },
          ],
        },
        // SOTA++ fields — exercises parseAlcohol, producerPrestige, isTopRated, merchant_prices
        alcohol: '14.5%',
        winery_rating: 4.6,
        winery_wine_count: 2,
        winery_rating_count: 1200,
        winery_location: 'Napa Valley',
        badges: ['Top 1%', 'Best Value'],
        varietal: 'Cabernet Sauvignon, Merlot',
        rating_count: 812,
        bottle_ml: 750,
        merchant_prices: [
          { price: 420, currency: 'USD', merchant: 'WineAccess' },
          { price: 435, currency: 'USD', merchant: 'VinoCellars' },
          { price: 410, currency: 'USD', merchant: 'WineSearcher' },
        ],
      },
    },
    {
      id: 2,
      external_id: 'opus-one-2018',
      display_name: 'Opus One',
      producer: 'Opus One Winery',
      vintage_year: 2018,
      region: 'Napa Valley',
      country: 'United States',
      wine_style: 'red wine',
      rating: 4.6,
      price: 415,
      currency: 'USD',
      scraped_at: '2025-12-01T00:00:00.000Z',
      source_url: 'https://example.test/opus-one-2018-older',
      payload: {
        winery: { name: 'Opus One Winery', id: 1 },
        vintage: { year: 2018 },
        style: {
          description: 'Older snapshot used to exercise dedup.',
          body_description: 'Full-bodied.',
          acidity_description: 'Balanced acidity.',
        },
        statistics: {
          ratings_average: 4.6,
          ratings_count: 700,
          labels_count: 9,
        },
        grapes: [{ name: 'Cabernet Sauvignon' }],
        food_pairings: ['steak'],
        region: {
          name: 'Napa Valley',
          country: { name: 'United States', code: 'US' },
        },
        taste: {
          structure: {
            acidity: 3,
            fizziness: 0,
            intensity: 4,
            sweetness: 1,
            tannin: 4,
          },
          flavor: [{ group: 'black-fruit', stats: { count: 10 } }],
        },
        // Older scrape — lacks some SOTA++ fields to exercise mergeSOTAPlusFields()
        alcohol: '14.5%',
        winery_rating: 4.6,
        badges: [],
      },
    },
    {
      id: 3,
      external_id: 'margaux-2015',
      display_name: 'Château Margaux',
      producer: 'Château Margaux',
      vintage_year: 2015,
      region: 'Bordeaux',
      country: 'France',
      wine_style: 'red wine',
      rating: 4.9,
      price: 950,
      currency: 'USD',
      scraped_at: '2026-04-06T00:00:00.000Z',
      source_url: 'https://example.test/margaux-2015',
      payload: {
        winery: { name: 'Château Margaux', id: 2 },
        vintage: { year: 2015 },
        style: {
          description: 'Cassis, violet, tobacco leaf, and mineral length.',
          body_description: 'Powerful and elegant full body.',
          acidity_description: 'Lifted acidity with long freshness.',
        },
        statistics: {
          ratings_average: 4.9,
          ratings_count: 620,
          labels_count: 15,
        },
        grapes: [{ name: 'Cabernet Sauvignon' }, { name: 'Merlot' }],
        food_pairings: ['lamb', 'duck'],
        region: {
          name: 'Bordeaux',
          country: { name: 'France', code: 'FR' },
        },
        taste: {
          structure: {
            acidity: 4,
            fizziness: 0,
            intensity: 3,
            sweetness: 1,
            tannin: 4,
          },
          flavor: [
            { group: 'black-fruit', stats: { count: 20 } },
            { group: 'floral', stats: { count: 9 } },
          ],
        },
        // SOTA++ fields for Margaux
        alcohol: '13.0%',
        winery_rating: 4.9,
        winery_wine_count: 4,
        winery_rating_count: 5000,
        winery_location: 'Margaux',
        badges: ['Top 1%'],
        varietal: 'Cabernet Sauvignon, Merlot, Petit Verdot',
        rating_count: 620,
        bottle_ml: 750,
        merchant_prices: [
          { price: 950, currency: 'USD', merchant: 'WineAccess' },
          { price: 980, currency: 'USD', merchant: 'VinoCellars' },
        ],
      },
    },
  ];
}

async function waitForIndexing(ms = 500): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-indexing-smoke-'));
  const silverPath = path.join(tempDir, 'silver.ndjson');
  const enrichedPath = path.join(tempDir, 'silver-enriched.ndjson');
  const vespa = new VespaClient(VESPA_URL, VESPA_NAMESPACE, VESPA_DOC_TYPE);
  const searchIndex = new VespaSearchIndex(vespa);
  const createdDocIds: string[] = [];

  try {
    console.log('Building synthetic Bronze fixture set …');
    const bronzeRows = makeBronzeFixtures();
    const transformed = bronzeRows
      .map(transformRow)
      .filter((record): record is NonNullable<typeof record> => record !== null);
    const silver = normalizePopularity(dedup(transformed));

    if (silver.length !== 2) {
      throw new Error(`Expected 2 deduped silver records, got ${silver.length}`);
    }

    await atomicWriteFile(
      silverPath,
      `${silver.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const silverContent = await fs.readFile(silverPath, 'utf8');
    const parsedSilver = parseNdjson<SilverWineRecord>(silverContent, silverPath).records;
    const enriched: EnrichedSilverRecord[] = parsedSilver.map((record) => ({
      ...record,
      aliases: generateAliases(record),
    }));

    await atomicWriteFile(
      enrichedPath,
      `${enriched.map((record) => JSON.stringify(record)).join('\n')}\n`,
    );

    const enrichedContent = await fs.readFile(enrichedPath, 'utf8');
    const parsedEnriched = parseNdjson<EnrichedSilverRecord>(
      enrichedContent,
      enrichedPath,
    ).records;
    const report = validateSilverRecords(parsedEnriched, SMOKE_GATES);
    if (!report.passed) {
      throw new Error(`Synthetic ingest quality gate failed: ${report.blockers.join('; ')}`);
    }

    const docs = parsedEnriched.map((record) => {
      const doc = silverToRetrievalDoc(
        record,
        deterministicEmbedding(record.body, record.sweetness, record.acidity, record.tannin),
      );
      createdDocIds.push(String(doc.entityId));
      return {
        id: String(doc.entityId),
        fields: toVespaFields(doc),
      };
    });

    console.log(`Feeding ${docs.length} synthetic ingest docs to Vespa …`);
    const result = await vespa.bulkFeed(docs);
    if (result.failureCount > 0) {
      throw new Error(`Vespa bulk feed failed: ${result.errors.join('; ')}`);
    }

    await waitForIndexing();

    const exactHits = await searchIndex.sparseSearch(['Opus One 2018'], [], 5);
    if (!exactHits.some((hit) => hit.entityId === docs[0]?.id)) {
      throw new Error('Synthetic Opus One document was not retrievable after indexing');
    }

    const accentFoldHits = await searchIndex.sparseSearch(['Chateau Margaux 2015'], [], 5);
    if (!accentFoldHits.some((hit) => hit.entityId === docs[1]?.id)) {
      throw new Error('Accent-folded Chateau Margaux query did not retrieve the indexed document');
    }

    console.log('Synthetic ingest indexing smoke passed');
  } finally {
    await Promise.allSettled(createdDocIds.map(async (docId) => vespa.delete(docId)));
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
