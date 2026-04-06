#!/usr/bin/env tsx
/**
 * Vespa Indexer: Reads enriched Silver NDJSON, generates embeddings,
 * and feeds RetrievalDocument records to Vespa.
 *
 * Handles:
 * - BGE-M3 instruction prefix (document side: no prefix)
 * - Batch embedding generation
 * - Deterministic entity_id → Vespa upsert (idempotent)
 * - Real embedding or deterministic fallback
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/etl/index-to-vespa.ts
 *   npx tsx --env-file=.env scripts/etl/index-to-vespa.ts --input data/silver-docquery.ndjson --dry-run
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import type { EnrichedSilverRecord } from './types.js';
import { parseNdjson } from './ndjson.js';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import { toVespaFields } from '../../src/infrastructure/vespa/mapping.js';
import { createEntityId } from '../../src/domain/shared/types/entity-id.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = 'data/silver-docquery.ndjson';
const VESPA_URL = process.env['VESPA_URL'] ?? 'http://localhost:8080';
const NAMESPACE = 'wine';
const DOC_TYPE = 'wine_entity';
const BATCH_SIZE = 50;

function embeddingServiceUrl(): string | undefined {
  const u = process.env['EMBEDDING_SERVICE_URL']?.trim();
  return u && u.length > 0 ? u : undefined;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

/**
 * OpenAI-compatible embeddings API — inlined so this script never imports
 * {@link ../../src/infrastructure/vespa/embedding-service.js} (which pulls full `config` / Zod).
 */
