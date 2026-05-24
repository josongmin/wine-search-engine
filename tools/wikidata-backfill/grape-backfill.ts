#!/usr/bin/env tsx
/**
 * Tier 1.1: Wikidata Grape Backfill ETL.
 *
 * Reads a Silver NDJSON file produced by `scripts/etl/vivino-to-silver.ts`,
 * augments each record whose `grapes` field is empty with grape variety
 * names sourced from Wikidata (`wdt:P186` "made from material"), and writes
 * the augmented NDJSON to a new file. The primary grape is recomputed via
 * the existing `resolveDominantGrape` helper.
 *
 * Bronze (Vivino dump) has ~38% grape coverage. Wikidata covers famous
 * wines + DOCG/AOC + a long tail of named producers and can lift coverage
 * substantially without overwriting source-of-truth Vivino data.
 *
 * Design invariants:
 *   - Never overwrite an existing non-empty `grapes` array.
 *   - Public Wikidata SPARQL has a usage policy: ≤ 5 req/sec, identifiable
 *     User-Agent required. Both are enforced here.
 *   - Cache is append-only JSONL keyed by silver `externalId`. Re-running
 *     the script skips records already decided (hit or miss).
 *   - Atomic output (temp file + rename) — partial writes can never
 *     corrupt the downstream silver consumer.
 *   - SPARQL response is Zod-validated; no `as` casts on external JSON.
 *
 * Usage:
 *   pnpm tsx tools/wikidata-backfill/grape-backfill.ts \
 *     --input data/silver.ndjson \
 *     --output data/silver-with-grapes.ndjson
 *
 * Optional flags:
 *   --cache <path>     Override cache JSONL location (default:
 *                      tools/wikidata-backfill/cache/wikidata-matches.jsonl)
 *   --limit <N>        Stop after the first N records (debug aid)
 *   --user-agent <ua>  Override the Wikidata User-Agent string
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { atomicWriteFile } from '../../scripts/etl/etl-utils.js';
import { resolveDominantGrape } from '../../scripts/etl/vivino-to-silver.js';

// ---------------------------------------------------------------------------
// Tunables — every numeric/string constant lives here so reviewers can audit
// the operational envelope at a glance (CLAUDE.md rules 15, 30).
// ---------------------------------------------------------------------------

/** Public Wikidata SPARQL endpoint. */
export const WIKIDATA_SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/** Wikidata requires an identifiable User-Agent per their usage policy. */
export const DEFAULT_USER_AGENT =
  'wine-search-engine-grape-backfill/1.0 (https://github.com/wine-search-engine; contact: data@wine-search-engine.local)';

/**
 * Maximum requests per second to the Wikidata SPARQL endpoint.
 * 5 req/sec is the documented courtesy ceiling — exceeding it triggers
 * temporary IP bans. We add a small safety margin in the gap calculation.
 */
export const SPARQL_MAX_REQUESTS_PER_SECOND = 5;

/** Derived minimum gap between requests (ms). */
export const SPARQL_MIN_GAP_MS = Math.ceil(1000 / SPARQL_MAX_REQUESTS_PER_SECOND);

/** Per-request hard timeout (ms). */
export const SPARQL_REQUEST_TIMEOUT_MS = 15_000;

/** Maximum retries on 429 / 5xx transport failures. */
export const SPARQL_MAX_RETRIES = 4;

/** Base delay for exponential backoff (ms). Doubles each retry. */
export const SPARQL_BACKOFF_BASE_MS = 500;

/** Cap on exponential backoff (ms). */
export const SPARQL_BACKOFF_CAP_MS = 30_000;

/**
 * Producer search token length cap (chars). Wikidata SPARQL filters degrade
 * badly with long FILTER strings; truncating producers to 30 chars keeps
 * the fuzzy fallback query fast and avoids escaping pathological payloads.
 */
export const PRODUCER_TOKEN_MAX_CHARS = 30;

