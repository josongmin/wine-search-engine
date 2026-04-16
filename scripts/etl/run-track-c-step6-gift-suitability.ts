#!/usr/bin/env tsx

/**
 * Track C Step 6: Gift Suitability Scoring
 *
 * LLM teacher-labeled gift suitability score for each wine entity.
 * Output: giftSuitabilityClassification on EnrichedSilverRecord.
 *
 * Score range: [0, 1] (LLM outputs 0-100, normalized by dividing by 100).
 * Evidence-backed: every score carries a snippet + rationale from catalog data.
 * Ontology version-gated: fingerprint includes model, prompt version, and input hash.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import {
  GIFT_SUITABILITY_VERSION,
} from '../../src/domain/attribute/service/ontology-normalizer.js';
import { parseNdjson } from './ndjson.js';
import type {
  EnrichedSilverRecord,
  GiftSuitabilityClassification,
} from './types.js';
import { atomicWriteFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

export const DATA_FILE = ETL_ARTIFACT_FILES.trackc;
const OPENAI_BASE_URL = (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env['OPENAI_GIFT_MODEL'] ?? 'gpt-5.4-mini';
const PROMPT_VERSION = 'gift-suitability-scorer-v2';
const BATCH_SIZE = 20;
/** LLM score normalization divisor: LLM outputs 0-100, we store [0, 1]. */
const LLM_SCORE_SCALE = 100;

// ---------------------------------------------------------------------------
// LLM response shape
// ---------------------------------------------------------------------------

interface GiftScoreResponse {
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
    record.country,
    record.region,
    record.wineType,
    record.priceBand,
    record.searchTextEn,
    record.pairingTags.join('|'),
    record.flavorProfiles.join('|'),
    record.classification ?? '',
    String(record.producerPrestige ?? ''),
    String(record.alcoholPct ?? ''),
    (record.occasion ?? []).join('|'),
  ].join('\n');
}

function contentHash(record: EnrichedSilverRecord): string {
  return crypto.createHash('sha256').update(fingerprintMaterial(record)).digest('hex');
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const GIFT_SUITABILITY_SYSTEM_PROMPT = [
  'You are a wine gift-suitability scoring expert. Score wines based on explicit catalog evidence only.',
  'Use only evidence present in the supplied fields; do not invent label aesthetics, packaging, or social prestige.',
  'Ground the score in explicit evidence axes such as producer recognition and prestige, official classification, occasion tags,',
  'flavor-profile language, pairing language, wine type, alcohol percentage, and search text.',
  'Do NOT treat price band or bottle style as a stand-alone proxy for gifting.',
  'If the catalog evidence is thin, stay conservative and say so.',
  'Do NOT hallucinate facts not present in the catalog data.',
].join(' ');

export function buildGiftSuitabilityUserPrompt(record: EnrichedSilverRecord): string {
  return [
    'Score this wine\'s gift suitability on 0-100.',
    'Return JSON: {"score": N, "evidence_axes": ["occasion", "classification"], "snippet": "evidence from catalog data", "rationale": "why this score"}',
    'If evidence is insufficient, return a conservative score grounded in the available evidence and keep evidence_axes empty if no explicit axis is supported.',
    '',
    `canonical_label: ${record.canonicalLabel}`,
    `producer: ${record.producer}`,
    `country: ${record.country}`,
    `region: ${record.region}`,
    `wine_type: ${record.wineType}`,
    `classification: ${record.classification ?? ''}`,
    `producer_prestige: ${String(record.producerPrestige ?? '')}`,
    `alcohol_pct: ${String(record.alcoholPct ?? '')}`,
    `occasion_tags: ${(record.occasion ?? []).join(', ')}`,
    `pairing_tags: ${record.pairingTags.join(', ')}`,
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
      throw new Error(`Gift suitability scorer HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const delay = RETRY_BASE_DELAY_MS * (2 ** attempt);
    console.log(`    Retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms (HTTP ${response.status})`);
    await new Promise((resolve) => { setTimeout(resolve, delay); });
  }
  throw new Error('fetchWithRetry: unreachable');
}

async function scoreGiftSuitability(record: EnrichedSilverRecord): Promise<GiftSuitabilityClassification | undefined> {
  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for gift suitability scoring');
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
          { role: 'system', content: GIFT_SUITABILITY_SYSTEM_PROMPT },
          { role: 'user', content: buildGiftSuitabilityUserPrompt(record) },
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

  let parsed: GiftScoreResponse;
  try {
    parsed = JSON.parse(rawContent) as GiftScoreResponse;
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
      version: GIFT_SUITABILITY_VERSION,
      generatedAt: new Date().toISOString(),
    },
    provenance: {
      source: 'llm_gift_suitability_scorer',
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
  const existing = record.giftSuitabilityClassification;
  if (existing === undefined) return false;
  return (
    existing.fingerprint.modelId === MODEL
    && existing.fingerprint.version === GIFT_SUITABILITY_VERSION
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
        const classification = await scoreGiftSuitability(record);
        if (classification === undefined) {
          return { failedSourceId: record.sourceId } as const;
        }
        return {
          record: {
            ...record,
            giftSuitabilityClassification: classification,
          } satisfies EnrichedSilverRecord,
        } as const;
      }),
    );
    const failedSourceIds = scored
      .flatMap((result) => ('failedSourceId' in result ? [result.failedSourceId] : []));
    if (failedSourceIds.length > 0) {
      const preview = failedSourceIds.slice(0, 10).join(', ');
      throw new Error(
        `Gift suitability scoring produced no classification for ${failedSourceIds.length} record(s): ${preview}`,
      );
    }
    output.push(...scored.flatMap((result) => ('record' in result ? [result.record] : [])));
    console.log(`  Gift suitability scoring: ${Math.min(index + batch.length, records.length)}/${records.length}`);
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
