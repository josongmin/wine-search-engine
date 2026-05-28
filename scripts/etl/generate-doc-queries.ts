#!/usr/bin/env tsx
/**
 * Document Expansion (Doc2Query): generates synthetic search queries per
 * wine and writes them to a typed `syntheticQueries` field on the Silver
 * record. Downstream `index-to-vespa.ts` routes the values into a
 * dedicated Vespa BM25 field (`synthetic_queries`) so the weight is
 * tuned independently of the natural-text fields.
 *
 * Why a typed field instead of concatenation:
 *   The previous implementation appended queries to `searchTextEn` with a
 *   delimiter. That polluted the BM25 IDF on the original text and made
 *   the synthetic content's weight uncontrollable. The typed field gives
 *   the rank profile authority over how much synthetic recall to spend.
 *
 * Idempotency:
 *   Each record carries a `doc2queryFingerprint = { modelId, contentHash }`.
 *   When the source text and modelId are unchanged the record is skipped,
 *   so re-running the script costs only the records that actually drift.
 *   Use `--force` to override and regenerate everything.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/etl/generate-doc-queries.ts
 *   npx tsx --env-file=.env scripts/etl/generate-doc-queries.ts --dry-run --limit 5
 *   npx tsx --env-file=.env scripts/etl/generate-doc-queries.ts --force --limit 100
 *
 * Requires: OPENAI_API_KEY (gpt-5.4-mini by default).
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type {
  Doc2QueryGeneratorPort,
  Doc2QueryInput,
} from '../../src/domain/retrieval/port/doc2query-generator.port.js';
import { OpenAiChatLlm } from '../../src/infrastructure/ai/openai-chat-llm.js';
import { OpenAiDoc2QueryGenerator } from '../../src/infrastructure/ai/openai-doc2query-generator.js';
import { OpenAiEmbeddingService } from '../../src/infrastructure/ai/openai-embedding-service.js';
import { loadConfig } from '../../src/config/env.js';
import type { EnrichedSilverRecord, Doc2QueryFingerprint } from './types.js';
import { parseNdjson } from './ndjson.js';
import { atomicWriteFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';
import {
  applyCanonicalEnrichmentOverlay,
  loadCanonicalEnrichmentOverlay,
} from './canonical-enrichment-overlay.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.ko;
export const DEFAULT_OUTPUT = ETL_ARTIFACT_FILES.docquery;

/**
 * Synthetic queries per wine — 15 slots (SOTA++ contract).
 *
 * Covers exact-entity (EN/KO), typo/spacing variants, region/grape,
 * style (EN + Korean colloquial), food pairing (EN + Korean native),
 * price tier (₩), occasion, beginner, hashtag, and a full-sentence
 * Korean discovery question. See `openai-doc2query-generator.ts` for
 * the exact slot taxonomy and evidence behind it.
 */
export const DOC_QUERIES_PER_DOC = 15;
/** Backwards-compatible alias kept so the rest of this script reads as before. */
const QUERIES_PER_WINE = DOC_QUERIES_PER_DOC;

/**
 * Minimum query length (characters, post-NFC, post-trim). Anything shorter is
 * either a slot-collapse artifact ("a", "ok") or an LLM truncation glitch and
 * has no useful BM25 signal. CLAUDE.md rule 15 — named constant, not magic.
 */
export const DOC_QUERY_MIN_CHARS = 3;

/**
 * Maximum query length (characters, post-NFC, post-trim). 200 chars covers
 * the longest legitimate Korean discovery-question slot ("스테이크와 함께
 * 마시기 좋은 풀바디 카베르네 소비뇽 추천해주세요" ≈ 40 chars) plus an
 * order-of-magnitude safety margin while keeping ill-formed LLM outputs
 * (run-on paragraphs, leaked rationales) out of the BM25 field.
 */
export const DOC_QUERY_MAX_CHARS = 200;

/**
 * Output schema version on the processed-queries record. Bump whenever the
 * dedup / normalization / bound rules change so downstream consumers can
 * detect and migrate stale artifacts.
 */
export const DOC_QUERIES_SCHEMA_VERSION = '1';

