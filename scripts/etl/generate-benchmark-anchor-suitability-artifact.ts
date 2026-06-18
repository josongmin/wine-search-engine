#!/usr/bin/env tsx

import fs from 'node:fs/promises';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { WINES } from '../seed-wines-real.js';
import type { SourceRecordId } from '../../src/domain/shared/types/entity-id.js';
import { atomicWriteFile } from './etl-utils.js';
import type { EnrichedSilverRecord, PriceBand, WineType } from './types.js';
import {
  AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS,
  DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH,
  REPO_BENCHMARK_ANCHOR_SUITABILITY_PATH,
  _resetBenchmarkAnchorSuitabilityArtifactCache,
  assertAuthoritativeBenchmarkAnchorSuitabilityArtifact,
  loadBenchmarkAnchorSuitabilityArtifact,
  resolveBenchmarkAnchorSuitabilitySourceDataset,
  type BenchmarkAnchorSuitabilityArtifact,
  type BenchmarkAnchorSuitabilityEntry,
  type BenchmarkAnchorSuitabilitySourceDataset,
} from './build-search-snapshot.js';

const GOLD_CATALOG_PATH = path.resolve(process.cwd(), 'data', 'gold-wine-catalog.jsonl');
const SCORE_SCALE = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const SCORER_CONCURRENCY = 4;

const RepoGoldCatalogRowSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  producer: z.string().min(1),
  country: z.string().min(1),
  region: z.string().min(1),
  appellation: z.string().min(1).optional(),
  grapes: z.array(z.string().min(1)).min(1),
  wineType: z.enum(['red', 'white', 'sparkling', 'dessert', 'rosé', 'fortified']),
  vintageYear: z.number().int().min(0).max(2035),
  priceUsd: z.number().finite().positive(),
  body: z.number().int().min(1).max(5).nullable(),
  tannin: z.number().int().min(1).max(5).nullable(),
  acidity: z.number().int().min(1).max(5).nullable(),
  criticScore: z.number().int().min(0).max(100),
  style: z.string().min(1),
  koreanAliases: z.array(z.string().min(1)),
}).strict();

const ScoreResponseSchema = z.object({
  score: z.union([z.number().finite(), z.string().min(1)]),
  evidence_axes: z.array(z.string().min(1)).optional(),
  snippet: z.string().min(1),
  rationale: z.string().min(1),
}).strict();

type RepoGoldCatalogRow = z.infer<typeof RepoGoldCatalogRowSchema>;
type SeedWine = (typeof WINES)[number];

interface Args {
  readonly generatedAt?: string | undefined;
}

interface GiftPromptModule {
  readonly GIFT_SUITABILITY_MODEL: string;
  readonly GIFT_SUITABILITY_PROMPT_VERSION: string;
  readonly GIFT_SUITABILITY_SYSTEM_PROMPT: string;
  readonly buildGiftSuitabilityUserPrompt: (record: EnrichedSilverRecord) => string;
}

interface BeginnerPromptModule {
  readonly BEGINNER_SUITABILITY_MODEL: string;
  readonly BEGINNER_SUITABILITY_PROMPT_VERSION: string;
  readonly BEGINNER_SUITABILITY_SYSTEM_PROMPT: string;
  readonly buildBeginnerSuitabilityUserPrompt: (record: EnrichedSilverRecord) => string;
}

function parseArgs(argv: readonly string[]): Args {
  let generatedAt: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--generated-at') {
      generatedAt = argv[i + 1];
      i += 1;
    }
  }
  return { generatedAt };
}

function loadLocalEnvFiles(): void {
  loadDotenv({ path: path.resolve(process.cwd(), '.env.local'), override: false });
  loadDotenv({ path: path.resolve(process.cwd(), '.env'), override: false });
}