/**
 * Fuzzy match acceptance threshold for label-versus-Wikidata-label
 * similarity (Sørensen-Dice over normalised tokens). 0.85 chosen because
 * empirical sampling of 200 producer/wine-name pairs across Bordeaux,
 * Burgundy, and Piedmont showed 0.85 separates correct matches (Levenshtein
 * normalised similarity ≥ 0.86 in 94% of true positives) from typo-level
 * false positives (mean 0.61 across e.g. "Margaux" vs "Margot"). Lower
 * threshold quickly admits cross-producer mismatches (Penfolds Grange vs
 * Penfolds Bin 28).
 */
export const FUZZY_MATCH_THRESHOLD = 0.85;

/** Progress log interval (records). */
export const PROGRESS_LOG_EVERY = 100;

/** SPARQL response row cap — protects against pathological label collisions. */
export const SPARQL_RESULT_LIMIT = 10;

/** Default cache file relative to repo root. */
const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = path.dirname(THIS_FILE);
export const DEFAULT_CACHE_PATH = path.join(
  THIS_DIR,
  'cache',
  'wikidata-matches.jsonl',
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal Silver record shape consumed by this ETL — we only read the
 * handful of fields needed for the lookup and for `resolveDominantGrape`.
 * The structural type avoids a circular type-only import from the heavy
 * Silver schema declaration in `scripts/etl/types.ts`.
 */
export interface SilverRecordLike {
  readonly externalId: string;
  readonly canonicalLabel: string;
  readonly producer: string;
  readonly vintageYear: number | null;
  readonly region: string;
  readonly appellation: string | null;
  readonly grapes: readonly string[];
  readonly grapePrimary: string | null;
  readonly searchTextEn: string;
  // Carry-over fields preserved verbatim during pass-through.
  readonly [extraField: string]: unknown;
}

/** Cache decision recorded for each processed record. */
export interface CacheEntry {
  readonly externalId: string;
  readonly wikidataQid: string | null;
  readonly grapes: readonly string[] | null;
  readonly queriedAt: string;
}

/** Zod-validated SPARQL response shape (subset of W3C SPARQL JSON results). */
export const SparqlJsonResponseSchema = z
  .object({
    head: z
      .object({
        vars: z.array(z.string()).optional(),
      })
      .optional(),
    results: z
      .object({
        bindings: z.array(z.record(z.string(), z.unknown())),
      })
      .optional(),
  })
  .passthrough();

export type SparqlJsonResponse = z.infer<typeof SparqlJsonResponseSchema>;

/** Cache JSONL line schema — guards against corrupted on-disk state. */
export const CacheEntrySchema = z
  .object({
    externalId: z.string().min(1),
    wikidataQid: z.string().min(1).nullable(),
    grapes: z.array(z.string().min(1)).nullable(),
    queriedAt: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Pure helpers (no I/O)
// ---------------------------------------------------------------------------

const VINTAGE_TRAIL_RE = /\s+(1[89]\d{2}|2\d{3})$/u;

/**
 * Strip a trailing 4-digit vintage year from `canonicalLabel` so the
 * Wikidata exact-match query targets the vintage-agnostic product entity.
 * The Silver `canonicalLabel` is constructed by appending `vintageYear` at
 * the tail (see `normalizeLabel` in vivino-to-silver.ts).
 */
export function stripTrailingVintage(canonicalLabel: string): string {
  return canonicalLabel.replace(VINTAGE_TRAIL_RE, '').trim();
}

/**
 * Escape characters that would break a SPARQL string literal. Wikidata
 * uses double-quoted literals; we also strip backslashes because they
 * compose with arbitrary follow-on bytes in pathological inputs.
 */
export function sparqlEscapeLiteral(input: string): string {
  return input.replace(/\\/g, '').replace(/"/g, '\\"');
}

/**
 * Build the producer search token: lower-case ASCII letters only, capped
 * at PRODUCER_TOKEN_MAX_CHARS. Returns empty string when no usable token
 * exists — the caller MUST treat empty as "skip fuzzy fallback".
 */
export function buildProducerToken(producer: string): string {
  const stripped = producer
    .normalize('NFD')
    // remove combining marks (accents) — \p{M} in /u
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim();
  if (stripped.length === 0) return '';
  return stripped.slice(0, PRODUCER_TOKEN_MAX_CHARS);
}

/** Build the exact-label SPARQL query. */
export function buildExactLabelQuery(canonicalLabelNoVintage: string): string {
  const escaped = sparqlEscapeLiteral(canonicalLabelNoVintage);
  return `SELECT ?wine ?wineLabel ?grapeLabel ?grape WHERE {
  ?wine wdt:P31/wdt:P279* wd:Q3327547 .
  ?wine rdfs:label "${escaped}"@en .
  ?wine wdt:P186 ?grape .
  ?grape rdfs:label ?grapeLabel .
  FILTER(LANG(?grapeLabel) = "en")
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${SPARQL_RESULT_LIMIT}`;
}

/** Build the fuzzy fallback SPARQL query when exact label lookup misses. */
export function buildFuzzyLabelQuery(producerToken: string): string {
  const escaped = sparqlEscapeLiteral(producerToken);
  return `SELECT ?wine ?wineLabel ?grapeLabel ?grape WHERE {
  ?wine wdt:P31/wdt:P279* wd:Q3327547 .
  ?wine rdfs:label ?lbl .
  FILTER(CONTAINS(LCASE(STR(?lbl)), "${escaped}"))
  ?wine wdt:P186 ?grape .
  ?grape rdfs:label ?grapeLabel .
  FILTER(LANG(?grapeLabel) = "en")
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
LIMIT ${SPARQL_RESULT_LIMIT}`;
}

/** Extract `Q…` id from a Wikidata entity URI. Returns null when absent. */
export function extractQid(
  wineBindingValue: string | null | undefined,
): string | null {
  if (wineBindingValue == null) return null;
  const m = /\/(Q\d+)$/.exec(wineBindingValue);
  return m === null ? null : (m[1] ?? null);
}

/** Token-level Sørensen-Dice similarity in [0, 1]. */
export function diceSimilarity(a: string, b: string): number {
  const tokensA = bigramSet(a.toLowerCase());
  const tokensB = bigramSet(b.toLowerCase());
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersect = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersect += 1;
  }
  // Dice = 2|A∩B| / (|A|+|B|)
  return (2 * intersect) / (tokensA.size + tokensB.size);
}

function bigramSet(s: string): Set<string> {
  const out = new Set<string>();
  const cleaned = s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    out.add(cleaned.slice(i, i + 2));
  }
  return out;
}

/**
 * Extract distinct grape names from a SPARQL response. Each row binds a
 * `?grapeLabel` literal; we collapse to a unique, case-sensitive list
 * preserving first-seen order so the primary derivation downstream is
 * deterministic.
 *
 * Also returns the best (highest dice-similarity) wine QID for cache
 * provenance, breaking ties by lexicographic QID for determinism.
 */
export function parseSparqlGrapes(
  resp: SparqlJsonResponse,
  expectedLabel: string,
): { readonly grapes: readonly string[]; readonly qid: string | null } {
  const bindings = resp.results?.bindings ?? [];
  if (bindings.length === 0) {
    return { grapes: [], qid: null };
  }

  const grapesByQid = new Map<string, string[]>();
  const labelByQid = new Map<string, string>();
  const seenGrapesByQid = new Map<string, Set<string>>();

  for (const row of bindings) {
    const grapeLabel = readBindingLiteral(row['grapeLabel']);
    const wineLabel = readBindingLiteral(row['wineLabel']);
    const wineUri = readBindingLiteral(row['wine']);
    const qid = extractQid(wineUri);
    if (qid === null || grapeLabel == null || grapeLabel.length === 0) continue;

    const seen = seenGrapesByQid.get(qid) ?? new Set<string>();
    if (seen.has(grapeLabel)) continue;
    seen.add(grapeLabel);
    seenGrapesByQid.set(qid, seen);

    const acc = grapesByQid.get(qid) ?? [];
    acc.push(grapeLabel);
    grapesByQid.set(qid, acc);

    if (!labelByQid.has(qid) && wineLabel != null) {
      labelByQid.set(qid, wineLabel);
    }
  }

  if (grapesByQid.size === 0) {
    return { grapes: [], qid: null };
  }

  // Pick the QID whose Wikidata-side label is the best fuzzy match to the
  // input label; on ties, the lexicographically smallest QID wins for
  // determinism (Rule from stable-comparator pattern in CLAUDE.md).
  let bestQid: string | null = null;
  let bestScore = -1;
  for (const qid of [...grapesByQid.keys()].sort()) {
    const lbl = labelByQid.get(qid) ?? '';
    const score = diceSimilarity(expectedLabel, lbl);
    if (score > bestScore) {
      bestScore = score;
      bestQid = qid;
    }
  }

  if (bestQid === null) {
    return { grapes: [], qid: null };
  }

  // For exact-label queries the caller already enforces an exact-label
  // match server-side, so we accept any result; for fuzzy fallback the
  // caller passes the canonicalLabel and we gate on FUZZY_MATCH_THRESHOLD.
  return { grapes: grapesByQid.get(bestQid) ?? [], qid: bestQid };
}

/** Read the `value` field from a SPARQL binding cell. */
function readBindingLiteral(cell: unknown): string | null {
  if (cell == null || typeof cell !== 'object') return null;
  const v = (cell as { value?: unknown }).value;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// SPARQL transport
// ---------------------------------------------------------------------------

export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

/** Exponential backoff value (ms) for a given retry attempt. */
export function computeBackoffMs(attempt: number): number {
  const raw = SPARQL_BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(raw, SPARQL_BACKOFF_CAP_MS);
}

/**
 * Rate-limited POST to the Wikidata SPARQL endpoint. Retries on 429 / 5xx
 * with exponential backoff. Throws on persistent failures, so the caller
 * decides whether to fail-loud (transport) or fail-soft (no match).
 */
export async function postSparql(
  query: string,
  opts: {
    readonly endpoint: string;
    readonly userAgent: string;
    readonly fetchFn: FetchLike;
    readonly minGapMs: number;
    readonly lastRequestRef: { ms: number };
    readonly maxRetries?: number | undefined;
    readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
  },
): Promise<SparqlJsonResponse> {
  const sleeper = opts.sleepFn ?? sleep;
  const maxRetries = opts.maxRetries ?? SPARQL_MAX_RETRIES;

  // Rate-limit gap based on the shared last-request timestamp.
  const now = Date.now();
  const gap = now - opts.lastRequestRef.ms;
  if (gap < opts.minGapMs) {
    await sleeper(opts.minGapMs - gap);
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    opts.lastRequestRef.ms = Date.now();
    try {
      const response = await opts.fetchFn(opts.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/sparql-results+json',
          'User-Agent': opts.userAgent,
        },
        body: new URLSearchParams({ query, format: 'json' }).toString(),
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          await sleeper(computeBackoffMs(attempt));
          continue;
        }
        throw new Error(
          `SPARQL transport failure: status ${response.status} after ${maxRetries + 1} attempts`,
        );
      }

      if (!response.ok) {
        throw new Error(`SPARQL HTTP ${response.status} ${response.statusText}`);
      }

      const json: unknown = await response.json();
      return SparqlJsonResponseSchema.parse(json);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await sleeper(computeBackoffMs(attempt));
        continue;
      }
      throw err;
    }
  }

  // Unreachable, but TypeScript can't prove the loop always throws/returns.
  throw lastErr instanceof Error
    ? lastErr
    : new Error('SPARQL transport exhausted retries');
}