/**
 * Concurrent in-flight LLM calls. With ~3s p50 latency per call against
 * gpt-5-series models, serial execution would take 6+ hours for the full
 * 7K-wine corpus. Tier 5 OpenAI accounts support 10K+ RPM, so a pool of
 * 100 stays well under the rate limit while turning a 6-hour job into
 * a few minutes. Override at runtime with `--concurrency N`. The OpenAI
 * adapter already retries 429s with exponential backoff, so a brief
 * overshoot self-corrects.
 */
const DEFAULT_CONCURRENCY = 100;

/** Progress checkpoint frequency (records). */
const PROGRESS_LOG_EVERY = 100;

/** Persist partial result to disk every N completions (resume safety). */
const CHECKPOINT_EVERY = 500;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  readonly input: string;
  readonly output: string;
  readonly dryRun: boolean;
  readonly limit: number;
  readonly force: boolean;
  readonly concurrency: number;
}

function parseArgs(argv: readonly string[]): Args {
  let input = DEFAULT_INPUT;
  let output = DEFAULT_OUTPUT;
  let dryRun = false;
  let limit = 0;
  let force = false;
  let concurrency = DEFAULT_CONCURRENCY;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--input' || a === '-i') && argv[i + 1] !== undefined) {
      input = argv[++i] ?? DEFAULT_INPUT;
    } else if ((a === '--output' || a === '-o') && argv[i + 1] !== undefined) {
      output = argv[++i] ?? DEFAULT_OUTPUT;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--limit' && argv[i + 1] !== undefined) {
      limit = Math.max(1, Number(argv[++i] ?? '0'));
    } else if (a === '--force') {
      force = true;
    } else if (a === '--concurrency' && argv[i + 1] !== undefined) {
      concurrency = Math.max(1, Number(argv[++i] ?? String(DEFAULT_CONCURRENCY)));
    }
  }
  return { input, output, dryRun, limit, force, concurrency };
}

// ---------------------------------------------------------------------------
// Source-text + fingerprint
// ---------------------------------------------------------------------------

/**
 * Regex for detecting Hangul characters in alias strings so we can
 * filter the Korean aliases out of the full RFC-003 alias bundle.
 */
const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3]/u;

/** Hard cap on Korean aliases injected into the Doc2Query prompt. */
const MAX_KOREAN_ALIASES_PER_WINE = 8;

/**
 * Extract Korean aliases from the enriched record's RFC-003 alias
 * bundle. `generate-korean-aliases.ts` stores validated Korean
 * romanizations alongside other alias types; we pull just the Hangul
 * ones so the Doc2Query prompt can reuse them verbatim without
 * hallucinating new romanizations.
 */
function extractKoreanAliases(rec: EnrichedSilverRecord): readonly string[] {
  const proposed = rec.aliases?.proposed ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of proposed) {
    const v = (a as { value?: unknown }).value;
    if (typeof v !== 'string') continue;
    if (!HANGUL_REGEX.test(v)) continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_KOREAN_ALIASES_PER_WINE) break;
  }
  return out;
}

/**
 * Build the structured Doc2Query input from an enriched Silver record.
 * The field order is fixed so the fingerprint stays stable across runs
 * when unrelated fields drift.
 */
function buildGeneratorInput(
  rec: EnrichedSilverRecord,
  numQueries: number,
): Doc2QueryInput {
  return {
    canonicalLabel: rec.canonicalLabel,
    producer: rec.producer,
    region: rec.region,
    country: rec.country ?? '',
    grapePrimary: rec.grapePrimary ?? null,
    grapes: rec.grapes ?? [],
    body: rec.body,
    tannin: rec.tannin,
    priceUsd:
      rec.priceUsd !== null && rec.priceUsd !== undefined
        ? Number(rec.priceUsd)
        : null,
    ...(rec.priceBand !== undefined ? { priceBand: rec.priceBand } : {}),
    vintageYear: rec.vintageYear ?? null,
    alcoholPct: rec.alcoholPct ?? null,
    flavorProfiles: rec.flavorProfiles ?? [],
    pairingTags: rec.pairingTags ?? [],
    drinkingWindowStart: null,
    drinkingWindowEnd: null,
    isTopRated: rec.isTopRated ?? false,
    koreanAliases: extractKoreanAliases(rec),
    numQueries,
  };
}

