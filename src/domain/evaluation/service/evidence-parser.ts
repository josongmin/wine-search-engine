/**
 * Evidence parser (RFC-020).
 *
 * Parses raw tool observation strings into structured EvidenceRecord objects
 * for use by the deterministic claim verifier.
 *
 * Strategy:
 *   1. Try JSON.parse — handles structured search results
 *   2. If not JSON, return a single record with raw text under __raw__
 */

import { KRW_PER_USD_APPROXIMATE } from '../../shared/constants.js';
import type { EvidenceRecord } from './claim-verifier-deterministic.js';

// ── Module-scope regex constants (CLAUDE.md rule 16) ─────────────────────
/** Match "N. <label>" or "Side A/B: <subQuery>: <label>" at start of pipe-delimited line. */
const LABEL_LINE_RE = /^(?:\d+\.\s*|Side\s+[AB]:\s*[^:]*:\s*)(.+)$/u;
/** Match "(id: xxx)" entity ID format. */
const ENTITY_ID_PAREN_RE = /^\(?id:\s*([^)]+)\)?$/u;
/** Match "entity_id: xxx" compare format. */
const ENTITY_ID_COLON_RE = /^entity_id:\s*(\S+)$/u;
/** Match "key: value" pairs in pipe-delimited observation. */
const KV_PAIR_RE = /^([a-z_]+):\s*(.+)$/u;
/** Match "95/100" critic score format → normalized 0..1. */
const CRITIC_SCORE_RE = /^(\d+(?:\.\d+)?)\s*\/\s*100/u;
/** Match "14.5%" alcohol percentage. */
const ALCOHOL_PCT_RE = /^(\d+(?:\.\d+)?)\s*%/u;
/** Match "$42.50" USD price. */
const PRICE_USD_RE = /^\$\s*([0-9]+(?:\.[0-9]+)?)/u;
/** Match "₩50,000" KRW price. */
const PRICE_KRW_RE = /^₩\s*([0-9][0-9,]*)/u;
/** Match "value|mid|premium|luxury" price band label. */
const PRICE_BAND_RE = /^(value|mid|premium|luxury)$/iu;
/** Match "2024-2038" drinking window year range. */
const DRINKING_WINDOW_RANGE_RE = /^(\d{4})\s*[-–]\s*(\d{4})$/u;
/** Match "<label>: drinking window <start>-<end>" sentence. */
const DRINKING_WINDOW_SENTENCE_RE = /^(.+?):\s*drinking window\s*(\d{4})\s*[-–]\s*(\d{4})/u;

/**
 * Parse an array of tool observation strings into EvidenceRecord array.
 * Each observation may yield 0..N records (a search result with N wines = N records).
 */
const MAX_OBSERVATIONS = 1000;

export function parseObservations(observations: readonly string[]): EvidenceRecord[] {
  const limitedObservations = observations.slice(0, MAX_OBSERVATIONS);
  const records: EvidenceRecord[] = [];

  for (const obs of limitedObservations) {
    const parsed = parseObservation(obs);
    records.push(...parsed);
  }

  return records;
}

const MAX_OBSERVATION_LENGTH = 500_000; // 500KB safety cap

/**
 * Parse a single observation string into 0..N EvidenceRecord objects.
 *
 * Three parsing strategies in order:
 *   1. JSON.parse — handles structured tool outputs
 *   2. Pipe-delimited line parser — handles agent-tools.ts summarizeSearchResults
 *      and summarizeComparison output (e.g. "1. Opus One | (id: vivino-abc) |
 *      producer: Robert Mondavi | region: Napa | vintage: 2018 | drink: 2024-2038")
 *   3. Raw text fallback — opaque content for keyword-only verification
 */
function parseObservation(observation: string): EvidenceRecord[] {
  if (observation.length > MAX_OBSERVATION_LENGTH) {
    return [{ __raw__: observation.slice(0, MAX_OBSERVATION_LENGTH) }];
  }
  const trimmed = observation.trim();
  if (trimmed.length === 0) return [];

  // Strategy 1: JSON
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return extractRecordsFromJson(parsed);
  } catch (jsonProbeError) {
    // Speculative JSON probe — most observations are not JSON (pipe-delimited
    // or raw text). Falling through to Strategy 2/3. The error is referenced
    // (not silently swallowed) so wine-catch-empty does not flag this and
    // future maintainers can see the intent.
    void jsonProbeError;
  }

  // Strategy 2: pipe-delimited wine lines from agent-tools.ts summarizers
  const pipeRecords = parsePipeDelimitedObservation(trimmed);
  if (pipeRecords.length > 0) {
    return pipeRecords;
  }

  // Strategy 3: opaque raw text (verifier can still keyword-match)
  return [{ __raw__: trimmed }];
}