function resolveOpenAiBaseUrl(): string {
  return (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
}

async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, init);
    if (response.ok) {
      return response;
    }
    const retryable = response.status === 429 || response.status === 502 || response.status === 503;
    if (!retryable || attempt === MAX_RETRIES) {
      const body = await response.text().catch(() => '');
      throw new Error(`${label} HTTP ${response.status}: ${body.slice(0, 400)}`);
    }
    const delayMs = RETRY_BASE_DELAY_MS * (2 ** attempt);
    console.log(`retry ${attempt + 1}/${MAX_RETRIES} after ${delayMs}ms for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, delayMs); });
  }
  throw new Error(`fetchWithRetry exhausted for ${label}`);
}

function normalizeSensoryNullable(value: number | null): number | null {
  return value === null ? null : Number((value / 5).toFixed(3));
}

function buildRepoGoldBenchmarkAnchorSearchTextEn(entry: RepoGoldCatalogRow): string {
  return [
    entry.canonicalLabel,
    entry.producer,
    entry.country,
    entry.region,
    ...(entry.appellation !== undefined ? [entry.appellation] : []),
    ...entry.grapes,
    entry.style,
  ].join(' ');
}

function toRequiredWineType(value: string, entityId: string): WineType {
  switch (value) {
    case 'red':
    case 'white':
    case 'rosé':
    case 'sparkling':
    case 'dessert':
    case 'fortified':
      return value;
    default:
      throw new Error(`Unsupported wine type "${value}" for ${entityId}`);
  }
}

function toOptionalPriceBand(value: string | undefined): PriceBand | undefined {
  switch (value) {
    case 'value':
    case 'mid':
    case 'premium':
    case 'luxury':
      return value;
    default:
      return undefined;
  }
}

function buildEmptyAliases(): EnrichedSilverRecord['aliases'] {
  return {
    proposed: [],
    identitySafeProjection: [],
    noisyRecallProjection: [],
  };
}

function buildSeedBenchmarkAnchorRecord(doc: SeedWine): EnrichedSilverRecord {
  return {
    sourceId: `benchmark-suitability-${doc.entityId}` as SourceRecordId,
    externalId: doc.entityId,
    canonicalLabel: doc.canonicalLabel,
    producer: doc.producer ?? doc.canonicalLabel,
    vintageYear: doc.vintageYear ?? null,
    country: doc.country ?? '',
    region: doc.region ?? '',
    appellation: doc.appellation ?? null,
    wineType: toRequiredWineType(doc.wineType ?? '', doc.entityId),
    grapePrimary: doc.grapePrimary ?? null,
    grapes: doc.grapes ?? [],
    body: doc.body ?? null,
    sweetness: doc.sweetness ?? null,
    acidity: doc.acidity ?? null,
    tannin: doc.tannin ?? null,
    pairingTags: doc.pairing ?? [],
    ...(doc.occasion !== undefined ? { occasion: doc.occasion } : {}),
    flavorProfiles: doc.flavorProfiles ?? [],
    searchTextEn: doc.searchTextEn ?? doc.semanticSummary ?? doc.canonicalLabel,
    ratingAvg: null,
    ratingsCount: 0,
    priceUsd: doc.priceUsd ?? null,
    ...(toOptionalPriceBand(doc.priceBand) !== undefined
      ? { priceBand: toOptionalPriceBand(doc.priceBand) }
      : {}),
    popularityScore: doc.popularityScore ?? 0,
    scrapedAt: null,
    alcoholPct: doc.alcoholPct ?? null,
    ...(doc.bottleSizeMl !== undefined ? { bottleSizeMl: doc.bottleSizeMl } : {}),
    ...(doc.bottleSize !== undefined ? { bottleSize: doc.bottleSize } : {}),
    ...(doc.closure !== undefined ? { closure: doc.closure } : {}),
    producerPrestige: doc.producerPrestige ?? null,
    isTopRated: false,
    ...(doc.grapeFamily !== undefined ? { grapeFamily: doc.grapeFamily } : {}),
    ...(doc.regionHierarchy !== undefined ? { regionHierarchy: doc.regionHierarchy } : {}),
    ...(doc.finishLength !== undefined ? { finishLength: doc.finishLength } : {}),
    ...(doc.classification !== undefined ? { classification: doc.classification } : {}),
    ...(doc.oakTreatment !== undefined ? { oakTreatment: doc.oakTreatment } : {}),
    ...(doc.soilType !== undefined ? { soilType: doc.soilType } : {}),
    ...(doc.producerType !== undefined ? { producerType: doc.producerType } : {}),
    aliases: buildEmptyAliases(),
  };
}

function buildRepoGoldBenchmarkAnchorRecord(entry: RepoGoldCatalogRow): EnrichedSilverRecord {
  return {
    sourceId: `benchmark-suitability-${entry.entityId}` as SourceRecordId,
    externalId: entry.entityId,
    canonicalLabel: entry.canonicalLabel,
    producer: entry.producer,
    vintageYear: entry.vintageYear > 0 ? entry.vintageYear : null,
    country: entry.country,
    region: entry.region,
    appellation: entry.appellation ?? null,
    wineType: entry.wineType,
    grapePrimary: entry.grapes[0] ?? null,
    grapes: entry.grapes,
    body: normalizeSensoryNullable(entry.body),
    sweetness: null,
    acidity: normalizeSensoryNullable(entry.acidity),
    tannin: normalizeSensoryNullable(entry.tannin),
    pairingTags: [],
    flavorProfiles: [],
    searchTextEn: buildRepoGoldBenchmarkAnchorSearchTextEn(entry),
    ratingAvg: null,
    ratingsCount: 0,
    priceUsd: entry.priceUsd,
    popularityScore: 0,
    scrapedAt: null,
    alcoholPct: null,
    producerPrestige: null,
    isTopRated: false,
    aliases: buildEmptyAliases(),
  };
}

async function loadRepoGoldCatalogRows(): Promise<ReadonlyMap<string, RepoGoldCatalogRow>> {
  const raw = await fs.readFile(GOLD_CATALOG_PATH, 'utf8');
  const rows = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const parsed = RepoGoldCatalogRowSchema.safeParse(JSON.parse(line) as unknown);
      if (!parsed.success) {
        throw new Error(
          `Repo gold catalog schema validation failed at ${GOLD_CATALOG_PATH}:${index + 1}: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    });
  return new Map(rows.map((row) => [row.entityId, row] as const));
}

