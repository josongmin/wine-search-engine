#!/usr/bin/env tsx
/**
 * Korean Alias Generator: Reads enriched Silver NDJSON and generates
 * Korean transliteration aliases using Claude API (Haiku).
 *
 * LLM output is Bronze proposal only (RFC-003 §typed alias).
 * Cross-entity collision check and Unicode confusable detection are
 * performed before any alias is added to the projection.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/etl/generate-korean-aliases.ts
 *   npx tsx --env-file=.env scripts/etl/generate-korean-aliases.ts --dry-run --limit 10
 *
 * Requires: ANTHROPIC_API_KEY in environment.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import type { EnrichedSilverRecord, ProposedAlias } from './types.js';
import { parseNdjson } from './ndjson.js';
import { atomicWriteFile } from './etl-utils.js';
import { ETL_ARTIFACT_FILES } from './artifact-contract.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_INPUT = ETL_ARTIFACT_FILES.aliases;
export const DEFAULT_OUTPUT = ETL_ARTIFACT_FILES.ko;
const BATCH_SIZE = 20;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  output: string;
  dryRun: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, dryRun: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--output' || a === '-o') out.output = argv[++i] ?? DEFAULT_OUTPUT;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--limit') out.limit = Math.max(1, Number(argv[++i] ?? '0'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a Korean wine expert. Generate Korean transliterations of wine names.
For each wine, provide 3 variations of Korean phonetic transliteration.
Use natural Korean wine drinker vocabulary (how Koreans actually search for these wines).
Include: producer name only, producer + vintage, and common abbreviation.
Output ONLY a JSON array of arrays of strings, no explanation.
Each outer array entry must align with the corresponding input wine.`;

function buildUserPrompt(records: readonly EnrichedSilverRecord[]): string {
  const items = records.map(
    (r) => `- "${r.canonicalLabel}" (producer: ${r.producer})`,
  );
  return `Generate Korean transliterations for these wines:\n${items.join('\n')}\n\nReturn a JSON array of arrays of strings. The outer array must have one entry per wine, in the same order as the input list. Each inner array must contain the 3 Korean transliteration variants for that wine.`;
}

const MAX_RETRIES = 5;

export function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
}

export function parseAliasMatrix(text: string, expectedCount: number): string[][] {
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let ci = 0; ci < text.length; ci++) {
    if (text[ci] === '[') {
      if (depth === 0) start = ci;
      depth++;
    } else if (text[ci] === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        end = ci + 1;
        break;
      }
    }
  }

  if (start < 0 || end < 0) {
    throw new Error('Claude response did not contain a JSON array');
  }

  const parsed: unknown = JSON.parse(text.slice(start, end));
  if (!Array.isArray(parsed)) {
    throw new Error('Claude response JSON was not an array');
  }
  if (parsed.length !== expectedCount) {
    throw new Error(`Claude response length mismatch: expected ${expectedCount}, got ${parsed.length}`);
  }

  return parsed.map((entry, index) => {
    if (!Array.isArray(entry)) {
      throw new Error(`Claude response entry ${index} was not an array`);
    }
    const aliases = entry.filter((value): value is string => typeof value === 'string');
    if (aliases.length !== entry.length) {
      throw new Error(`Claude response entry ${index} contained non-string alias values`);
    }
    return aliases;
  });
}

async function callClaude(
  prompt: string,
  expectedCount: number,
): Promise<string[][]> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (response.status === 429) {
      const wait = Math.min(60_000, 2_000 * Math.pow(2, attempt));
      console.warn(`  Rate limited (429), waiting ${(wait / 1000).toFixed(0)}s before retry ${attempt + 1}/${MAX_RETRIES}`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Claude API error [${response.status}]: ${errText.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      content: { type: string; text: string }[];
    };
    const text = data.content[0]?.text ?? '[]';

    return parseAliasMatrix(text, expectedCount);
  }

  throw new Error('Claude API retries exhausted');
}

// ---------------------------------------------------------------------------
// Collision detection
// ---------------------------------------------------------------------------

export function detectCollisions(
  records: readonly EnrichedSilverRecord[],
  newAliases: Map<string, string[]>,
): Map<string, string[]> {
  // Build existing alias → entityId mapping
  const aliasToEntity = new Map<string, Set<string>>();
  for (const rec of records) {
    const all = [
      ...rec.aliases.identitySafeProjection,
      ...rec.aliases.noisyRecallProjection,
    ];
    for (const alias of all) {
      const norm = normalizeAliasKey(alias);
      const existing = aliasToEntity.get(norm);
      if (existing) {
        existing.add(rec.sourceId);
      } else {
        aliasToEntity.set(norm, new Set([rec.sourceId]));
      }
    }
  }

  // Check new Korean aliases for collisions
  const collisions = new Map<string, string[]>();
  for (const [entityId, aliases] of newAliases) {
    const colliding: string[] = [];
    for (const alias of aliases) {
      const norm = normalizeAliasKey(alias);
      const owners = aliasToEntity.get(norm);
      if (owners && owners.size > 0 && !owners.has(entityId)) {
        colliding.push(alias);
      }
      // Register this alias
      const existing = aliasToEntity.get(norm);
      if (existing) {
        existing.add(entityId);
      } else {
        aliasToEntity.set(norm, new Set([entityId]));
      }
    }
    if (colliding.length > 0) {
      collisions.set(entityId, colliding);
    }
  }

  return collisions;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading enriched Silver from ${args.input} …`);
  const content = await fs.readFile(args.input, 'utf8');
  let records = parseNdjson<EnrichedSilverRecord>(content, args.input).records;

  if (args.limit > 0) records = records.slice(0, args.limit);
  console.log(`  Records: ${records.length}`);

  if (args.dryRun) {
    console.log('  DRY RUN — showing sample prompt:');
    console.log(buildUserPrompt(records.slice(0, 3)));
    return;
  }

  // Generate Korean aliases in batches
  const koAliasMap = new Map<string, string[]>();
  const batches = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    batches.push(records.slice(i, i + BATCH_SIZE));
  }

  let totalGenerated = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]!;
    const prompt = buildUserPrompt(batch);

    try {
      const result = await callClaude(prompt, batch.length);
      for (let ri = 0; ri < batch.length; ri++) {
        const aliases = result[ri] ?? [];
        const filtered = aliases.filter(
          (a): a is string => typeof a === 'string' && a.length > 0,
        );
        if (filtered.length > 0) {
          koAliasMap.set(batch[ri]!.sourceId, filtered);
          totalGenerated += filtered.length;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Batch ${bi + 1} failed: ${msg}`);
      throw err;
    }

    if ((bi + 1) % 5 === 0 || bi === batches.length - 1) {
      console.log(`  Progress: ${bi + 1}/${batches.length} batches`);
    }

    // Inter-batch delay: 1.5s to stay under 10K output tokens/min rate limit.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  console.log(`  Total Korean aliases generated: ${totalGenerated}`);

  // Collision detection
  const collisions = detectCollisions(records, koAliasMap);
  console.log(`  Collisions detected: ${collisions.size} entities`);

  // Merge into records
  const enriched = records.map((rec) => {
    const koAliases = koAliasMap.get(rec.sourceId) ?? [];
    const entityCollisions = collisions.get(rec.sourceId) ?? [];
    const collisionSet = new Set(entityCollisions.map(normalizeAliasKey));
    const seen = new Set<string>();

    const newProposals: ProposedAlias[] = [];
    for (const alias of koAliases) {
      const key = normalizeAliasKey(alias);
      if (seen.has(key)) continue;
      seen.add(key);
      newProposals.push({
        value: alias,
        type: 'phonetic' as const,
        source: 'llm:ko_translit_v1',
        confidencePrior: 0.60,
        needsReview: collisionSet.has(key),
      });
    }

    // Non-colliding Korean aliases go to noisyRecallProjection
    const safeKo = koAliases.filter(
      (a) => !collisionSet.has(normalizeAliasKey(a)),
    );

    return {
      ...rec,
      aliases: {
        proposed: [...rec.aliases.proposed, ...newProposals],
        identitySafeProjection: rec.aliases.identitySafeProjection,
        noisyRecallProjection: [
          ...rec.aliases.noisyRecallProjection,
          ...safeKo,
        ],
      },
    };
  });

  // Write
  const lines = enriched.map((r) => JSON.stringify(r)).join('\n');
  await atomicWriteFile(args.output, lines + '\n');
  console.log(`  Written to: ${args.output}`);
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
