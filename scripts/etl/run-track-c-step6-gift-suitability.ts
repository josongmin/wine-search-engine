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
const MODEL = process.env['OPENAI_GIFT_MODEL'] ?? 'gpt-4.1-mini';
const PROMPT_VERSION = 'gift-suitability-scorer-v1';
const BATCH_SIZE = 20;
/** LLM score normalization divisor: LLM outputs 0-100, we store [0, 1]. */
const LLM_SCORE_SCALE = 100;

// ---------------------------------------------------------------------------
// LLM response shape
// ---------------------------------------------------------------------------

interface GiftScoreResponse {
  readonly score?: number | string;
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

const SYSTEM_PROMPT = [
  'You are a wine gift-suitability scoring expert. Score wines based on explicit catalog evidence only.',
  'Consider: brand recognition and prestige for gifting, price point signaling (luxury/premium = stronger gift signal),',
  'occasion fit (celebration, anniversary, wedding contexts), wine type appeal for non-expert recipients',
  '(sparkling and rosé have natural visual appeal), region/classification prestige (Grand Cru, Barolo DOCG etc.),',
  'and producer reputation.',
  'Do NOT consider label aesthetics or packaging — that data is not available.',
  'Do NOT hallucinate facts not present in the catalog data.',
].join(' ');

function buildPrompt(record: EnrichedSilverRecord): string {
  return [
    'Score this wine\'s gift suitability on 0-100.',
    'Return JSON: {"score": N, "snippet": "evidence from catalog data", "rationale": "why this score"}',
    'If evidence is insufficient for a confident score, return {"score": 30, "snippet": "insufficient explicit gift signals", "rationale": "default baseline"}',
    '',
    `canonical_label: ${record.canonicalLabel}`,
    `producer: ${record.producer}`,
    `country: ${record.country}`,
    `region: ${record.region}`,
    `wine_type: ${record.wineType}`,
    `price_band: ${record.priceBand}`,
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

async function scoreGiftSuitability(record: EnrichedSilverRecord): Promise<GiftSuitabilityClassification | undefined> {
  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for gift suitability scoring');
  }

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
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
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(record) },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Gift suitability scorer HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = await response.json() as {
    choices?: readonly { message?: { content?: string | null } }[];
  };
  const rawContent = json.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return undefined;
  }

  const parsed = JSON.parse(rawContent) as GiftScoreResponse;

  // Accept both number and string for score (LLMs routinely emit "75" instead of 75)
  const rawScore = typeof parsed.score === 'string' ? parseFloat(parsed.score) : parsed.score;
  if (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > LLM_SCORE_SCALE) {
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
          return record;
        }
        const classification = await scoreGiftSuitability(record);
        if (classification === undefined) {
          // 유효한 점수 없으면 필드 제거
          const { giftSuitabilityClassification: _removed, ...rest } = record;
          return rest as EnrichedSilverRecord;
        }
        return {
          ...record,
          giftSuitabilityClassification: classification,
        } satisfies EnrichedSilverRecord;
      }),
    );
    output.push(...scored);
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
