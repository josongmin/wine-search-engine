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
import type { EnrichedSilverRecord, IndexableWineRecord } from './types.js';
import { SOURCE_SYSTEM_VIVINO_SILVER } from '../../src/shared/constants/source-systems.js';
import { parseNdjson } from './ndjson.js';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import { toVespaFields } from '../../src/infrastructure/vespa/mapping.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/entity-id.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import {
  loadGoldCanonicalLookupForBuild,
  resolveWineSnapshotEntity,
} from './snapshot-entity-identity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = resolveDataPath('data/silver-docquery.ndjson');
const VESPA_URL = process.env['VESPA_URL'] ?? 'http://localhost:8080';
const NAMESPACE = 'wine';
const DOC_TYPE = 'wine_entity';
/** Vespa Cloud dev zone has limited concurrent capacity; keep batches small
 *  to avoid connection-pool exhaustion (was 50, reduced after repeated
 *  network errors on batches 57-68). */
const BATCH_SIZE = 10;

function openAiBaseUrl(): string {
  return (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
}

function openAiApiKey(): string | undefined {
  const k = process.env['OPENAI_API_KEY']?.trim();
  return k && k.length > 0 ? k : undefined;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

/**
 * OpenAI embeddings API — inlined so this script never imports
 * src/ modules (which pull full `config` / Zod).
 */
async function embedBatchHttp(
  texts: readonly string[],
): Promise<readonly (readonly number[])[]> {
  const apiKey = openAiApiKey();
  if (!apiKey) {
    throw new Error('embedBatchHttp: OPENAI_API_KEY is required');
  }
  const model = process.env['OPENAI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small';
  const response = await fetch(`${openAiBaseUrl()}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
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
  const result = parsed.map((p) => p.embedding);

  // Validate embedding dimensions match schema
  for (let i = 0; i < result.length; i++) {
    if (result[i]!.length !== EMBEDDING_DIM) {
      throw new Error(
        `Embedding dimension mismatch at index ${i}: expected ${EMBEDDING_DIM}, got ${result[i]!.length}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  dryRun: boolean;
  limit: number;
  snapshotId?: string;
  fixtureRepoRoot?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { input: DEFAULT_INPUT, dryRun: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i] ?? '0'));
    else if (a === '--snapshot-id') {
      const v = argv[++i];
      if (v !== undefined) out.snapshotId = v;
    } else if (a === '--fixture-repo') {
      const v = argv[++i];
      if (v !== undefined) out.fixtureRepoRoot = v;
    }
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: index-to-vespa.ts [--input PATH] [--dry-run] [--limit N] [--snapshot-id ID] [--fixture-repo PATH]',
      );
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic embedding fallback (same formula as seed-wines-real.ts)
// ---------------------------------------------------------------------------

/** Embedding dimension — must match Vespa schema tensor<float>(x[DIM]). */
const EMBEDDING_DIM = 1024;

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
  const embedding = new Array<number>(EMBEDDING_DIM).fill(0);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
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

/** Regex matching any Hangul syllable or Jamo character.
 *  v4: standardized to U+AC00..U+D7A3 (matches scorer.ts, step-budget.ts, phonetic.ts).
 *  Previously U+AC00..U+D7AF, which included 12 unassigned code points (U+D7A4..U+D7AF)
 *  that are not part of the Hangul Syllables block. The standard end is U+D7A3 (힣). */
const HANGUL_RE = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;

/**
 * Build Korean search text from the canonical label + any Korean aliases
 * found in the alias bundle (added by generate-korean-aliases.ts).
 * Returns empty string when no Korean aliases exist for this record.
 */
export function buildSearchTextKo(rec: EnrichedSilverRecord): string {
  // Prefer pre-built Korean text from Phase-1 enrichment (stored in the NDJSON)
  const prebuilt = (rec as unknown as Record<string, unknown>)['searchTextKo'];
  if (typeof prebuilt === 'string' && prebuilt.length > 0) return prebuilt;

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
  // Classification tier — may be extracted by Silver rule-based or LLM enrichment step
  readonly classification?: string | null;
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
  const wt = rec.wineType;
  if (wt === undefined) {
    throw new Error(`deriveStyle: missing wineType for record — cannot derive style without wine type classification`);
  }
  if (wt === 'sparkling') return 'sparkling';
  if (wt === 'dessert') return 'sweet';
  if (wt === 'fortified') return 'fortified';
  if (wt === 'rosé') return 'rosé';
  // Only override to 'sweet' for clearly sweet wines (threshold raised from 0.6 to 0.75)
  if (rec.sweetness >= 0.75) return 'sweet';
  if (wt === 'white') {
    if (rec.body >= 0.6) return 'full white';
    if (rec.body >= 0.35) return 'medium white';
    return 'crisp white';
  }
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

/**
 * Validation result for an {@link IndexableWineRecord}.
 */
export interface IndexableValidationResult {
  readonly valid: boolean;
  readonly errors: string[];
}

/** Grape family lookup — mirrors GRAPE_FAMILY_MAP in enrich-rules.py. */
const GRAPE_FAMILY_MAP: ReadonlyMap<string, string> = new Map([
  ['Pinot Noir', 'Pinot'], ['Pinot Gris', 'Pinot'], ['Pinot Grigio', 'Pinot'],
  ['Pinot Blanc', 'Pinot'], ['Pinot Meunier', 'Pinot'],
  ['Cabernet Sauvignon', 'Cabernet'], ['Cabernet Franc', 'Cabernet'],
  ['Sauvignon Blanc', 'Sauvignon Blanc'],
  ['Chenin Blanc', 'Chenin Blanc'],
  ['Nero d\'Avola', 'Nero d\'Avola'],
  ['Grüner Veltliner', 'Grüner Veltliner'],
  ['Touriga Nacional', 'Touriga'],
  ['Nerello Mascalese', 'Nerello'],
  ['Petite Sirah', 'Petite Sirah'],
  ['Petit Verdot', 'Petit Verdot'],
  ['Syrah', 'Syrah'], ['Shiraz', 'Syrah'],
  ['Grenache', 'Grenache'], ['Garnacha', 'Grenache'],
  ['Zinfandel', 'Zinfandel'], ['Primitivo', 'Zinfandel'],
  ['Mourvèdre', 'Mourvèdre'],
  ['Muscat', 'Muscat'], ['Moscato', 'Muscat'],
  ['Sémillon', 'Sémillon'],
  ['Blaufränkisch', 'Blaufränkisch'],
]);

/**
 * Derives a grape family shortname from a primary grape variety.
 * Uses {@link GRAPE_FAMILY_MAP} for known multi-word varieties, then
 * falls back to first-word extraction for unknown grapes.
 */
function deriveGrapeFamily(grapePrimary: string | null | undefined): string | undefined {
  if (!grapePrimary) return undefined;
  const mapped = GRAPE_FAMILY_MAP.get(grapePrimary);
  if (mapped) return mapped;
  return grapePrimary.split(/[\s/,]/)[0] ?? undefined;
}

/**
 * Parses a region string into a breadcrumb hierarchy.
 * Handles " / "-separated strings, deduplicates, and trims.
 */
function deriveRegionHierarchy(region: string | null | undefined): readonly string[] | undefined {
  if (!region) return undefined;
  const parts = region
    .split(' / ')
    .map((s) => s.trim())
    .filter(Boolean);
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const part of parts) {
    if (!seen.has(part)) {
      seen.add(part);
      unique.push(part);
    }
  }
  return unique.length > 0 ? unique : undefined;
}

/** Maps price band label to ordinal: value=1, mid=2, premium=3, luxury=4. */
function priceBandToNumeric(band: string): number {
  switch (band) {
    case 'value': return 1;
    case 'mid': return 2;
    case 'premium': return 3;
    case 'luxury': return 4;
    default: throw new Error(`priceBandToNumeric: unrecognized price band "${band}"`);
  }
}

/**
 * Maps an {@link EnrichedSilverRecord} to an {@link IndexableWineRecord}.
 *
 * This is the explicit, auditable mapping layer between the Silver tier and
 * the Vespa feed. All field assignments are deliberate — no implicit field
 * grabbing.
 */
// Projection family: hit + feature + payload (see docs/migration/projection-reindex-strategy.md)
export function silverToIndexable(
  rec: EnrichedSilverRecord,
  goldCanonicalLookup: ReadonlyMap<string, string> = new Map(),
): IndexableWineRecord {
  const gold = rec as GoldRecord;
  const resolvedEntity = resolveWineSnapshotEntity(rec, goldCanonicalLookup);

  // criticScoreNormalized: Track C proxy (÷100) takes priority over raw Vivino rating (÷5)
  const criticScoreNormalized: number | undefined = (() => {
    if (gold.criticProxy?.proxyScore != null) {
      return Math.max(0, Math.min(1, gold.criticProxy.proxyScore / 100));
    }
    if (gold.ratingAvg != null) return Math.max(0, Math.min(1, gold.ratingAvg / 5));
    return undefined;
  })();

  const certTags: readonly string[] | undefined =
    gold.certifications != null ? buildCertificationTags(gold.certifications) : undefined;

  return {
    // RetrievalHitProjection fields
    entityId: resolvedEntity.entityId,
    sourceRecordRefs: [
      { sourceSystem: SOURCE_SYSTEM_VIVINO_SILVER, sourceRecordId: rec.sourceId },
    ],
    canonicalLabel: rec.canonicalLabel,
    producer: rec.producer || undefined,
    region: rec.region || undefined,
    ...(rec.appellation ? { appellation: rec.appellation } : {}),
    ...(rec.grapePrimary ? { grapePrimary: rec.grapePrimary } : {}),
    ...(rec.vintageYear !== null ? { vintageYear: rec.vintageYear } : {}),
    searchTextEn: rec.searchTextEn || undefined,
    ...(gold.producerPrestige != null ? { producerPrestige: gold.producerPrestige } : {}),
    // avgCriticProxyScore mirrors criticScoreNormalized for the hit-projection summary.
    ...(criticScoreNormalized !== undefined ? { avgCriticProxyScore: criticScoreNormalized } : {}),

    // RetrievalFeatureProjection fields
    body: rec.body,
    sweetness: rec.sweetness,
    ...(rec.acidity != null ? { acidity: rec.acidity } : {}),
    ...(rec.tannin != null ? { tannin: rec.tannin } : {}),
    ...(criticScoreNormalized !== undefined ? { criticScoreNormalized } : {}),
    ...(gold.drinkingWindow != null
      ? {
          drinkingWindowStart: gold.drinkingWindow.drinkingWindowStart,
          drinkingWindowEnd: gold.drinkingWindow.drinkingWindowEnd,
          drinkingWindowModelVersion: gold.drinkingWindow.modelVersion,
        }
      : {}),

    // Payload fields
    entityType: 'wine',
    aliasesIdentitySafe: rec.aliases.identitySafeProjection,
    aliasesNoisyRecall: rec.aliases.noisyRecallProjection,
    grapes: rec.grapes,
    searchTextKo: buildSearchTextKo(rec),
    semanticSummary: buildEmbedText(rec),
    style: deriveStyle(gold),
    priceBand: rec.priceBand,
    pairing: rec.pairingTags,
    occasion: [],
    availability: true,
    popularityScore: computePopularity(gold),
    ...(rec.wineType ? { wineType: rec.wineType } : {}),
    ...(rec.country ? { country: rec.country } : {}),
    ...(rec.priceUsd !== null ? { priceUsd: rec.priceUsd } : {}),
    grapeFamily: deriveGrapeFamily(rec.grapePrimary),
    regionHierarchy: deriveRegionHierarchy(rec.region),
    priceBandNumeric: priceBandToNumeric(rec.priceBand),
    ...(rec.finishLength != null ? { finishLength: rec.finishLength } : {}),
    ...(rec.flavorProfiles.length > 0 ? { flavorProfiles: rec.flavorProfiles } : {}),
    ...(gold.alcoholPct != null ? { alcoholPct: gold.alcoholPct } : {}),
    // Classification and oak from Silver (rule-based extraction or LLM enrichment)
    // GoldRecord overrides take priority; Silver values are the fallback.
    ...(gold.classification != null
      ? { classification: gold.classification }
      : rec.classification != null
        ? { classification: rec.classification }
        : {}),
    ...(rec.oakTreatment != null ? { oakTreatment: rec.oakTreatment } : {}),
    ...(certTags !== undefined && certTags.length > 0 ? { certifications: [...certTags] } : {}),
    ...(rec.learnedSparseWeights !== undefined
      ? { learnedSparseWeights: rec.learnedSparseWeights }
      : {}),
    ...(rec.syntheticQueries !== undefined && rec.syntheticQueries.length > 0
      ? { syntheticQueries: rec.syntheticQueries }
      : {}),
  };
}

/**
 * Validates an {@link IndexableWineRecord} against required field contracts
 * and expected numeric ranges for feature projection fields.
 *
 * Required: entityId (non-empty), canonicalLabel (non-empty).
 * Feature ranges: body, tannin, acidity, sweetness are all stored as [0, 1]
 * (normalized from the Vivino 1–5 scale during Silver transformation).
 * Out-of-range means strictly outside [0, 1].
 */
// Validates hit projection required fields + feature projection numeric ranges
export function validateIndexableRecord(rec: IndexableWineRecord): IndexableValidationResult {
  const errors: string[] = [];

  // Required fields
  if (!rec.entityId || rec.entityId.trim().length === 0) {
    errors.push('entityId is required and must be non-empty');
  }
  if (!rec.canonicalLabel || rec.canonicalLabel.trim().length === 0) {
    errors.push('canonicalLabel is required and must be non-empty');
  }

  // Feature range validation (Silver [0, 1] normalised values)
  const featureFields: ReadonlyArray<{ key: keyof IndexableWineRecord; label: string }> = [
    { key: 'body', label: 'body' },
    { key: 'tannin', label: 'tannin' },
    { key: 'acidity', label: 'acidity' },
    { key: 'sweetness', label: 'sweetness' },
  ];

  for (const { key, label } of featureFields) {
    const val = rec[key];
    if (val !== undefined && typeof val === 'number') {
      if (val < 0 || val > 1) {
        errors.push(`${label} must be in [0, 1], got ${val}`);
      }
    }
  }

  // Critic / prestige score ranges
  if (rec.criticScoreNormalized !== undefined) {
    if (rec.criticScoreNormalized < 0 || rec.criticScoreNormalized > 1) {
      errors.push(`criticScoreNormalized must be in [0, 1], got ${rec.criticScoreNormalized}`);
    }
  }
  if (rec.producerPrestige !== undefined) {
    if (rec.producerPrestige < 0 || rec.producerPrestige > 1) {
      errors.push(`producerPrestige must be in [0, 1], got ${rec.producerPrestige}`);
    }
  }
  if (rec.popularityScore < 0 || rec.popularityScore > 1) {
    errors.push(`popularityScore must be in [0, 1], got ${rec.popularityScore}`);
  }

  // alcoholPct range (0, 25] — must match parseAlcohol in vivino-to-silver.ts
  if (rec.alcoholPct !== undefined) {
    if (rec.alcoholPct <= 0 || rec.alcoholPct > 25) {
      errors.push(`alcoholPct must be in (0, 25], got ${rec.alcoholPct}`);
    }
  }

  // avgCriticProxyScore range [0, 1]
  if (rec.avgCriticProxyScore !== undefined) {
    if (rec.avgCriticProxyScore < 0 || rec.avgCriticProxyScore > 1) {
      errors.push(`avgCriticProxyScore must be in [0, 1], got ${rec.avgCriticProxyScore}`);
    }
  }

  // drinkingWindow start must not exceed end
  if (rec.drinkingWindowStart !== undefined && rec.drinkingWindowEnd !== undefined) {
    if (rec.drinkingWindowStart > rec.drinkingWindowEnd) {
      errors.push(
        `drinkingWindowStart (${rec.drinkingWindowStart}) must be <= drinkingWindowEnd (${rec.drinkingWindowEnd})`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export function silverToRetrievalDoc(
  rec: EnrichedSilverRecord,
  embedding: readonly number[],
  searchSnapshotId?: string,
  goldCanonicalLookup?: ReadonlyMap<string, string>,
): RetrievalDocument {
  const lookup = goldCanonicalLookup ?? new Map();
  const indexable = silverToIndexable(rec, lookup);

  const doc: RetrievalDocument = {
    entityId: createCanonicalEntityId(indexable.entityId),
    entityType: indexable.entityType,
    ...(searchSnapshotId !== undefined ? { searchSnapshotId } : {}),
    canonicalLabel: indexable.canonicalLabel,
    aliasesIdentitySafe: indexable.aliasesIdentitySafe,
    aliasesNoisyRecall: indexable.aliasesNoisyRecall,
    producer: rec.producer,
    region: rec.region,
    grapes: indexable.grapes,
    searchTextKo: indexable.searchTextKo,
    searchTextEn: rec.searchTextEn,
    semanticSummary: indexable.semanticSummary,
    body: rec.body,
    sweetness: rec.sweetness,
    style: indexable.style,
    priceBand: indexable.priceBand,
    pairing: indexable.pairing,
    occasion: indexable.occasion,
    availability: indexable.availability,
    popularityScore: indexable.popularityScore,
    embedding,
    // Optional fields from indexable — omit keys when absent
    ...(indexable.vintageYear !== undefined ? { vintageYear: indexable.vintageYear } : {}),
    ...(indexable.acidity !== undefined ? { acidity: indexable.acidity } : {}),
    ...(indexable.tannin !== undefined ? { tannin: indexable.tannin } : {}),
    ...(indexable.wineType !== undefined ? { wineType: indexable.wineType } : {}),
    ...(indexable.grapePrimary !== undefined ? { grapePrimary: indexable.grapePrimary } : {}),
    ...(indexable.country !== undefined ? { country: indexable.country } : {}),
    ...(indexable.priceUsd !== undefined ? { priceUsd: indexable.priceUsd } : {}),
    ...(indexable.flavorProfiles !== undefined ? { flavorProfiles: indexable.flavorProfiles } : {}),
    ...(indexable.criticScoreNormalized !== undefined
      ? { criticScoreNormalized: indexable.criticScoreNormalized }
      : {}),
    ...(indexable.learnedSparseWeights !== undefined
      ? { learnedSparseWeights: indexable.learnedSparseWeights }
      : {}),
    ...(indexable.syntheticQueries !== undefined && indexable.syntheticQueries.length > 0
      ? { syntheticQueries: indexable.syntheticQueries }
      : {}),
    ...(indexable.alcoholPct !== undefined ? { alcoholPct: indexable.alcoholPct } : {}),
    ...(indexable.producerPrestige !== undefined
      ? { producerPrestige: indexable.producerPrestige }
      : {}),
    ...(indexable.certifications !== undefined ? { certifications: [...indexable.certifications] } : {}),
    ...(indexable.drinkingWindowStart !== undefined
      ? { drinkingWindowStart: indexable.drinkingWindowStart }
      : {}),
    ...(indexable.drinkingWindowEnd !== undefined
      ? { drinkingWindowEnd: indexable.drinkingWindowEnd }
      : {}),
    ...(indexable.drinkingWindowModelVersion !== undefined
      ? { drinkingWindowModelVersion: indexable.drinkingWindowModelVersion }
      : {}),
    ...(indexable.appellation !== undefined ? { appellation: indexable.appellation } : {}),
    ...(indexable.finishLength !== undefined ? { finishLength: indexable.finishLength } : {}),
    ...(indexable.classification !== undefined ? { classification: indexable.classification } : {}),
    ...(indexable.soilType !== undefined ? { soilType: indexable.soilType } : {}),
    ...(indexable.producerType !== undefined ? { producerType: indexable.producerType } : {}),
    ...(indexable.oakTreatment !== undefined ? { oakTreatment: indexable.oakTreatment } : {}),
    ...(indexable.grapeFamily !== undefined ? { grapeFamily: indexable.grapeFamily } : {}),
    ...(indexable.regionHierarchy !== undefined ? { regionHierarchy: [...indexable.regionHierarchy] } : {}),
    ...(indexable.priceBandNumeric !== undefined ? { priceBandNumeric: indexable.priceBandNumeric } : {}),
    ...(indexable.sourceRecordRefs !== undefined && indexable.sourceRecordRefs.length > 0
      ? { sourceRecordRefs: [...indexable.sourceRecordRefs] }
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
  const goldLookup = await loadGoldCanonicalLookupForBuild({ fixtureRepoRoot: args.fixtureRepoRoot });

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
      const doc = silverToRetrievalDoc(sample, emb, args.snapshotId, goldLookup);
      console.log('  Sample RetrievalDocument:');
      console.log(JSON.stringify(doc, null, 2).slice(0, 2000));
    }
    return;
  }

  // Vespa client — pass mTLS cert/key for Vespa Cloud when configured.
  const vespaCertPath = process.env['VESPA_CERT_PATH']?.trim();
  const vespaKeyPath = process.env['VESPA_KEY_PATH']?.trim();
  const vespaMtls = vespaCertPath && vespaKeyPath
    ? { certPath: vespaCertPath, keyPath: vespaKeyPath }
    : undefined;
  const vespa = new VespaClient(VESPA_URL, NAMESPACE, DOC_TYPE, undefined, vespaMtls);

  const hasApiKey = openAiApiKey() !== undefined;
  if (hasApiKey) {
    console.log('  Will use OpenAI embeddings; on failure → deterministic');
  } else {
    console.log('  Using deterministic fallback embeddings (OPENAI_API_KEY unset)');
  }

  const chunks = chunkArray(records, BATCH_SIZE);
  let indexed = 0;
  let failures = 0;
  let httpEmbedFailures = 0;
  const MAX_HTTP_FAILURES = 3; // switch to deterministic after N consecutive failures

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;

    // Generate embeddings — retry per-batch rather than giving up globally
    let embeddings: readonly (readonly number[])[];
    if (hasApiKey && httpEmbedFailures < MAX_HTTP_FAILURES) {
      try {
        const texts = chunk.map(buildEmbedText);
        embeddings = await embedBatchHttp(texts);
        httpEmbedFailures = 0; // reset on success
      } catch (e) {
        httpEmbedFailures++;
        const msg = e instanceof Error ? e.message : String(e);
        if (httpEmbedFailures >= MAX_HTTP_FAILURES) {
          console.warn(`  Embedding HTTP failed ${httpEmbedFailures}x (${msg}) — switching to deterministic for remaining batches`);
        } else {
          console.warn(`  Embedding HTTP failed (${msg}) — using deterministic for this batch (failure ${httpEmbedFailures}/${MAX_HTTP_FAILURES})`);
        }
        embeddings = chunk.map((r) =>
          deterministicEmbedding(r.body, r.sweetness, r.acidity, r.tannin),
        );
      }
    } else {
      embeddings = chunk.map((r) =>
        deterministicEmbedding(r.body, r.sweetness, r.acidity, r.tannin),
      );
    }

    // Convert to Vespa documents and feed; validate each record before converting
    const docs: { id: string; fields: Record<string, unknown> }[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const rec = chunk[i]!;
      const indexable = silverToIndexable(rec, goldLookup);
      const validation = validateIndexableRecord(indexable);
      if (!validation.valid) {
        failures += 1;
        console.error(
          `  Validation failed for ${rec.sourceId}: ${validation.errors.join('; ')}`,
        );
        continue;
      }
      const embedding = embeddings[i] ?? deterministicEmbedding(rec.body, rec.sweetness, rec.acidity, rec.tannin);
      const retrievalDoc = silverToRetrievalDoc(rec, embedding, args.snapshotId, goldLookup);
      docs.push({
        id: String(retrievalDoc.entityId),
        fields: toVespaFields(retrievalDoc),
      });
    }

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

  const totalRecords = indexed + failures;
  const failureRate = totalRecords > 0 ? failures / totalRecords : 0;
  /** Tolerate up to 2% network failures on cloud endpoints (dev zone
   *  connection pool exhaustion). Above that threshold the feed is broken. */
  const MAX_FAILURE_RATE = 0.02;
  console.log(`\n  Done: ${indexed} indexed, ${failures} failed (${(failureRate * 100).toFixed(1)}%)`);
  if (failureRate > MAX_FAILURE_RATE) {
    console.error(`  Failure rate ${(failureRate * 100).toFixed(1)}% exceeds ${MAX_FAILURE_RATE * 100}% threshold`);
    process.exit(1);
  }
  if (failures > 0) {
    console.warn(`  ${failures} documents failed but within tolerance — proceeding`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