/**
 * Content hash material — a deterministic string built from the
 * structured input. Stable across runs so idempotent skip works as long
 * as the underlying Silver record hasn't drifted.
 */
function fingerprintMaterial(input: Doc2QueryInput): string {
  return [
    input.canonicalLabel,
    input.producer,
    input.region,
    input.country,
    input.grapePrimary ?? '',
    input.grapes.join(','),
    input.body !== null ? input.body.toFixed(3) : 'null',
    input.tannin !== null ? input.tannin.toFixed(3) : 'null',
    input.priceUsd !== null ? input.priceUsd.toFixed(2) : '',
    input.priceBand ?? '',
    input.vintageYear !== null ? String(input.vintageYear) : '',
    input.alcoholPct !== null ? input.alcoholPct.toFixed(2) : '',
    input.flavorProfiles.join(','),
    input.pairingTags.join(','),
    input.koreanAliases.join('|'),
    String(input.numQueries),
  ].join('\n');
}

function fingerprintFor(modelId: string, input: Doc2QueryInput): Doc2QueryFingerprint {
  const material = fingerprintMaterial(input);
  const contentHash = crypto.createHash('sha256').update(material).digest('hex');
  return {
    modelId,
    contentHash,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Returns true when the existing fingerprint matches the current modelId
 * + content hash (derived from the structured input). Skipped records
 * carry their previous syntheticQueries unchanged.
 */
function isFingerprintFresh(
  rec: EnrichedSilverRecord,
  modelId: string,
  input: Doc2QueryInput,
): boolean {
  const fp = rec.doc2queryFingerprint;
  if (fp === undefined) return false;
  if (fp.modelId !== modelId) return false;
  const contentHash = crypto
    .createHash('sha256')
    .update(fingerprintMaterial(input))
    .digest('hex');
  return fp.contentHash === contentHash;
}

// ---------------------------------------------------------------------------
// Query post-processing (bounds + dedup + schema version)
// ---------------------------------------------------------------------------

/**
 * Processed Doc2Query payload: a deduplicated, bounded list of synthetic
 * queries plus the schema version that produced them. The list is what the
 * rest of the pipeline writes onto `EnrichedSilverRecord.syntheticQueries`;
 * the schema version is stamped onto the Doc2Query fingerprint so downstream
 * stages can detect rule drift.
 */
export interface ProcessedDoc2QueryResult {
  readonly queries: readonly string[];
  readonly schemaVersion: string;
}

/**
 * Whitespace-only or empty? Used to drop placeholder slots that the LLM
 * occasionally emits when it can't fill a slot but doesn't drop the index.
 */
function isBlank(s: string): boolean {
  return s.trim().length === 0;
}

/**
 * Canonical form for dedup: NFC + lowercase + collapsed internal whitespace.
 * Case- and spacing-insensitive so the LLM's near-duplicate emissions
 * ("Opus One Napa" / "opus one  napa" / "OPUS ONE NAPA") collapse to one.
 *
 * This is INTERNAL — we never emit the canonical form to consumers; we use
 * it only as a dedup key. The first-occurrence original-cased query wins
 * so display surfaces keep human-readable capitalization.
 */
function canonicalDedupKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Normalize, length-bound, and dedup a raw LLM-emitted query list. Pure —
 * no I/O, no side effects, deterministic for a given input list. Returns
 * an empty list (never throws) for empty / malformed input.
 *
 * Invariants enforced (regression-tested in
 * `test/regression/doc-queries-generation.regression.test.ts`):
 *   - Every emitted query has length ∈ [DOC_QUERY_MIN_CHARS, DOC_QUERY_MAX_CHARS].
 *   - Every emitted query is NFC-normalized.
 *   - Duplicates by `canonicalDedupKey` are emitted at most once, first wins.
 *   - Empty / whitespace-only entries are silently dropped (LLM slot misfires).
 */
export function normalizeAndDedupeQueries(
  raw: readonly string[],
): ProcessedDoc2QueryResult {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.normalize('NFC').trim();
    if (isBlank(trimmed)) continue;
    if (trimmed.length < DOC_QUERY_MIN_CHARS) continue;
    if (trimmed.length > DOC_QUERY_MAX_CHARS) continue;
    const key = canonicalDedupKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return {
    queries: out,
    schemaVersion: DOC_QUERIES_SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RunStats {
  readonly total: number;
  readonly skipped: number;
  readonly generated: number;
  readonly failed: number;
  readonly totalQueries: number;
}

export function assertDocQueryRunSucceeded(stats: RunStats): void {
  if (stats.failed > 0) {
    throw new Error(
      `generate-doc-queries: ${stats.failed} record(s) failed — refusing to promote partial output`,
    );
  }
}

/**
 * Process one record: skip if fingerprint fresh, otherwise call the LLM.
 * Always returns a valid record — on error/empty/blank-canonical-label,
 * returns the prior record unchanged so we never lose ground on transient
 * failures.
 *
 * `signal` (optional) — cooperative cancellation. If aborted before the LLM
 * call is dispatched the call is skipped entirely (no wasted token spend),
 * matching the batch-cancellation contract used by `generateForBatch`.
 */
async function processRecord(
  rec: EnrichedSilverRecord,
  generator: Doc2QueryGeneratorPort,
  force: boolean,
  signal?: AbortSignal,
): Promise<{ rec: EnrichedSilverRecord; outcome: 'skipped' | 'generated' | 'failed'; queryCount: number }> {
  // Pre-flight abort check — pre-call so we don't spend tokens (CLAUDE.md rule 20).
  if (signal?.aborted === true) {
    return { rec, outcome: 'failed', queryCount: 0 };
  }

  // Empty/whitespace canonical labels can't anchor a useful Doc2Query input;
  // skip without an LLM round-trip. Matches the port contract documented in
  // `doc2query-generator.port.ts`.
  if (rec.canonicalLabel.trim().length === 0) {
    return { rec, outcome: 'failed', queryCount: 0 };
  }

  const input = buildGeneratorInput(rec, QUERIES_PER_WINE);

  if (!force && isFingerprintFresh(rec, generator.modelId, input)) {
    return { rec, outcome: 'skipped', queryCount: 0 };
  }

  try {
    const rawQueries = await generator.generate(input);
    const processed = normalizeAndDedupeQueries(rawQueries);
    if (processed.queries.length > 0) {
      const next: EnrichedSilverRecord = {
        ...rec,
        syntheticQueries: processed.queries,
        doc2queryFingerprint: fingerprintFor(generator.modelId, input),
      };
      return { rec: next, outcome: 'generated', queryCount: processed.queries.length };
    }
    return { rec, outcome: 'failed', queryCount: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Failed for ${rec.sourceId}: ${msg}`);
    return { rec, outcome: 'failed', queryCount: 0 };
  }
}

/**
 * Test-only re-export of `processRecord` so the regression suite can drive
 * the function with a mocked `Doc2QueryGeneratorPort` without spawning the
 * CLI entrypoint or touching OpenAI. NOT intended for production callers.
 */
export const processRecordForTest = processRecord;

/**
 * Run `processRecord` over the corpus with a fixed-size in-flight pool.
 *
 * Implementation: maintain `CONCURRENCY` workers reading from a shared
 * cursor. Output order is preserved by writing each result into a
 * pre-allocated slot indexed by the record's input position. Each
 * `flushIntervalMs`-aligned milestone the partial result is written to
 * disk via `atomicWriteFile` so a mid-run crash leaves a valid NDJSON
 * checkpoint that the next run can resume from (idempotency does the
 * skip work).
 */
async function generateForBatch(
  records: readonly EnrichedSilverRecord[],
  generator: Doc2QueryGeneratorPort,
  force: boolean,
  checkpointPath: string,
  checkpointEvery: number,
  concurrency: number,
): Promise<{ updated: EnrichedSilverRecord[]; stats: RunStats }> {
  const total = records.length;
  const updated: EnrichedSilverRecord[] = records.slice();
  let cursor = 0;
  let completed = 0;
  let skipped = 0;
  let generated = 0;
  let failed = 0;
  let totalQueries = 0;
  let lastCheckpoint = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= total) return;

      const rec = records[idx]!;
      const result = await processRecord(rec, generator, force);
      updated[idx] = result.rec;

      if (result.outcome === 'skipped') skipped += 1;
      else if (result.outcome === 'generated') {
        generated += 1;
        totalQueries += result.queryCount;
      } else {
        failed += 1;
      }

      completed += 1;

      if (completed % PROGRESS_LOG_EVERY === 0) {
        console.log(
          `  Progress: ${completed}/${total}  generated=${generated} skipped=${skipped} failed=${failed} queries=${totalQueries}`,
        );
      }

      // Checkpoint every N completions — written by whichever worker
      // crosses the threshold first. Imperfect concurrency here is fine:
      // worst case we write twice in close succession.
      if (completed - lastCheckpoint >= checkpointEvery) {
        lastCheckpoint = completed;
        try {
          const lines = updated.map((r) => JSON.stringify(r)).join('\n');
          await atomicWriteFile(checkpointPath, lines + '\n');
          console.log(`  Checkpoint: ${completed}/${total} → ${checkpointPath}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`generate-doc-queries: checkpoint write failed: ${msg}`);
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);

  return {
    updated,
    stats: {
      total,
      skipped,
      generated,
      failed,
      totalQueries,
    },
  };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  if (config.openai.apiKey === undefined) {
    throw new Error(
      'generate-doc-queries: OPENAI_API_KEY must be set — Doc2Query requires the OpenAI chat adapter',
    );
  }

  const chatLlm = new OpenAiChatLlm({
    baseUrl: config.openai.baseUrl,
    apiKey: config.openai.apiKey,
    defaultModel: config.openai.chatModel,
    httpTimeoutMs: config.openai.httpTimeoutMs,
  });
  // Round-trip embedding filter uses text-embedding-3-small by default —
  // cheap ($0.02/MTok) and accurate enough to reject generic synthetic
  // queries. Override by pointing config.openai.embeddingModel at another
  // OpenAI-compatible endpoint if a different checkpoint is preferred.
  const embeddingService = new OpenAiEmbeddingService({
    baseUrl: config.openai.baseUrl,
    apiKey: config.openai.apiKey,
    model: config.openai.embeddingModel,
    httpTimeoutMs: config.openai.httpTimeoutMs,
  });
  const generator: Doc2QueryGeneratorPort = new OpenAiDoc2QueryGenerator({
    chatLlm,
    embeddingService,
    model: config.openai.doc2queryModel,
  });

  console.log(`Reading enriched Silver from ${args.input} …`);
  const [content, overlay] = await Promise.all([
    fs.readFile(args.input, 'utf8'),
    loadCanonicalEnrichmentOverlay(),
  ]);
  let records = parseNdjson<EnrichedSilverRecord>(content, args.input).records
    .map((record) => applyCanonicalEnrichmentOverlay(record, overlay));

  if (args.limit > 0) records = records.slice(0, args.limit);
  console.log(
    `  Records: ${records.length}  modelId=${generator.modelId}  force=${args.force}  concurrency=${args.concurrency}`,
  );

  if (args.dryRun) {
    console.log('  DRY RUN — sample generator input:');
    const sample = records[0];
    if (sample !== undefined) {
      const input = buildGeneratorInput(sample, QUERIES_PER_WINE);
      console.log(JSON.stringify(input, null, 2));
    }
    return;
  }

  const startedAt = Date.now();
  const checkpointPath = `${args.output}.checkpoint`;
  const { updated, stats } = await generateForBatch(
    records,
    generator,
    args.force,
    checkpointPath,
    CHECKPOINT_EVERY,
    args.concurrency,
  );
  const elapsedMs = Date.now() - startedAt;
  const llmCalls = stats.generated + stats.failed;
  const throughput = llmCalls > 0 ? (llmCalls / (elapsedMs / 1000)).toFixed(2) : '0';
  if (stats.failed > 0) {
    const message = `generate-doc-queries: ${stats.failed} record(s) failed — refusing to promote partial output`;
    console.error(`  ${message}`);
    throw new Error(message);
  }
  console.log(
    `  Done: total=${stats.total} generated=${stats.generated} skipped=${stats.skipped} failed=${stats.failed} totalQueries=${stats.totalQueries}`,
  );
  console.log(
    `  Elapsed: ${(elapsedMs / 1000).toFixed(1)}s  llmCalls=${llmCalls}  throughput=${throughput} calls/sec`,
  );

  const lines = updated.map((r) => JSON.stringify(r)).join('\n');
  await atomicWriteFile(args.output, lines + '\n');
  console.log(`  Written to: ${args.output}`);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
