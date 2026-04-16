#!/usr/bin/env tsx
/**
 * Vespa Indexer: Reads enriched Silver NDJSON, generates embeddings,
 * and feeds RetrievalDocument records to Vespa.
 *
 * Handles:
 * - BGE-M3 instruction prefix (document side: no prefix)
 * - Batch embedding generation
 * - Deterministic entity_id → Vespa upsert (idempotent)
 * - Real embedding only (fail closed; no deterministic fallback)
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/etl/index-to-vespa.ts
 *   npx tsx --env-file=.env scripts/etl/index-to-vespa.ts --input data/silver-trackc.ndjson --dry-run
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import type { EnrichedSilverRecord, IndexableWineRecord } from './types.js';
import { SOURCE_SYSTEM_VIVINO_SILVER } from '../../src/shared/constants/source-systems.js';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSION } from '../../src/shared/constants/embedding.js';
import { parseNdjson } from './ndjson.js';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import { toVespaFields } from '../../src/infrastructure/vespa/mapping.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/entity-id.js';
import type { RetrievalDocument } from '../../src/domain/retrieval/model/retrieval-document.js';
import {
  loadGoldCanonicalLookupForBuild,
  resolveWineSnapshotEntity,
} from './snapshot-entity-identity.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';
import { hashStableJson } from '../../src/shared/utils/stable-json.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.trackc;
const VESPA_URL = process.env['VESPA_URL'] ?? 'http://localhost:8080';
const NAMESPACE = 'wine';
const DOC_TYPE = 'wine_entity';
function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
const EMBEDDING_BATCH_SIZE = 5;
const PREPARED_FEED_BATCH_SIZE = parsePositiveIntEnv(
  process.env['VESPA_PREPARED_FEED_BATCH_SIZE'],
  50,
);

/**
 * GRAPE_FAMILY_MAP — lookup table for multi-word grape variety → canonical family.
 * Rule 27 (CLAUDE.md): "Nero d'Avola" → "Nero" and "Sauvignon Blanc" → "Sauvignon" are wrong.
 * Use this map before falling back to split()[0] for single-word varieties.
 */