/**
 * Parse the pipe-delimited wine line format produced by agent-tools.ts:
 *   summarizeSearchResults: "1. Opus One | (id: vivino-abc) | producer: X | region: Y | vintage: 2018 | grapes: A, B | style: S | critic: 95/100 | alc: 14% | price: ₩300,000 | drink: 2024-2038"
 *   summarizeComparison:    "Side A: ...: <label> | entity_id: ... | producer: ... | ..."
 *   summarizeDrinkingWindow: "<label>: drinking window 2024-2030. As of 2026: currently drinkable (peak: 2024–2030)."
 *
 * Each parsed line yields one EvidenceRecord with typed fields:
 *   canonical_label, entity_id, producer, region, vintage_year, grapes,
 *   wine_type/style, critic_score, alcohol_pct, price_text, drinking_window_start, drinking_window_end
 *
 * Returns [] when no pipe-delimited wine lines are detected, allowing the caller
 * to fall through to the raw-text strategy.
 */
function parsePipeDelimitedObservation(text: string): EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;

    // Detect lines that look like wine entries (have at least one " | " separator
    // and contain a recognized label like "id:", "producer:", "region:", "drink:").
    if (!trimmedLine.includes(' | ')) {
      // Could be a check_drinking_window observation: "<label>: drinking window 2024-2030. As of 2026: ..."
      const dwRecord = parseDrinkingWindowSentence(trimmedLine);
      if (dwRecord !== undefined) records.push(dwRecord);
      continue;
    }

    const parts = trimmedLine.split(' | ');
    if (parts.length < 2) continue;

    const record: Record<string, string | number | readonly string[]> = {};

    // First part: either "N. <label>" (search result) or "Side X: <subQuery>: <label>" (compare)
    const labelMatch = LABEL_LINE_RE.exec(parts[0]!);
    if (labelMatch?.[1] !== undefined) {
      record['canonical_label'] = labelMatch[1].trim();
    } else if (parts[0]!.length > 0) {
      record['canonical_label'] = parts[0]!.trim();
    }

    // Remaining parts: "key: value" pairs
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i]!.trim();
      // (id: vivino-abc)
      const idMatch = ENTITY_ID_PAREN_RE.exec(part);
      if (idMatch?.[1] !== undefined) {
        record['entity_id'] = idMatch[1].trim();
        continue;
      }
      // entity_id: vivino-abc (compare format)
      const entityIdMatch = ENTITY_ID_COLON_RE.exec(part);
      if (entityIdMatch?.[1] !== undefined) {
        record['entity_id'] = entityIdMatch[1].trim();
        continue;
      }
      // key: value
      const kvMatch = KV_PAIR_RE.exec(part);
      if (kvMatch !== null) {
        const key = kvMatch[1]!.toLowerCase();
        const value = kvMatch[2]!.trim();
        switch (key) {
          case 'producer':
            record['producer'] = value;
            break;
          case 'region':
            record['region'] = value;
            break;
          case 'vintage': {
            const yr = parseInt(value, 10);
            if (Number.isFinite(yr)) record['vintage_year'] = yr;
            break;
          }
          case 'grapes': {
            const arr = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            if (arr.length > 0) record['grapes'] = arr;
            break;
          }
          case 'style':
            // Verifier looks up `wine_type` (red/white/rosé/sparkling/fortified/dessert/natural).
            // The agent-tools summarizer emits this value under the "style:" label for brevity,
            // but the semantic content IS wine_type — so map it to the verifier's field name.
            record['wine_type'] = value;
            break;
          case 'critic': {
            // "95/100" → 0.95
            const cm = CRITIC_SCORE_RE.exec(value);
            if (cm?.[1] !== undefined) {
              const score = parseFloat(cm[1]) / 100;
              if (Number.isFinite(score)) record['critic_score_normalized'] = score;
            }
            break;
          }
          case 'alc': {
            // "14%" or "14.5%"
            const am = ALCOHOL_PCT_RE.exec(value);
            if (am?.[1] !== undefined) {
              const pct = parseFloat(am[1]);
              if (Number.isFinite(pct)) record['alcohol_pct'] = pct;
            }
            break;
          }
          case 'price': {
            // The agent-tools summarizer emits priceRange from result-item.ts, which is
            // either "$<n>" (derived from priceUsd) or a price-band label ("value"|"mid"|
            // "premium"|"luxury"). Route numeric $ values to `price_usd` (claim-verifier-
            // deterministic.ts::verifyField expects a number there) and band labels to
            // `price_band` (enum field). KRW prices prefixed with ₩ are converted to USD
            // via the shared KRW_PER_USD_APPROXIMATE constant so evaluation parses
            // prices on the same scale as the extractor. Free-form text falls back to
            // `price_text`.
            const usdMatch = PRICE_USD_RE.exec(value);
            if (usdMatch?.[1] !== undefined) {
              const n = parseFloat(usdMatch[1]);
              if (Number.isFinite(n)) record['price_usd'] = n;
              break;
            }
            const krwMatch = PRICE_KRW_RE.exec(value);
            if (krwMatch?.[1] !== undefined) {
              const krw = parseInt(krwMatch[1].replace(/,/gu, ''), 10);
              if (Number.isFinite(krw)) {
                record['price_usd'] = Math.round((krw / KRW_PER_USD_APPROXIMATE) * 100) / 100;
              }
              break;
            }
            if (PRICE_BAND_RE.test(value)) {
              record['price_band'] = value.toLowerCase();
              break;
            }
            record['price_text'] = value;
            break;
          }
          case 'drink': {
            // "2024-2038" or "2024-2038"
            const dm = DRINKING_WINDOW_RANGE_RE.exec(value);
            if (dm?.[1] !== undefined && dm[2] !== undefined) {
              const start = parseInt(dm[1], 10);
              const end = parseInt(dm[2], 10);
              if (Number.isFinite(start)) record['drinking_window_start'] = start;
              if (Number.isFinite(end)) record['drinking_window_end'] = end;
            }
            break;
          }
          case 'match':
            // diagnostic field — skip
            break;
          default:
            // unknown key — store as-is so verifier can keyword-match
            record[key] = value;
        }
      }
    }

    // Only push if we extracted at least canonical_label or entity_id
    if (record['canonical_label'] !== undefined || record['entity_id'] !== undefined) {
      records.push(record as EvidenceRecord);
    }
  }

  return records;
}