async function embedBatchHttp(
  texts: readonly string[],
): Promise<readonly (readonly number[])[]> {
  const base = embeddingServiceUrl();
  if (!base) {
    throw new Error('embedBatchHttp: no EMBEDDING_SERVICE_URL');
  }
  const model = process.env['EMBEDDING_MODEL'] ?? 'bge-m3';
  const response = await fetch(`${base.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [...texts] }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Embedding HTTP ${response.status}: ${text}`);
  }
  const data: unknown = await response.json();
  if (
    typeof data !== 'object' ||
    data === null ||
    !Array.isArray((data as { data?: unknown }).data)
  ) {
    throw new Error('Embedding: unexpected JSON shape');
  }
  const items = (data as { data: unknown[] }).data;
  const parsed: Array<{ index: number; embedding: readonly number[] }> = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o['index'] !== 'number' || !isNumberArray(o['embedding'])) continue;
    parsed.push({ index: o['index'], embedding: o['embedding'] });
  }
  parsed.sort((a, b) => a.index - b.index);
  return parsed.map((p) => p.embedding);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  dryRun: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { input: DEFAULT_INPUT, dryRun: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i] ?? '0'));
    else if (a === '--help' || a === '-h') {
      console.log('Usage: index-to-vespa.ts [--input PATH] [--dry-run] [--limit N]');
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic embedding fallback (same formula as seed-wines-real.ts)
// ---------------------------------------------------------------------------

export function deterministicEmbedding(
  body: number,
  sweetness: number,
  acidity: number,
  tannin: number,
): readonly number[] {
  const features = [
    body, sweetness, acidity, tannin,
    1 - body, 1 - sweetness, 1 - acidity, 1 - tannin,
  ];
  const embedding = new Array<number>(128).fill(0);
  for (let i = 0; i < 128; i++) {
    const f = features[i % features.length]!;
    const k = Math.floor(i / features.length);
    embedding[i] =
      f * Math.cos((k * Math.PI) / 8) + (1 - f) * Math.sin((k * Math.PI) / 8);
  }
  const norm = Math.sqrt(embedding.reduce((s, x) => s + x * x, 0));
  return embedding.map((x) => x / norm);
}

// ---------------------------------------------------------------------------
// Silver → RetrievalDocument
// ---------------------------------------------------------------------------

/**
 * Build the embedding text for a document.
 * BGE-M3 document side: NO instruction prefix (query side adds prefix at search time).
 */
export function buildEmbedText(rec: EnrichedSilverRecord): string {
  return [
    rec.canonicalLabel,
    rec.producer,
    rec.region,
    rec.grapePrimary,
    rec.searchTextEn,
  ]
    .filter(Boolean)
    .join('. ');
}

/** Regex matching any Hangul syllable or Jamo character. */
const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

/**
 * Build Korean search text from the canonical label + any Korean aliases
 * found in the alias bundle (added by generate-korean-aliases.ts).
 * Returns empty string when no Korean aliases exist for this record.
 */
export function buildSearchTextKo(rec: EnrichedSilverRecord): string {
  const koAliases = rec.aliases.noisyRecallProjection.filter((a) =>
    HANGUL_RE.test(a),
  );
  if (koAliases.length === 0) return '';
  return [rec.canonicalLabel, ...koAliases].join(' ');
}

// ---------------------------------------------------------------------------
// Track C gold record type (fields added in-place by run-track-c.ts)
// ---------------------------------------------------------------------------

interface CriticProxy {
  readonly proxyScore: number;
  readonly scoreTier: string;
  readonly confidence: string;
  readonly isSynthetic: boolean;
}

interface CertificationResult {
  readonly organic: boolean;
  readonly biodynamic: boolean;
  readonly vegan: boolean;
  readonly naturalWine: boolean;
  readonly certificationSource: string;
  readonly certificationConfidence: string;
}

interface DrinkingWindowResult {
  readonly drinkingWindowStart: number;
  readonly drinkingWindowEnd: number;
  readonly peakYear: number;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly modelVersion: string;
}

// Gold = EnrichedSilverRecord + all Track C fields + SOTA++ Silver fields
type GoldRecord = EnrichedSilverRecord & {
  // SOTA++ Silver fields
  readonly alcoholPct?: number | null;
  readonly producerPrestige?: number | null;
  readonly isTopRated?: boolean;
  // Track C Step 1
  readonly criticProxy?: CriticProxy | null;
  // Track C Step 2
  readonly certifications?: CertificationResult | null;
  // Track C Step 4
  readonly drinkingWindow?: DrinkingWindowResult | null;
};

/**
 * Converts certification flags to a flat string array for Vespa certifications[].
 * e.g. {organic:true, biodynamic:false, vegan:true} → ["organic", "vegan"]
 */
function buildCertificationTags(cert: CertificationResult): readonly string[] {
  const tags: string[] = [];
  if (cert.organic) tags.push('organic');
  if (cert.biodynamic) tags.push('biodynamic');
  if (cert.vegan) tags.push('vegan');
  if (cert.naturalWine) tags.push('natural');
  return tags;
}

/**
 * Derives a style label from body, sweetness, and wine type.
 * More granular than the old 3-bucket approach.
 */
function deriveStyle(rec: GoldRecord): string {
  const wt = rec.wineType ?? 'red';
  if (wt === 'sparkling') return 'sparkling';
  if (wt === 'dessert' || rec.sweetness >= 0.6) return 'sweet';
  if (wt === 'fortified') return 'fortified';
  if (wt === 'rosé') return 'rosé';
  if (wt === 'white') {
    if (rec.body >= 0.6) return 'full white';
    if (rec.body >= 0.35) return 'medium white';
    return 'crisp white';
  }
  // Red
  if (rec.body >= 0.7) return 'bold red';
  if (rec.body >= 0.4) return 'medium red';
  return 'light red';
}

/**
 * Computes final popularity score.
 * Boosts "Top 1%" wines by up to +0.10 (capped at 1.0).
 */
function computePopularity(rec: GoldRecord): number {
  const base = rec.popularityScore;
  const boost = rec.isTopRated === true ? 0.10 : 0;
  return Math.min(1, base + boost);
}

export function silverToRetrievalDoc(
  rec: EnrichedSilverRecord,
  embedding: readonly number[],
): RetrievalDocument {
  const gold = rec as GoldRecord;

  // criticScoreNormalized: Track C proxy (÷100) takes priority over raw Vivino rating (÷5)
  const criticScoreNormalized: number | undefined = (() => {
    if (gold.criticProxy?.proxyScore != null) {
      return Math.max(0, Math.min(1, gold.criticProxy.proxyScore / 100));
    }
    if (gold.ratingAvg != null) return gold.ratingAvg / 5;
    return undefined;
  })();

  const certTags: readonly string[] | undefined =
    gold.certifications != null ? buildCertificationTags(gold.certifications) : undefined;

  const doc: RetrievalDocument = {
    entityId: createEntityId(rec.sourceId),
    entityType: 'wine',
    canonicalLabel: rec.canonicalLabel,
    aliasesIdentitySafe: rec.aliases.identitySafeProjection,
    aliasesNoisyRecall: rec.aliases.noisyRecallProjection,
    producer: rec.producer,
    region: rec.region,
    grapes: rec.grapes,
    searchTextKo: buildSearchTextKo(rec),
    searchTextEn: rec.searchTextEn,
    semanticSummary: buildEmbedText(rec),
    body: rec.body,
    sweetness: rec.sweetness,
    style: deriveStyle(gold),
    priceBand: rec.priceBand,
    pairing: rec.pairingTags,
    occasion: [],
    availability: true,
    popularityScore: computePopularity(gold),
    embedding,
    // Core optional fields
    ...(rec.vintageYear !== null ? { vintageYear: rec.vintageYear } : {}),
    ...(rec.acidity > 0 ? { acidity: rec.acidity } : {}),
    ...(rec.tannin > 0 ? { tannin: rec.tannin } : {}),
    ...(rec.wineType ? { wineType: rec.wineType } : {}),
    ...(rec.grapePrimary ? { grapePrimary: rec.grapePrimary } : {}),
    ...(rec.country ? { country: rec.country } : {}),
    ...(rec.priceUsd !== null ? { priceUsd: rec.priceUsd } : {}),
    ...(rec.flavorProfiles.length > 0 ? { flavorProfiles: rec.flavorProfiles } : {}),
    ...(criticScoreNormalized !== undefined ? { criticScoreNormalized } : {}),
    ...(rec.learnedSparseWeights !== undefined
      ? { learnedSparseWeights: rec.learnedSparseWeights }
      : {}),
    // SOTA++ Silver fields
    ...(gold.alcoholPct != null ? { alcoholPct: gold.alcoholPct } : {}),
    ...(gold.producerPrestige != null ? { producerPrestige: gold.producerPrestige } : {}),
    // Track C Step 2 — certifications
    ...(certTags !== undefined && certTags.length > 0 ? { certifications: [...certTags] } : {}),
    // Track C Step 4 — drinking window
    ...(gold.drinkingWindow != null
      ? {
          drinkingWindowStart: gold.drinkingWindow.drinkingWindowStart,
          drinkingWindowEnd: gold.drinkingWindow.drinkingWindowEnd,
          drinkingWindowModelVersion: gold.drinkingWindow.modelVersion,
        }
      : {}),
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Batch indexing
// ---------------------------------------------------------------------------

function chunkArray<T>(arr: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size) as T[]);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading enriched Silver from ${args.input} …`);
  const content = await fs.readFile(args.input, 'utf8');
  let records = parseNdjson<EnrichedSilverRecord>(content, args.input).records;

  if (args.limit > 0) {
    records = records.slice(0, args.limit);
  }
  console.log(`  Records to index: ${records.length}`);

  if (args.dryRun) {
    console.log('  DRY RUN — skipping Vespa feed and embeddings');
    const sample = records[0];
    if (sample) {
      const emb = deterministicEmbedding(sample.body, sample.sweetness, sample.acidity, sample.tannin);
      const doc = silverToRetrievalDoc(sample, emb);
      console.log('  Sample RetrievalDocument:');
      console.log(JSON.stringify(doc, null, 2).slice(0, 2000));
    }
    return;
  }

  // Vespa client
  const vespa = new VespaClient(VESPA_URL, NAMESPACE, DOC_TYPE);

  const embedUrl = embeddingServiceUrl();
  if (embedUrl) {
    console.log('  Will try HTTP embeddings at EMBEDDING_SERVICE_URL; on failure → deterministic');
  } else {
    console.log('  Using deterministic fallback embeddings (EMBEDDING_SERVICE_URL unset)');
  }

  const chunks = chunkArray(records, BATCH_SIZE);
  let indexed = 0;
  let failures = 0;
  let httpEmbedFailed = false;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;

    // Generate embeddings
    let embeddings: readonly (readonly number[])[];
    if (embedUrl && !httpEmbedFailed) {
      try {
        const texts = chunk.map(buildEmbedText);
        embeddings = await embedBatchHttp(texts);
      } catch (e) {
        httpEmbedFailed = true;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`  Embedding HTTP failed (${msg}) — switching to deterministic for remaining batches`);
        embeddings = chunk.map((r) =>
          deterministicEmbedding(r.body, r.sweetness, r.acidity, r.tannin),
        );
      }
    } else {
      embeddings = chunk.map((r) =>
        deterministicEmbedding(r.body, r.sweetness, r.acidity, r.tannin),
      );
    }

    // Convert to Vespa documents and feed
    const docs = chunk.map((rec, i) => {
      const embedding = embeddings[i] ?? deterministicEmbedding(rec.body, rec.sweetness, rec.acidity, rec.tannin);
      const retrievalDoc = silverToRetrievalDoc(rec, embedding);
      return {
        // Document v1 path: /document/v1/{namespace}/{type}/docid/{userKey} — user key only (see vespa-search-index.bulkUpsert).
        id: String(retrievalDoc.entityId),
        fields: toVespaFields(retrievalDoc),
      };
    });

    const result = await vespa.bulkFeed(docs);
    indexed += result.successCount;
    failures += result.failureCount;

    if (result.failureCount > 0) {
      console.error(`  Batch ${ci + 1}: ${result.failureCount} failures`);
      for (const err of result.errors.slice(0, 3)) {
        console.error(`    ${err}`);
      }
    }

    if ((ci + 1) % 10 === 0 || ci === chunks.length - 1) {
      console.log(
        `  Progress: ${ci + 1}/${chunks.length} batches  (${indexed} indexed, ${failures} failed)`,
      );
    }
  }

  console.log(`\n  Done: ${indexed} indexed, ${failures} failed`);
  if (failures > 0) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