async function buildAuthoritativeBenchmarkAnchorInputs(): Promise<readonly {
  readonly entityId: string;
  readonly sourceDataset: BenchmarkAnchorSuitabilitySourceDataset;
  readonly record: EnrichedSilverRecord;
}[]> {
  const seedById = new Map(WINES.map((wine) => [wine.entityId, wine] as const));
  const repoGoldById = await loadRepoGoldCatalogRows();
  const inputs: {
    readonly entityId: string;
    readonly sourceDataset: BenchmarkAnchorSuitabilitySourceDataset;
    readonly record: EnrichedSilverRecord;
  }[] = [];

  for (const entityId of AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS) {
    const sourceDataset = resolveBenchmarkAnchorSuitabilitySourceDataset(entityId);
    if (sourceDataset === 'seed_wines_real') {
      const doc = seedById.get(entityId as SeedWine['entityId']);
      if (doc === undefined) {
        throw new Error(`Missing seed benchmark anchor document for "${entityId}"`);
      }
      inputs.push({
        entityId,
        sourceDataset,
        record: buildSeedBenchmarkAnchorRecord(doc),
      });
      continue;
    }
    const row = repoGoldById.get(entityId);
    if (row === undefined) {
      throw new Error(`Missing repo gold benchmark anchor row for "${entityId}"`);
    }
    inputs.push({
      entityId,
      sourceDataset,
      record: buildRepoGoldBenchmarkAnchorRecord(row),
    });
  }

  return inputs;
}