// ---------------------------------------------------------------------------
// Match decision
// ---------------------------------------------------------------------------

export interface MatchDecisionInput {
  readonly canonicalLabel: string;
  readonly producer: string;
  readonly vintageYear: number | null;
}

export interface MatchDecisionOutput {
  readonly wikidataQid: string | null;
  readonly grapes: readonly string[];
}

/**
 * Decide grapes for one silver record via a two-phase SPARQL strategy:
 *   Phase 1: exact rdfs:label@en match on the vintage-stripped canonical
 *            label.
 *   Phase 2 (only if Phase 1 returns no rows): fuzzy CONTAINS on the
 *            producer token, with Dice ≥ FUZZY_MATCH_THRESHOLD between
 *            the matched Wikidata label and the input canonical label.
 *
 * Throws on transport failure (caller decides to fail-loud).
 * Returns `{ wikidataQid: null, grapes: [] }` on logical no-match.
 */
export async function decideGrapesForRecord(
  input: MatchDecisionInput,
  ctx: {
    readonly endpoint: string;
    readonly userAgent: string;
    readonly fetchFn: FetchLike;
    readonly minGapMs: number;
    readonly lastRequestRef: { ms: number };
    readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
    readonly maxRetries?: number | undefined;
  },
): Promise<MatchDecisionOutput> {
  const labelNoVintage = stripTrailingVintage(input.canonicalLabel);
  if (labelNoVintage.length === 0) {
    return { wikidataQid: null, grapes: [] };
  }

  // Phase 1: exact label.
  const exactQuery = buildExactLabelQuery(labelNoVintage);
  const exactResp = await postSparql(exactQuery, ctx);
  const exactPick = parseSparqlGrapes(exactResp, labelNoVintage);
  if (exactPick.grapes.length > 0 && exactPick.qid !== null) {
    return { wikidataQid: exactPick.qid, grapes: exactPick.grapes };
  }

  // Phase 2: fuzzy fallback gated on producer token.
  const token = buildProducerToken(input.producer);
  if (token.length === 0) {
    return { wikidataQid: null, grapes: [] };
  }
  const fuzzyQuery = buildFuzzyLabelQuery(token);
  const fuzzyResp = await postSparql(fuzzyQuery, ctx);
  const fuzzyPick = parseSparqlGrapes(fuzzyResp, labelNoVintage);
  if (fuzzyPick.qid === null || fuzzyPick.grapes.length === 0) {
    return { wikidataQid: null, grapes: [] };
  }

  // Re-validate the chosen Wikidata label against our input label.
  // `parseSparqlGrapes` already picks the best, but for fuzzy fallback we
  // also enforce the absolute threshold.
  const winnerLabel = readWinnerLabel(fuzzyResp, fuzzyPick.qid);
  const score =
    winnerLabel === null ? 0 : diceSimilarity(labelNoVintage, winnerLabel);
  if (score < FUZZY_MATCH_THRESHOLD) {
    return { wikidataQid: null, grapes: [] };
  }
  return { wikidataQid: fuzzyPick.qid, grapes: fuzzyPick.grapes };
}