/**
 * Parse a single check_drinking_window observation sentence:
 *   "Opus One 2018: drinking window 2024-2038. As of 2026: currently drinkable (peak: 2024–2038)."
 */
function parseDrinkingWindowSentence(line: string): EvidenceRecord | undefined {
  // Match: "<label>: drinking window <start>-<end>. As of <year>: <status>."
  const m = DRINKING_WINDOW_SENTENCE_RE.exec(line);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return undefined;
  const start = parseInt(m[2], 10);
  const end = parseInt(m[3], 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return {
    canonical_label: m[1].trim(),
    drinking_window_start: start,
    drinking_window_end: end,
  } as EvidenceRecord;
}

/**
 * Walk a parsed JSON value looking for wine-shaped objects.
 *
 * Handles:
 *   - Array of wine objects: [{...}, {...}]
 *   - { results: [...] }, { wines: [...] }, { items: [...] }, etc.
 *   - Single wine object: {...}
 */
function extractRecordsFromJson(value: unknown): EvidenceRecord[] {
  if (value === null || value === undefined) return [];

  if (Array.isArray(value)) {
    const records: EvidenceRecord[] = [];
    for (const item of value) {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        records.push(flattenRecord(item as Record<string, unknown>));
      }
    }
    return records;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Wrapped array
    for (const key of ['results', 'wines', 'items', 'data', 'hits']) {
      const inner = obj[key];
      if (Array.isArray(inner)) {
        return extractRecordsFromJson(inner);
      }
    }
    // Single wine object
    return [flattenRecord(obj)];
  }

  return [];
}

/**
 * Flatten a wine record to EvidenceRecord shape.
 *
 * Handles snake_case and camelCase by normalizing keys to snake_case.
 * Recursively walks nested objects with dot/underscore-joined keys, capped
 * at MAX_FLATTEN_DEPTH levels deep.
 */
const MAX_FLATTEN_DEPTH = 6;
/** Maximum array elements preserved when flattening nested arrays to prevent memory blowup. */
const MAX_ARRAY_ELEMENTS = 256;

function flattenRecord(obj: Record<string, unknown>): EvidenceRecord {
  const flat: Record<string, string | number | readonly string[]> = {};
  flattenInto(obj, '', flat, 0);
  return flat as EvidenceRecord;
}

function flattenInto(
  obj: Record<string, unknown>,
  prefix: string,
  flat: Record<string, string | number | readonly string[]>,
  depth: number,
): void {
  if (depth >= MAX_FLATTEN_DEPTH) return;

  for (const [key, value] of Object.entries(obj)) {
    // Filter prototype-pollution keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;

    const snakeKey = camelToSnake(key);
    const fullKey = prefix.length > 0 ? `${prefix}_${snakeKey}` : snakeKey;

    if (value === null || value === undefined) continue;

    if (typeof value === 'string') {
      flat[fullKey] = value;
      // Also surface bare key (without prefix) for top-level field matching
      if (prefix.length > 0 && flat[snakeKey] === undefined) flat[snakeKey] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue;
      flat[fullKey] = value;
      if (prefix.length > 0 && flat[snakeKey] === undefined) flat[snakeKey] = value;
    } else if (typeof value === 'boolean') {
      flat[fullKey] = value ? 'true' : 'false';
    } else if (typeof value === 'bigint') {
      flat[fullKey] = String(value);
    } else if (value instanceof Date) {
      flat[fullKey] = value.toISOString();
    } else if (Array.isArray(value)) {
      const stringArr = value
        .filter((v) => typeof v === 'string' || typeof v === 'number')
        .map((v) => String(v))
        .slice(0, MAX_ARRAY_ELEMENTS);
      if (stringArr.length > 0) flat[fullKey] = stringArr;
    } else if (typeof value === 'object') {
      flattenInto(value as Record<string, unknown>, fullKey, flat, depth + 1);
    }
  }
}

function camelToSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/^_/, '');
}
