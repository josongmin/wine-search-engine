#!/usr/bin/env tsx

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import {
  OCCASION_ONTOLOGY_VALUES,
  OCCASION_ONTOLOGY_VERSION,
} from '../../src/domain/attribute/service/ontology-normalizer.js';
import { parseNdjson } from './ndjson.js';
import type {
  EnrichedSilverRecord,
  OccasionClassification,
  OccasionClassificationEvidence,
} from './types.js';
import { atomicWriteFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

export const DATA_FILE = ETL_ARTIFACT_FILES.trackc;
const OPENAI_BASE_URL = (process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const MODEL = process.env['OPENAI_OCCASION_MODEL'] ?? 'gpt-5.4-mini';
const PROMPT_VERSION = 'occasion-classifier-v1';
const BATCH_SIZE = 20;

interface OccasionResponseItem {
  readonly value: string;
  readonly snippet: string;
  readonly rationale: string;
}

interface OccasionResponse {
  readonly occasions?: readonly OccasionResponseItem[];
}

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
    record.oakTreatment ?? '',
  ].join('\n');
}

function contentHash(record: EnrichedSilverRecord): string {
  return crypto.createHash('sha256').update(fingerprintMaterial(record)).digest('hex');
}

function buildPrompt(record: EnrichedSilverRecord): string {
  return [
    'Classify wine-buying occasions only when the evidence is explicit in the catalog data.',
    `Allowed values: ${OCCASION_ONTOLOGY_VALUES.join(', ')}`,
    'Return JSON only in the shape {"occasions":[{"value":"...","snippet":"...","rationale":"..."}]}.',
    'If the evidence is insufficient, return {"occasions":[]}.',
    '',
    `canonical_label: ${record.canonicalLabel}`,
    `producer: ${record.producer}`,
    `country: ${record.country}`,
    `region: ${record.region}`,
    `wine_type: ${record.wineType}`,
    `price_band: ${record.priceBand}`,
    `pairing_tags: ${record.pairingTags.join(', ')}`,
    `flavor_profiles: ${record.flavorProfiles.join(', ')}`,
    `classification: ${record.classification ?? ''}`,
    `oak_treatment: ${record.oakTreatment ?? ''}`,
    `search_text_en: ${record.searchTextEn}`,
  ].join('\n');
}

async function classifyOccasions(record: EnrichedSilverRecord): Promise<OccasionClassification | undefined> {
  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for occasion classification');
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
        {
          role: 'system',
          content: 'You are an ontology-constrained wine catalog classifier. Never invent unsupported occasions.',
        },
        {
          role: 'user',
          content: buildPrompt(record),
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Occasion classifier HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const json = await response.json() as {
    choices?: readonly { message?: { content?: string | null } }[];
  };
  const rawContent = json.choices?.[0]?.message?.content;
  if (typeof rawContent !== 'string' || rawContent.trim().length === 0) {
    return undefined;
  }

  const parsed = JSON.parse(rawContent) as OccasionResponse;
  const allowed = new Set<string>(OCCASION_ONTOLOGY_VALUES);
  const evidence: OccasionClassificationEvidence[] = [];
  const values: string[] = [];
  const seen = new Set<string>();

  for (const item of parsed.occasions ?? []) {
    if (typeof item.value !== 'string' || !allowed.has(item.value) || seen.has(item.value)) {
      continue;
    }
    if (typeof item.snippet !== 'string' || item.snippet.trim().length === 0) {
      continue;
    }
    if (typeof item.rationale !== 'string' || item.rationale.trim().length === 0) {
      continue;
    }
    seen.add(item.value);
    values.push(item.value);
    evidence.push({
      snippet: item.snippet.trim(),
      rationale: item.rationale.trim(),
    });
  }

  if (values.length === 0) {
    return undefined;
  }

  return {
    values,
    fingerprint: {
      modelId: MODEL,
      contentHash: contentHash(record),
      ontologyVersion: OCCASION_ONTOLOGY_VERSION,
      generatedAt: new Date().toISOString(),
    },
    provenance: {
      source: 'llm_ontology_classifier',
      promptVersion: PROMPT_VERSION,
      evidence,
    },
  };
}

function isFresh(record: EnrichedSilverRecord): boolean {
  const existing = record.occasionClassification;
  if (existing === undefined) return false;
  return (
    existing.fingerprint.modelId === MODEL
    && existing.fingerprint.ontologyVersion === OCCASION_ONTOLOGY_VERSION
    && existing.fingerprint.contentHash === contentHash(record)
    && existing.provenance.promptVersion === PROMPT_VERSION
  );
}

async function run(): Promise<void> {
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const records = parseNdjson<EnrichedSilverRecord>(raw, DATA_FILE).records;
  const output: EnrichedSilverRecord[] = [];

  for (let index = 0; index < records.length; index += BATCH_SIZE) {
    const batch = records.slice(index, index + BATCH_SIZE);
    const classified = await Promise.all(
      batch.map(async (record) => {
        if (isFresh(record)) {
          return record;
        }
        const occasionClassification = await classifyOccasions(record);
        if (occasionClassification === undefined) {
          const { occasionClassification: _removedClassification, occasion: _removedOccasion, ...rest } = record;
          return rest as EnrichedSilverRecord;
        }
        return {
          ...record,
          occasion: occasionClassification.values,
          occasionClassification,
        } satisfies EnrichedSilverRecord;
      }),
    );
    output.push(...classified);
    console.log(`  Occasion classification: ${Math.min(index + batch.length, records.length)}/${records.length}`);
  }

  await atomicWriteFile(
    DATA_FILE,
    `${output.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
}

// Only execute when invoked directly as a CLI (not when imported by tests).
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
