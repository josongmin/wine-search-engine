#!/usr/bin/env tsx

/**
 * Track C Step 7: Beginner Suitability Scoring
 *
 * LLM teacher-labeled beginner-friendliness score for each wine entity.
 * Output: beginnerSuitabilityClassification on EnrichedSilverRecord.
 *
 * Score range: [0, 1] (LLM outputs 0-100, normalized by dividing by 100).
 * Evidence-backed: every score carries a snippet + rationale from catalog data.
 * Ontology version-gated: fingerprint includes model, prompt version, and input hash.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import {
  BEGINNER_SUITABILITY_VERSION,
} from '../../src/domain/attribute/service/ontology-normalizer.js';
import { parseNdjson } from './ndjson.js';
import type {
  EnrichedSilverRecord,
  BeginnerSuitabilityClassification,
} from './types.js';
import { atomicWriteFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

export const DATA_FILE = ETL_ARTIFACT_FILES.trackc;
const OPENAI_BASE_URL = (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env['OPENAI_BEGINNER_MODEL'] ?? 'gpt-5.4-mini';
const PROMPT_VERSION = 'beginner-suitability-scorer-v2';
const BATCH_SIZE = 20;
/** LLM score normalization divisor: LLM outputs 0-100, we store [0, 1]. */
const LLM_SCORE_SCALE = 100;

// ---------------------------------------------------------------------------
// LLM response shape
// ---------------------------------------------------------------------------

interface BeginnerScoreResponse {
  readonly score?: number | string;
  readonly evidence_axes?: readonly string[];
  readonly snippet?: string;
  readonly rationale?: string;
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

function fingerprintMaterial(record: EnrichedSilverRecord): string {
  return [
    record.canonicalLabel,
    record.producer,
    record.wineType,
    record.priceBand ?? '',
    String(record.body ?? ''),
    String(record.sweetness ?? ''),
    String(record.acidity ?? ''),
    String(record.tannin ?? ''),
    String(record.alcoholPct ?? ''),
    record.grapePrimary ?? '',
    record.flavorProfiles.join('|'),
    record.searchTextEn,
  ].join('\n');
}

function contentHash(record: EnrichedSilverRecord): string {
  return crypto.createHash('sha256').update(fingerprintMaterial(record)).digest('hex');
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const BEGINNER_SUITABILITY_SYSTEM_PROMPT = [
  'You are a wine beginner-friendliness scoring expert. Score wines based on explicit catalog evidence only.',
  'Use only evidence present in the supplied fields; do not invent accessibility from grape fame or price tier.',
  'Ground the score in explicit evidence axes such as body, sweetness, acidity, tannin, alcohol percentage, grape_primary,',
  'flavor-profile language, wine type, and search text.',
  'Do NOT treat sweetness, grape familiarity, or wine type as stand-alone proxies; only use them when the catalog explicitly supports them.',
  'If the catalog evidence is thin, stay conservative and say so.',
  'Do NOT hallucinate facts not present in the catalog data.',
].join(' ');

export function buildBeginnerSuitabilityUserPrompt(record: EnrichedSilverRecord): string {
  return [
    'Score this wine\'s beginner-friendliness on 0-100.',
    'Return JSON: {"score": N, "evidence_axes": ["body", "sweetness"], "snippet": "evidence from catalog data", "rationale": "why this score"}',
    'If evidence is insufficient, return a conservative score grounded in the available evidence and keep evidence_axes empty if no explicit axis is supported.',
    '',
    `canonical_label: ${record.canonicalLabel}`,
    `producer: ${record.producer}`,
    `wine_type: ${record.wineType}`,
    `body: ${String(record.body ?? '')}`,
    `sweetness: ${String(record.sweetness ?? '')}`,
    `acidity: ${String(record.acidity ?? '')}`,
    `tannin: ${String(record.tannin ?? '')}`,
    `alcohol_pct: ${String(record.alcoholPct ?? '')}`,
    `grape_primary: ${record.grapePrimary ?? ''}`,
    `flavor_profiles: ${record.flavorProfiles.join(', ')}`,
    `search_text_en: ${record.searchTextEn}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// LLM call + validation
// ---------------------------------------------------------------------------

/** Max retries for transient API errors (502, 429, 503). */
const MAX_RETRIES = 3;
/** Base delay in ms for exponential backoff. */
const RETRY_BASE_DELAY_MS = 2000;

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);
    if (response.ok) return response;
    const retryable = response.status === 429 || response.status === 502 || response.status === 503;
    if (!retryable || attempt === MAX_RETRIES) {
      const text = await response.text().catch(() => '');
      throw new Error(`Beginner suitability scorer HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const delay = RETRY_BASE_DELAY_MS * (2 ** attempt);
    console.log(`    Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (HTTP ${response.status})`);
    await new Promise((resolve) => { setTimeout(resolve, delay); });
  }
  throw new Error('fetchWithRetry: unreachable');
}

async function scoreBeginnerSuitability(record: EnrichedSilverRecord): Promise<BeginnerSuitabilityClassification | undefined> {
  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for beginner suitability scoring');
  }

  const response = await fetchWithRetry(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: BEGINNER_SUITABILITY_SYSTEM_PROMPT },
        { role: 'user', content: buildBeginnerSuitabilityUserPrompt(record) },
      ],
    }),
  });

  const json = await response.json() as {
    choices?: readonly { message?: { content?: string | null } }[];
  };
  const rawContent = json.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return undefined;
  }

  let parsed: BeginnerScoreResponse;
  try {
    const rawParsed: unknown = JSON.parse(rawContent);
    if (typeof rawParsed !== 'object' || rawParsed === null) return undefined;
    parsed = rawParsed as BeginnerScoreResponse;
  } catch {
    return undefined;
  }
  const evidenceAxes = Array.isArray(parsed.evidence_axes)
    ? parsed.evidence_axes
      .filter((axis): axis is string => typeof axis === 'string' && axis.trim().length > 0)
      .map((axis) => axis.trim())
    : undefined;

  // Accept both number and string for score (LLMs routinely emit "75" instead of 75)
  const rawScore = typeof parsed.score === 'string' ? parseFloat(parsed.score) : parsed.score;
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore) || rawScore < 0 || rawScore > LLM_SCORE_SCALE) {
    return undefined;
  }

  const snippet = parsed.snippet;
  const rationale = parsed.rationale;
  if (typeof snippet !== 'string' || snippet.trim().length === 0) {
    return undefined;
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    return undefined;
  }

  return {
    score: rawScore / LLM_SCORE_SCALE,
    fingerprint: {
      modelId: MODEL,
      contentHash: contentHash(record),
      version: BEGINNER_SUITABILITY_VERSION,
      generatedAt: new Date().toISOString(),
    },
    provenance: {
      source: 'llm_beginner_suitability_scorer',
      promptVersion: PROMPT_VERSION,
      ...(evidenceAxes !== undefined ? { evidenceAxes } : {}),
      snippet: snippet.trim(),
      rationale: rationale.trim(),
    },
  };
}

