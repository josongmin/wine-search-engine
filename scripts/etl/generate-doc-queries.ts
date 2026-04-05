#!/usr/bin/env tsx
/**
 * Document Expansion (doc2query): Generates synthetic search queries per wine
 * document and appends them to searchTextEn for improved sparse recall.
 *
 * Each wine gets 5-10 synthetic queries that a user might type to find it.
 * These expand the BM25 vocabulary coverage dramatically.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/etl/generate-doc-queries.ts
 *   npx tsx --env-file=.env scripts/etl/generate-doc-queries.ts --dry-run --limit 5
 *
 * Requires: ANTHROPIC_API_KEY in environment.
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import type { EnrichedSilverRecord } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INPUT = 'data/silver-enriched.ndjson';
const DEFAULT_OUTPUT = 'data/silver-enriched-docquery.ndjson';
const BATCH_SIZE = 10;
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const DOC_QUERY_DELIMITER = ' ||| '; // separates original text from synthetic queries

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
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a wine search query generator. For each wine document, generate 7 realistic search queries that someone might type to find this wine. Include:
- Style/body queries ("full bodied red wine")
- Occasion queries ("wine for steak dinner")
- Region/grape queries ("napa cabernet")
- Price-tier queries ("premium red under 200")
- Comparison queries ("top bordeaux first growth")
- Korean queries if the wine is notable (2 Korean queries)
- Natural language discovery queries

Output ONLY a JSON array of arrays: [[wine1_q1, wine1_q2, ...], [wine2_q1, ...]]
No explanation, no markdown.`;

function buildPrompt(records: readonly EnrichedSilverRecord[]): string {
  return records
    .map(
      (r) =>
        `Wine: ${r.canonicalLabel}\nProducer: ${r.producer}\nRegion: ${r.region}, ${r.country}\nGrape: ${r.grapePrimary ?? 'blend'}\nStyle: body=${r.body.toFixed(2)}, tannin=${r.tannin.toFixed(2)}\nPrice: $${r.priceUsd ?? 'unknown'}\nNotes: ${r.searchTextEn.slice(0, 200)}`,
    )
    .join('\n---\n');
}

async function callClaude(prompt: string): Promise<string[][]> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

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

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Claude API error [${response.status}]: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    content: { type: string; text: string }[];
  };
  const text = data.content[0]?.text ?? '[]';
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) return [];

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed as string[][];
  } catch {
    console.warn('  Warning: failed to parse LLM JSON response, skipping batch');
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading enriched Silver from ${args.input} …`);
  const content = await fs.readFile(args.input, 'utf8');
  let records: EnrichedSilverRecord[] = content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EnrichedSilverRecord);

  if (args.limit > 0) records = records.slice(0, args.limit);
  console.log(`  Records: ${records.length}`);

  if (args.dryRun) {
    console.log('  DRY RUN — showing sample prompt:');
    console.log(buildPrompt(records.slice(0, 2)));
    return;
  }

  // Process in batches
  const docQueryMap = new Map<string, string[]>();
  const batches = [];
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    batches.push(records.slice(i, i + BATCH_SIZE));
  }

  let totalQueries = 0;
  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi]!;
    const prompt = buildPrompt(batch);

    try {
      const result = await callClaude(prompt);
      for (let ri = 0; ri < batch.length; ri++) {
        const queries = (result[ri] ?? []).filter(
          (q): q is string => typeof q === 'string' && q.length > 0,
        );
        if (queries.length > 0) {
          docQueryMap.set(batch[ri]!.sourceId, queries);
          totalQueries += queries.length;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Batch ${bi + 1} failed: ${msg}`);
    }

    if ((bi + 1) % 5 === 0 || bi === batches.length - 1) {
      console.log(`  Progress: ${bi + 1}/${batches.length} batches  (${totalQueries} queries)`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`  Total doc-queries generated: ${totalQueries}`);

  // Merge: append synthetic queries to searchTextEn with delimiter
  const enriched = records.map((rec) => {
    const queries = docQueryMap.get(rec.sourceId);
    if (!queries || queries.length === 0) return rec;

    return {
      ...rec,
      searchTextEn: rec.searchTextEn + DOC_QUERY_DELIMITER + queries.join('. '),
    };
  });

  const withQueries = enriched.filter((r) =>
    r.searchTextEn.includes(DOC_QUERY_DELIMITER),
  ).length;
  console.log(`  Records with doc-queries: ${withQueries}/${enriched.length}`);

  const lines = enriched.map((r) => JSON.stringify(r)).join('\n');
  await fs.writeFile(args.output, lines + '\n', 'utf8');
  console.log(`  Written to: ${args.output}`);
}

void run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FATAL: ${msg}`);
  process.exit(1);
});