const GRAPE_FAMILY_MAP = new Map<string, string>([
  // Multi-word varieties whose family is NOT the first word
  ["nero d'avola", "Nero d'Avola"],
  ['sauvignon blanc', 'Sauvignon Blanc'],
  ['grüner veltliner', 'Grüner Veltliner'],
  ['cabernet sauvignon', 'Cabernet Sauvignon'],
  ['cabernet franc', 'Cabernet Franc'],
  ['pinot noir', 'Pinot Noir'],
  ['pinot grigio', 'Pinot Grigio'],
  ['pinot gris', 'Pinot Gris'],
  ['pinot blanc', 'Pinot Blanc'],
  ['pinot meunier', 'Pinot Meunier'],
  ['chenin blanc', 'Chenin Blanc'],
  ['petite sirah', 'Petite Sirah'],
  ['petit verdot', 'Petit Verdot'],
  ['gamay noir', 'Gamay Noir'],
  ['muscat blanc', 'Muscat Blanc'],
  ['müller-thurgau', 'Müller-Thurgau'],
  ['touriga nacional', 'Touriga Nacional'],
  ['touriga franca', 'Touriga Franca'],
  ['garnacha tinta', 'Garnacha Tinta'],
  ['moscato bianco', 'Moscato Bianco'],
]);

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
  const model = process.env['OPENAI_EMBEDDING_MODEL'] ?? EMBEDDING_MODEL;
  const response = await fetch(`${openAiBaseUrl()}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [...texts],
      dimensions: EMBEDDING_DIMENSION,
    }),
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
  preparedFeed?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { input: DEFAULT_INPUT, dryRun: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--prepared-feed') {
      const v = argv[++i];
      if (v !== undefined) out.preparedFeed = v;
    }
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
        'Usage: index-to-vespa.ts [--input PATH] [--prepared-feed PATH] [--dry-run] [--limit N] [--snapshot-id ID] [--fixture-repo PATH]',
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

export interface PreparedVespaFeedDocument {
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

interface ReusableEmbeddingEntry {
  readonly semanticSummary: string;
  readonly embedding: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializePreparedVespaFeedDocuments(
  docs: readonly PreparedVespaFeedDocument[],
): string {
  return docs.map((doc) => JSON.stringify(doc)).join('\n') + '\n';
}

export function parsePreparedVespaFeedDocuments(
  raw: string,
  filePath: string,
): readonly PreparedVespaFeedDocument[] {
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const docs: PreparedVespaFeedDocument[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index] ?? '');
    } catch {
      throw new Error(
        `Invalid prepared Vespa feed artifact at ${filePath}:${index + 1} — expected JSON object`,
      );
    }
    if (!isRecord(parsed) || typeof parsed['id'] !== 'string' || parsed['id'].length === 0 || !isRecord(parsed['fields'])) {
      throw new Error(
        `Invalid prepared Vespa feed artifact at ${filePath}:${index + 1} — expected {id, fields} record`,
      );
    }
    docs.push({
      id: parsed['id'],
      fields: parsed['fields'],
    });
  }
  return docs;
}

function parsePreparedEmbeddingValue(value: unknown): readonly number[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
    return value;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const values = (value as Record<string, unknown>)['values'];
    if (Array.isArray(values) && values.every((item) => typeof item === 'number')) {
      return values;
    }
  }
  return undefined;
}

export function buildReusableEmbeddingIndex(
  docs: readonly PreparedVespaFeedDocument[],
): ReadonlyMap<string, ReusableEmbeddingEntry> {
  const index = new Map<string, ReusableEmbeddingEntry>();
  for (const doc of docs) {
    const entityId = typeof doc.fields['entity_id'] === 'string' ? doc.fields['entity_id'] : undefined;
    const semanticSummary = typeof doc.fields['semantic_summary'] === 'string'
      ? doc.fields['semantic_summary']
      : undefined;
    const embedding = parsePreparedEmbeddingValue(doc.fields['embedding']);
    if (entityId === undefined || semanticSummary === undefined || embedding === undefined) {
      continue;
    }
    index.set(entityId, { semanticSummary, embedding });
  }
  return index;
}

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

function trimNonEmpty(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(values: readonly string[] | undefined): readonly string[] | undefined {
  if (values === undefined) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = trimNonEmpty(value);
    if (trimmed === undefined || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Derives a style label from body, sweetness, and wine type.
 * When the sensory inputs are absent, the field is omitted instead of
 * synthesizing a midpoint label.
 */
function deriveStyle(rec: GoldRecord): string {
  const wt = rec.wineType;
  if (wt === undefined) {
    throw new Error('deriveStyle: wineType is required');
  }
  if (wt === 'sparkling') return 'sparkling';
  if (wt === 'dessert') return 'sweet';
  if (wt === 'fortified') return 'fortified';
  if (wt === 'rosé') return 'rosé';
  if (rec.body == null || rec.sweetness == null) return wt;
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
  const style = deriveStyle(gold);
  const soilType = trimNonEmpty(rec.soilType);
  const producerType = trimNonEmpty(rec.producerType);
  const grapeFamily = trimNonEmpty(rec.grapeFamily)
    ?? (rec.grapePrimary != null
      ? (GRAPE_FAMILY_MAP.get(rec.grapePrimary.toLowerCase()) ?? rec.grapePrimary.split(/\s+/)[0])
      : undefined);
  const regionHierarchy = normalizeStringArray(rec.regionHierarchy);
  const occasion = normalizeStringArray(
    rec.occasionClassification?.values ?? rec.occasion,
  );

  return {
    // RetrievalHitProjection fields
    entityId: resolvedEntity.entityId,
    sourceRecordRefs: [
      { sourceSystem: SOURCE_SYSTEM_VIVINO_SILVER, sourceRecordId: rec.sourceId },
    ],
    canonicalLabel: rec.canonicalLabel,
    ...(rec.producer.length > 0 ? { producer: rec.producer } : {}),
    ...(rec.region.length > 0 ? { region: rec.region } : {}),
    ...(rec.appellation ? { appellation: rec.appellation } : {}),
    ...(rec.grapePrimary ? { grapePrimary: rec.grapePrimary } : {}),
    ...(rec.vintageYear !== null ? { vintageYear: rec.vintageYear } : {}),
    ...(rec.searchTextEn.length > 0 ? { searchTextEn: rec.searchTextEn } : {}),
    ...(gold.producerPrestige != null ? { producerPrestige: gold.producerPrestige } : {}),
    // avgCriticProxyScore mirrors criticScoreNormalized for the hit-projection summary.
    ...(criticScoreNormalized !== undefined ? { avgCriticProxyScore: criticScoreNormalized } : {}),

    // RetrievalFeatureProjection fields
    ...(rec.body != null ? { body: rec.body } : {}),
    ...(rec.sweetness != null ? { sweetness: rec.sweetness } : {}),
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
    style,
    priceBand: rec.priceBand,
    pairing: rec.pairingTags,
    ...(occasion !== undefined ? { occasion: [...occasion] } : {}),
    availability: true,
    popularityScore: computePopularity(gold),
    ...(rec.wineType ? { wineType: rec.wineType } : {}),
    ...(rec.country ? { country: rec.country } : {}),
    ...(rec.priceUsd !== null ? { priceUsd: rec.priceUsd } : {}),
    ...(grapeFamily !== undefined ? { grapeFamily } : {}),
    ...(regionHierarchy !== undefined ? { regionHierarchy: [...regionHierarchy] } : {}),
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
    ...(soilType !== undefined ? { soilType } : {}),
    ...(producerType !== undefined ? { producerType } : {}),
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
    ...(indexable.body != null ? { body: indexable.body } : {}),
    ...(indexable.sweetness != null ? { sweetness: indexable.sweetness } : {}),
    style: indexable.style,
    priceBand: indexable.priceBand,
    pairing: indexable.pairing,
    ...(indexable.occasion !== undefined ? { occasion: [...indexable.occasion] } : {}),
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

export async function preparePreparedVespaFeedDocuments(args: {
  readonly records: readonly EnrichedSilverRecord[];
  readonly snapshotId?: string;
  readonly goldCanonicalLookup?: ReadonlyMap<string, string>;
  readonly reusablePreparedDocs?: readonly PreparedVespaFeedDocument[];
}): Promise<readonly PreparedVespaFeedDocument[]> {
  const lookup = args.goldCanonicalLookup ?? new Map();
  const reusableEmbeddingIndex = buildReusableEmbeddingIndex(args.reusablePreparedDocs ?? []);
  const docs = new Array<PreparedVespaFeedDocument>(args.records.length);
  const pending: Array<{
    readonly index: number;
    readonly record: EnrichedSilverRecord;
  }> = [];

  for (let i = 0; i < args.records.length; i += 1) {
    const rec = args.records[i]!;
    const indexable = silverToIndexable(rec, lookup);
    const validation = validateIndexableRecord(indexable);
    if (!validation.valid) {
      throw new Error(
        `Validation failed for ${rec.sourceId}: ${validation.errors.join('; ')}`,
      );
    }

    const reusable = reusableEmbeddingIndex.get(indexable.entityId);
    if (reusable !== undefined && reusable.semanticSummary === indexable.semanticSummary) {
      const retrievalDoc = silverToRetrievalDoc(rec, reusable.embedding, args.snapshotId, lookup);
      docs[i] = {
        id: String(retrievalDoc.entityId),
        fields: toVespaFields(retrievalDoc),
      };
      continue;
    }
    pending.push({ index: i, record: rec });
  }

  if (pending.length > 0) {
    if (openAiApiKey() === undefined) {
      throw new Error('OPENAI_API_KEY is required for embedding generation — deterministic fallback is disabled (fail-closed)');
    }
    const chunks = chunkArray(pending, EMBEDDING_BATCH_SIZE);
    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]!;
      const texts = chunk.map(({ record }) => buildEmbedText(record));
      let embeddings: readonly (readonly number[])[];
      const EMBED_MAX_RETRIES = 3;
      for (let attempt = 1; ; attempt++) {
        try {
          embeddings = await embedBatchHttp(texts);
          break;
        } catch (e) {
          if (attempt >= EMBED_MAX_RETRIES) throw e;
          const msg = e instanceof Error ? e.message : String(e);
          const delayMs = attempt * 2000;
          console.warn(`  Embedding batch ${ci + 1} attempt ${attempt} failed (${msg}) — retrying in ${delayMs}ms`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      for (let i = 0; i < chunk.length; i++) {
        const rec = chunk[i]!.record;
        const targetIndex = chunk[i]!.index;
        const embedding = embeddings[i];
        if (embedding === undefined) {
          throw new Error(`Embedding missing for record ${rec.sourceId} at index ${i} — OpenAI returned fewer vectors than inputs`);
        }
        const retrievalDoc = silverToRetrievalDoc(rec, embedding, args.snapshotId, lookup);
        docs[targetIndex] = {
          id: String(retrievalDoc.entityId),
          fields: toVespaFields(retrievalDoc),
        };
      }
    }
  }

  return docs;
}

async function createVespaClient(): Promise<VespaClient> {
  const vespaCertPath = process.env['VESPA_CERT_PATH']?.trim();
  const vespaKeyPath = process.env['VESPA_KEY_PATH']?.trim();
  const vespaMtls = vespaCertPath && vespaKeyPath
    ? { certPath: vespaCertPath, keyPath: vespaKeyPath }
    : undefined;
  return new VespaClient(VESPA_URL, NAMESPACE, DOC_TYPE, undefined, vespaMtls);
}

async function feedPreparedVespaDocuments(
  vespa: VespaClient,
  docs: readonly PreparedVespaFeedDocument[],
  options?: {
    readonly maxFailureRate?: number;
  },
): Promise<void> {
  const chunks = chunkArray(docs, PREPARED_FEED_BATCH_SIZE);
  let indexed = 0;
  let failures = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;
    const result = await vespa.bulkFeed(chunk.map((doc) => ({
      id: doc.id,
      fields: doc.fields,
    })));
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
  // Wave 4 (fail-loud): a non-zero `maxFailureRate` lets a publish proceed
  // with a partially-indexed snapshot. This is a real ops escape hatch but
  // must NOT be used silently in production. Require an explicit
  // env var `ETL_INDEX_PARTIAL_FAILURE_ACK=YES` from the operator.
  const maxFailureRate = options?.maxFailureRate ?? 0;
  if (maxFailureRate > 0) {
    const ack = process.env['ETL_INDEX_PARTIAL_FAILURE_ACK'];
    if (ack !== 'YES') {
      console.error(
        `\n  REFUSING to apply maxFailureRate=${maxFailureRate} (>0) without operator ack. ` +
        `Set ETL_INDEX_PARTIAL_FAILURE_ACK=YES to acknowledge that an incomplete snapshot will be published.`,
      );
      process.exit(1);
    }
  }
  console.log(`\n  Done: ${indexed} indexed, ${failures} failed (${(failureRate * 100).toFixed(1)}%)`);
  if (failureRate > maxFailureRate) {
    console.error(`  Failure rate ${(failureRate * 100).toFixed(1)}% exceeds ${maxFailureRate * 100}% threshold`);
    process.exit(1);
  }
  if (failures > 0 && maxFailureRate > 0) {
    console.warn(`  ${failures} documents failed but within tolerance — proceeding (ETL_INDEX_PARTIAL_FAILURE_ACK=YES)`);
  }
}

export async function materializePreparedVespaFeedArtifact(args: {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly snapshotId: string;
  readonly fixtureRepoRoot?: string;
  readonly reuseEmbeddingFromPreparedFeedPath?: string;
}): Promise<{
  readonly count: number;
  readonly hash: string;
}> {
  const goldLookup = await loadGoldCanonicalLookupForBuild({ fixtureRepoRoot: args.fixtureRepoRoot });
  const raw = await fs.readFile(args.inputPath, 'utf8');
  const records = parseNdjson<EnrichedSilverRecord>(raw, args.inputPath).records;
  const reusablePreparedDocs = args.reuseEmbeddingFromPreparedFeedPath !== undefined
    ? parsePreparedVespaFeedDocuments(
      await fs.readFile(args.reuseEmbeddingFromPreparedFeedPath, 'utf8'),
      args.reuseEmbeddingFromPreparedFeedPath,
    )
    : undefined;
  const docs = await preparePreparedVespaFeedDocuments({
    records,
    snapshotId: args.snapshotId,
    goldCanonicalLookup: goldLookup,
    ...(reusablePreparedDocs !== undefined ? { reusablePreparedDocs } : {}),
  });
  const serialized = serializePreparedVespaFeedDocuments(docs);
  await fs.writeFile(args.outputPath, serialized, 'utf8');
  return {
    count: docs.length,
    hash: hashStableJson(docs),
  };
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
  if (args.preparedFeed !== undefined) {
    console.log(`Reading prepared Vespa feed from ${args.preparedFeed} …`);
    const raw = await fs.readFile(args.preparedFeed, 'utf8');
    const docs = parsePreparedVespaFeedDocuments(raw, args.preparedFeed);
    console.log(`  Prepared documents to index: ${docs.length}`);
    if (args.dryRun) {
      console.log('  DRY RUN — skipping Vespa feed');
      return;
    }
    const vespa = await createVespaClient();
    await feedPreparedVespaDocuments(vespa, docs, { maxFailureRate: 0 });
    return;
  }

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
      const indexable = silverToIndexable(sample, goldLookup);
      const validation = validateIndexableRecord(indexable);
      console.log('  Sample IndexableWineRecord:');
      console.log(JSON.stringify(indexable, null, 2).slice(0, 2000));
      if (!validation.valid) {
        console.log(`  Validation errors: ${validation.errors.join('; ')}`);
      }
    }
    return;
  }

  console.log('  Using OpenAI embeddings (fail-closed — no deterministic fallback)');
  const docs = await preparePreparedVespaFeedDocuments({
    records,
    ...(args.snapshotId !== undefined ? { snapshotId: args.snapshotId } : {}),
    goldCanonicalLookup: goldLookup,
  });
  const vespa = await createVespaClient();
  await feedPreparedVespaDocuments(vespa, docs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