// ---------------------------------------------------------------------------
// Freshness check
// ---------------------------------------------------------------------------

function isFresh(record: EnrichedSilverRecord): boolean {
  const existing = record.beginnerSuitabilityClassification;
  if (existing === undefined) return false;
  return (
    existing.fingerprint.modelId === MODEL
    && existing.fingerprint.version === BEGINNER_SUITABILITY_VERSION
    && existing.fingerprint.contentHash === contentHash(record)
    && existing.provenance.promptVersion === PROMPT_VERSION
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const records = parseNdjson<EnrichedSilverRecord>(raw, DATA_FILE).records;
  const output: EnrichedSilverRecord[] = [];

  for (let index = 0; index < records.length; index += BATCH_SIZE) {
    const batch = records.slice(index, index + BATCH_SIZE);
    const scored = await Promise.all(
      batch.map(async (record) => {
        if (isFresh(record)) {
          return { record } as const;
        }
        const classification = await scoreBeginnerSuitability(record);
        if (classification === undefined) {
          return { failedSourceId: record.sourceId } as const;
        }
        return {
          record: {
            ...record,
            beginnerSuitabilityClassification: classification,
          } satisfies EnrichedSilverRecord,
        } as const;
      }),
    );
    const failedSourceIds = scored
      .flatMap((result) => ('failedSourceId' in result ? [result.failedSourceId] : []));
    if (failedSourceIds.length > 0) {
      const preview = failedSourceIds.slice(0, 10).join(', ');
      throw new Error(
        `Beginner suitability scoring produced no classification for ${failedSourceIds.length} record(s): ${preview}`,
      );
    }
    output.push(...scored.flatMap((result) => ('record' in result ? [result.record] : [])));
    console.log(`  Beginner suitability scoring: ${Math.min(index + batch.length, records.length)}/${records.length}`);
  }

  await atomicWriteFile(
    DATA_FILE,
    `${output.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
}

// CLI entrypoint guard
import { fileURLToPath as _fileURLToPath } from 'node:url';
const _invokedAsMain = process.argv[1] != null
  && _fileURLToPath(import.meta.url) === process.argv[1];
if (_invokedAsMain) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