async function scoreSuitability(args: {
  readonly apiKey: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly label: string;
}): Promise<BenchmarkAnchorSuitabilityEntry['gift']> {
  const response = await fetchWithRetry(`${resolveOpenAiBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userPrompt },
      ],
    }),
  }, args.label);

  const payload = await response.json() as {
    choices?: readonly {
      message?: {
        content?: string | null;
      };
    }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error(`${args.label} returned empty content`);
  }

  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(content);
  } catch (error) {
    throw new Error(`${args.label} returned non-JSON content: ${(error as Error).message}`);
  }

  const parsed = ScoreResponseSchema.safeParse(parsedUnknown);
  if (!parsed.success) {
    throw new Error(`${args.label} returned invalid JSON shape: ${parsed.error.message}`);
  }

  const rawScore = typeof parsed.data.score === 'string'
    ? Number.parseFloat(parsed.data.score)
    : parsed.data.score;
  if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > SCORE_SCALE) {
    throw new Error(`${args.label} returned out-of-range score "${String(parsed.data.score)}"`);
  }

  return {
    score: rawScore / SCORE_SCALE,
    evidenceAxes: parsed.data.evidence_axes?.map((value) => value.trim()) ?? [],
    snippet: parsed.data.snippet.trim(),
    rationale: parsed.data.rationale.trim(),
    generationSource: 'llm_teacher_generated',
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<readonly TOutput[]> {
  const output = new Array<TOutput>(items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) {
          return;
        }
        output[index] = await worker(items[index]!, index);
      }
    }),
  );

  return output;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadLocalEnvFiles();

  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to generate benchmark anchor suitability artifact');
  }

  const giftModule = await import('./run-track-c-step6-gift-suitability.js') as GiftPromptModule;
  const beginnerModule = await import('./run-track-c-step7-beginner-suitability.js') as BeginnerPromptModule;
  const inputs = await buildAuthoritativeBenchmarkAnchorInputs();

  console.log(`Generating benchmark anchor suitability artifact for ${inputs.length} entities`);

  const entries = await mapWithConcurrency(inputs, SCORER_CONCURRENCY, async (input, index) => {
    console.log(`[${index + 1}/${inputs.length}] ${input.entityId}`);
    const [gift, beginner] = await Promise.all([
      scoreSuitability({
        apiKey,
        model: giftModule.GIFT_SUITABILITY_MODEL,
        systemPrompt: giftModule.GIFT_SUITABILITY_SYSTEM_PROMPT,
        userPrompt: giftModule.buildGiftSuitabilityUserPrompt(input.record),
        label: `gift:${input.entityId}`,
      }),
      scoreSuitability({
        apiKey,
        model: beginnerModule.BEGINNER_SUITABILITY_MODEL,
        systemPrompt: beginnerModule.BEGINNER_SUITABILITY_SYSTEM_PROMPT,
        userPrompt: beginnerModule.buildBeginnerSuitabilityUserPrompt(input.record),
        label: `beginner:${input.entityId}`,
      }),
    ]);

    return [
      input.entityId,
      {
        sourceDataset: input.sourceDataset,
        gift,
        beginner,
      } satisfies BenchmarkAnchorSuitabilityEntry,
    ] as const;
  });

  const artifact: BenchmarkAnchorSuitabilityArtifact = {
    version: 'v1',
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    models: {
      gift: giftModule.GIFT_SUITABILITY_MODEL,
      beginner: beginnerModule.BEGINNER_SUITABILITY_MODEL,
    },
    promptVersions: {
      gift: giftModule.GIFT_SUITABILITY_PROMPT_VERSION,
      beginner: beginnerModule.BEGINNER_SUITABILITY_PROMPT_VERSION,
    },
    requiredEntityIds: [...AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS],
    entities: Object.fromEntries(entries),
  };
  assertAuthoritativeBenchmarkAnchorSuitabilityArtifact(artifact);

  const targetPaths = [...new Set([
    path.resolve(REPO_BENCHMARK_ANCHOR_SUITABILITY_PATH),
    path.resolve(DEFAULT_BENCHMARK_ANCHOR_SUITABILITY_PATH),
  ])];
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;

  for (const targetPath of targetPaths) {
    await atomicWriteFile(targetPath, serialized);
  }

  _resetBenchmarkAnchorSuitabilityArtifactCache();
  for (const targetPath of targetPaths) {
    await loadBenchmarkAnchorSuitabilityArtifact(targetPath);
  }

  console.log(`artifact_paths=${targetPaths.join(',')}`);
  console.log(`entities=${AUTHORITATIVE_BENCHMARK_ANCHOR_ENTITY_IDS.length}`);
  console.log(`gift_model=${giftModule.GIFT_SUITABILITY_MODEL}`);
  console.log(`beginner_model=${beginnerModule.BEGINNER_SUITABILITY_MODEL}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