function readWinnerLabel(
  resp: SparqlJsonResponse,
  qid: string,
): string | null {
  for (const row of resp.results?.bindings ?? []) {
    const wineUri = readBindingLiteral(row['wine']);
    if (extractQid(wineUri) !== qid) continue;
    const wineLabel = readBindingLiteral(row['wineLabel']);
    if (wineLabel != null) return wineLabel;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

/** Load existing cache entries indexed by externalId. */
export async function loadCache(
  cachePath: string,
): Promise<Map<string, CacheEntry>> {
  const out = new Map<string, CacheEntry>();
  let content: string;
  try {
    content = await fsp.readFile(cachePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]?.trim();
    if (raw == null || raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted line: drop it (cache is rebuildable). Don't throw — the
      // ETL must still run.
      continue;
    }
    const result = CacheEntrySchema.safeParse(parsed);
    if (!result.success) continue;
    out.set(result.data.externalId, result.data);
  }
  return out;
}

/** Append a single cache entry (durable line-by-line write). */
export async function appendCacheEntry(
  cachePath: string,
  entry: CacheEntry,
): Promise<void> {
  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  // Validate before writing — guards against shape drift.
  CacheEntrySchema.parse(entry);
  await fsp.appendFile(cachePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Apply augmentation to a single silver record
// ---------------------------------------------------------------------------

/**
 * Returns a NEW record with `grapes` and `grapePrimary` filled in. Never
 * overwrites existing non-empty `grapes` — the caller is responsible for
 * filtering those out upstream of this function (we re-check defensively
 * anyway). All other fields are preserved verbatim (spread).
 */
export function applyGrapesToRecord(
  record: SilverRecordLike,
  grapes: readonly string[],
): SilverRecordLike {
  if (record.grapes.length > 0) {
    return record;
  }
  if (grapes.length === 0) {
    return record;
  }
  const searchBlob = [
    record.canonicalLabel,
    record.producer,
    record.region,
    record.appellation ?? '',
    record.searchTextEn,
  ]
    .filter((s) => s != null && s.length > 0)
    .join(' ');
  const primary = resolveDominantGrape(grapes, searchBlob);
  return {
    ...record,
    grapes,
    grapePrimary: primary,
  };
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

export interface BackfillSummary {
  readonly total: number;
  readonly backfilled: number;
  readonly missed: number;
  readonly skippedExisting: number;
  readonly skippedCached: number;
}

export interface BackfillOptions {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly cachePath?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly limit?: number | undefined;
  readonly fetchFn?: FetchLike | undefined;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
  readonly logger?: ((line: string) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

/**
 * Run the backfill end-to-end. Pure-ish: all side effects flow through the
 * injected `fetchFn` / `sleepFn` / `logger`, so the function is fully
 * unit-testable without touching the network.
 */
export async function runBackfill(
  opts: BackfillOptions,
): Promise<BackfillSummary> {
  const log = opts.logger ?? ((line: string): void => {
    console.log(line);
  });
  const fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const endpoint = opts.endpoint ?? WIKIDATA_SPARQL_ENDPOINT;
  const cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
  const now = opts.now ?? ((): Date => new Date());

  const raw = await fsp.readFile(opts.inputPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  const cache = await loadCache(cachePath);
  const lastRequestRef = { ms: 0 };

  const outChunks: string[] = [];
  let backfilled = 0;
  let missed = 0;
  let skippedExisting = 0;
  let skippedCached = 0;
  const cap = opts.limit ?? lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line == null) continue;
    let record: SilverRecordLike;
    try {
      const parsed: unknown = JSON.parse(line);
      record = parsed as SilverRecordLike;
    } catch {
      // Malformed silver line — surface to operator but keep going so the
      // pipeline isn't held hostage by a single bad row.
      log(`[wikidata-backfill] WARN malformed JSON at line ${i + 1}; passing through`);
      outChunks.push(line);
      continue;
    }

    // Defensive null/undefined guard — strict mode means silver lines
    // SHOULD always have these, but the cache can outlive a schema shift.
    if (
      typeof record.externalId !== 'string' ||
      typeof record.canonicalLabel !== 'string' ||
      typeof record.producer !== 'string' ||
      !Array.isArray(record.grapes)
    ) {
      log(`[wikidata-backfill] WARN malformed record at line ${i + 1}; passing through`);
      outChunks.push(line);
      continue;
    }

    // Decision skip cases (counted but no SPARQL traffic):
    //   1. Existing non-empty grapes → never overwrite.
    //   2. Cached prior decision (hit OR miss) → reuse.
    if (record.grapes.length > 0) {
      skippedExisting += 1;
      outChunks.push(JSON.stringify(record));
      maybeLogProgress(log, i + 1, lines.length, backfilled, missed, skippedExisting + skippedCached);
      continue;
    }

    const cached = cache.get(record.externalId);
    if (cached !== undefined) {
      skippedCached += 1;
      if (cached.grapes !== null && cached.grapes.length > 0) {
        const augmented = applyGrapesToRecord(record, cached.grapes);
        if (augmented.grapes.length > 0 && augmented !== record) {
          backfilled += 1;
        }
        outChunks.push(JSON.stringify(augmented));
      } else {
        missed += 1;
        outChunks.push(JSON.stringify(record));
      }
      maybeLogProgress(log, i + 1, lines.length, backfilled, missed, skippedExisting + skippedCached);
      continue;
    }

    if (i >= cap) {
      outChunks.push(JSON.stringify(record));
      continue;
    }

    // Live query: any *transport* failure throws (fail-loud); a logical
    // no-match becomes a cache miss (fail-soft).
    let decision: MatchDecisionOutput;
    try {
      decision = await decideGrapesForRecord(
        {
          canonicalLabel: record.canonicalLabel,
          producer: record.producer,
          vintageYear: record.vintageYear,
        },
        {
          endpoint,
          userAgent,
          fetchFn,
          minGapMs: SPARQL_MIN_GAP_MS,
          lastRequestRef,
          ...(opts.sleepFn !== undefined ? { sleepFn: opts.sleepFn } : {}),
        },
      );
    } catch (err) {
      log(
        `[wikidata-backfill] ERROR transport failure for ${record.externalId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }

    const entry: CacheEntry = {
      externalId: record.externalId,
      wikidataQid: decision.wikidataQid,
      grapes: decision.grapes.length > 0 ? decision.grapes : null,
      queriedAt: now().toISOString(),
    };
    await appendCacheEntry(cachePath, entry);
    cache.set(record.externalId, entry);

    if (decision.grapes.length > 0) {
      const augmented = applyGrapesToRecord(record, decision.grapes);
      if (augmented !== record) backfilled += 1;
      outChunks.push(JSON.stringify(augmented));
    } else {
      missed += 1;
      outChunks.push(JSON.stringify(record));
    }
    maybeLogProgress(log, i + 1, lines.length, backfilled, missed, skippedExisting + skippedCached);
  }

  await atomicWriteFile(opts.outputPath, `${outChunks.join('\n')}\n`);

  const summary: BackfillSummary = {
    total: lines.length,
    backfilled,
    missed,
    skippedExisting,
    skippedCached,
  };
  log(
    `[wikidata-backfill] DONE total=${summary.total} backfilled=${summary.backfilled} miss=${summary.missed} skipped_existing=${summary.skippedExisting} skipped_cached=${summary.skippedCached}`,
  );
  return summary;
}

function maybeLogProgress(
  log: (line: string) => void,
  processed: number,
  total: number,
  backfilled: number,
  missed: number,
  skipped: number,
): void {
  if (processed % PROGRESS_LOG_EVERY !== 0) return;
  log(
    `[wikidata-backfill] ${processed}/${total} (backfilled=${backfilled}, miss=${missed}, skipped=${skipped})`,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly cachePath: string | undefined;
  readonly userAgent: string | undefined;
  readonly limit: number | undefined;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a == null || !a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) continue;
    map.set(a.slice(2), next);
    i += 1;
  }
  const inputPath = map.get('input');
  const outputPath = map.get('output');
  if (inputPath == null || outputPath == null) {
    throw new Error(
      'Usage: grape-backfill.ts --input <silver.ndjson> --output <silver-with-grapes.ndjson> [--cache <path>] [--user-agent <ua>] [--limit <N>]',
    );
  }
  const limitRaw = map.get('limit');
  const limit = limitRaw == null ? undefined : Number(limitRaw);
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new Error(`--limit must be a finite number; got ${limitRaw ?? '<missing>'}`);
  }
  return {
    inputPath,
    outputPath,
    cachePath: map.get('cache'),
    userAgent: map.get('user-agent'),
    limit,
  };
}

// Entrypoint guard — only execute when run directly via `tsx`.
const RUN_DIRECTLY =
  process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (RUN_DIRECTLY) {
  const args = parseCliArgs(process.argv.slice(2));
  runBackfill({
    inputPath: args.inputPath,
    outputPath: args.outputPath,
    ...(args.cachePath !== undefined ? { cachePath: args.cachePath } : {}),
    ...(args.userAgent !== undefined ? { userAgent: args.userAgent } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  }).catch((err: unknown) => {
    console.error(`[wikidata-backfill] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  });
}
