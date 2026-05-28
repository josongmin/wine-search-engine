#!/usr/bin/env tsx
/**
 * LLM-as-Judge automatic relevance labeling for wine search NDCG evaluation.
 *
 * Uses OPENAI_CHAT_MODEL (from .env.local) as the judge — defaults to gpt-5.4-mini
 * but works with any OpenAI-compatible model (e.g. gpt-4o, gpt-4o-mini).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/eval/llm-judge-ndcg.ts \
 *     --queries data/vivino-gold-queries.jsonl \
 *     --corpus /tmp/test300-v3.ndjson \
 *     --output /tmp/llm-judge-labels.jsonl \
 *     [--concurrency 10] [--dry-run] [--fixture-repo ../wine-engine-fixture]
 *
 * Output (one line per query×wine pair) uses ADR-007 canonical `entityId` (never `sourceId`):
 *   {"qid":"vv-001","entityId":"opus-one-2018","grade":3,"reason":"...","model":"gpt-5.4-mini"}
 *
 * Corpus NDJSON must include identity fields for each wine: sourceId, canonicalLabel,
 * producer, country, region, vintageYear (Silver / enriched-silver shape).
 */

import { createReadStream } from 'node:fs';
import { glob, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import { createChatLlmFromEnv } from '../../src/infrastructure/ai/chat-llm-from-env.js';

import {
  buildEntityIdBySourceId,
  loadGoldCanonicalLookupForBuild,
} from '../etl/snapshot-entity-identity.js';

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------
const MODEL = process.env.OPENAI_CHAT_MODEL ?? 'gpt-5.4-mini';
const JUDGE_LLM = createChatLlmFromEnv({
  env: process.env,
  defaultModel: MODEL,
  httpTimeoutMs: 30_000,
  allowCodexFallback: true,
});

if (JUDGE_LLM === undefined) {
  console.error('OPENAI_API_KEY/OPENAI_API_KEYS or a valid Codex ChatGPT login token is required.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function getArg(flag: string, def = ''): string {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? (args[i + 1] ?? def) : def;
}
const QUERIES_FILE = getArg('--queries', 'data/vivino-gold-queries.jsonl');
// EVAL_CORPUS_PATH env var overrides the default corpus location so CI can
// point to the current labeled set without editing source. The default
// 'pilot200-*.ndjson' glob covers all shards of the pilot corpus; replace
// with a versioned path (e.g. /tmp/test300-v3.ndjson) for a pinned run.
// The pattern is expanded via Node 22 fs/promises.glob() in resolveCorpusFile().
const CORPUS_PATTERN = getArg('--corpus', process.env['EVAL_CORPUS_PATH'] ?? '/tmp/pilot200-*.ndjson');
const OUTPUT_FILE = getArg('--output', '/tmp/llm-judge-labels.jsonl');
const CONCURRENCY = parseInt(getArg('--concurrency', '8'), 10);
const DRY_RUN = args.includes('--dry-run');
const SAMPLE_N = parseInt(getArg('--sample', '0'), 10); // 0 = all
const FIXTURE_REPO = getArg('--fixture-repo', '');

// ---------------------------------------------------------------------------
// JSONL reader + corpus glob resolver
// ---------------------------------------------------------------------------

const QueryRecordSchema = z.object({
  qid: z.string().min(1),
  query: z.string().min(1),
  category: z.string().optional(),
  difficulty: z.string().optional(),
});

const WineJudgeCorpusRowSchema = z
  .object({
    sourceId: z.string().min(1),
    canonicalLabel: z.string().min(1),
    producer: z.string().min(1),
    country: z.string().min(1),
    region: z.string().min(1),
    vintageYear: z.union([z.number().int(), z.null()]),
    priceUsd: z.union([z.string(), z.number(), z.null()]).optional(),
    priceBand: z.string().optional(),
    grapes: z.array(z.string()).optional(),
    grapePrimary: z.string().optional(),
    pairingTags: z.array(z.string()).optional(),
    wineType: z.string().optional(),
  })
  .passthrough();

type WineJudgeCorpusRow = z.infer<typeof WineJudgeCorpusRowSchema>;
type QueryRecord = z.infer<typeof QueryRecordSchema>;

async function readJsonlQueries(filePath: string): Promise<QueryRecord[]> {
  const rows: QueryRecord[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    const result = QueryRecordSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid query row ${filePath}:${lineNo}: ${result.error.message}`);
    }
    rows.push(result.data);
  }
  return rows;
}

async function readJsonlCorpus(filePath: string): Promise<WineJudgeCorpusRow[]> {
  const rows: WineJudgeCorpusRow[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    const result = WineJudgeCorpusRowSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid corpus row ${filePath}:${lineNo} (need sourceId, canonicalLabel, producer, country, region, vintageYear): ${result.error.message}`,
      );
    }
    rows.push(result.data);
  }
  return rows;
}

/**
 * Resolves a (possibly glob) pattern to a single file path.
 * Uses Node 22 fs/promises.glob() so patterns like /tmp/pilot200-*.ndjson expand correctly.
 * Exits the process with a clear error if no files match.
 */
async function resolveCorpusFile(pattern: string): Promise<string> {
  // If no glob metacharacter, treat as a literal path (fast path).
  if (!/[*?{[]/.test(pattern)) return pattern;
  const matches: string[] = [];
  for await (const f of glob(pattern)) {
    matches.push(f);
  }
  if (matches.length === 0) {
    console.error(`[llm-judge] No corpus files match pattern: ${pattern}`);
    console.error('  Set EVAL_CORPUS_PATH or pass --corpus <exact-path>');
    process.exit(1);
  }
  if (matches.length > 1) {
    matches.sort();
    console.warn(`[llm-judge] ${matches.length} files match corpus pattern; using first after sort: ${matches[0]}`);
  }
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// Judge prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are a wine search relevance expert. Rate the relevance of a wine to a Korean search query on a 0–3 scale:

3 = Perfect match — exactly what the query asks (right region, style, price tier, producer)
2 = Good match — same region/style but minor mismatch (adjacent appellation, 20% price deviation)
1 = Partial match — same country or related style, partially satisfies the query
0 = Irrelevant — wrong region, wrong style, completely off price

Reply with ONLY valid JSON: {"grade": <0|1|2|3>, "reason": "<one sentence>"}
No extra text. No markdown. Just the JSON object.`;

function buildUserMessage(query: string, wine: WineJudgeCorpusRow): string {
  const label = wine.canonicalLabel ?? '';
  const region = wine.region ?? '';
  const price = wine.priceUsd ? `$${parseFloat(String(wine.priceUsd)).toFixed(0)}` : 'unknown price';
  const band = wine.priceBand ?? '';
  const country = wine.country ?? '';
  const grapes = Array.isArray(wine.grapes) && wine.grapes.length > 0
    ? wine.grapes.join(', ')
    : (wine.grapePrimary ?? 'unknown');
  const pairing = Array.isArray(wine.pairingTags) && wine.pairingTags.length > 0
    ? wine.pairingTags.slice(0, 3).join(', ')
    : '';
  const subRegion = region.split('/')[1]?.trim() ?? region;

  return [
    `Query (Korean): "${query}"`,
    `Wine: ${label}`,
    `Region: ${subRegion} (${country})`,
    `Price: ${price} (${band})`,
    `Grapes: ${grapes}`,
    ...(pairing ? [`Pairings: ${pairing}`] : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// OpenAI chat call
// ---------------------------------------------------------------------------
interface ChatMessage { role: 'system' | 'user'; content: string }
interface JudgeResult { grade: number; reason: string }

async function callJudge(
  llm: ChatLlmPort,
  messages: readonly ChatMessage[],
): Promise<JudgeResult> {
  const result = await llm.complete({
    messages,
    model: MODEL,
    maxOutputTokens: 100,
  });
  const content = result.text;
  const parsed = JSON.parse(content) as { grade?: unknown; reason?: unknown };

  const rawGrade = typeof parsed.grade === 'string' ? parseFloat(parsed.grade) : parsed.grade;
  const grade = typeof rawGrade === 'number' && Number.isFinite(rawGrade)
    ? Math.max(0, Math.min(3, Math.round(rawGrade)))
    : 0;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

  return { grade, reason };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JudgmentRow {
  qid: string;
  entityId: string;
  grade: number;
  reason: string;
  model: string;
  category?: string;
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------
async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const idx = nextIndex++;
      const task = tasks[idx];
      if (task === undefined) break;
      results[idx] = await task();
      completed++;
      if (completed % 50 === 0) {
        process.stderr.write(`  Progress: ${completed}/${tasks.length}\n`);
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const corpusFile = await resolveCorpusFile(CORPUS_PATTERN);

  console.log(`LLM-as-Judge NDCG labeler`);
  console.log(`  Model:       ${MODEL}`);
  console.log(`  Queries:     ${QUERIES_FILE}`);
  console.log(`  Corpus:      ${corpusFile}`);
  console.log(`  Output:      ${OUTPUT_FILE}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  if (DRY_RUN) console.log(`  DRY RUN — no API calls`);

  const queries = await readJsonlQueries(QUERIES_FILE);
  const corpus = await readJsonlCorpus(corpusFile);

  const goldLookup = await loadGoldCanonicalLookupForBuild({
    fixtureRepoRoot: FIXTURE_REPO.length > 0 ? FIXTURE_REPO : undefined,
  });
  const sourceToCanonical = buildEntityIdBySourceId(corpus, goldLookup);

  const activeQueries = SAMPLE_N > 0 ? queries.slice(0, SAMPLE_N) : queries;
  console.log(`\nQueries: ${activeQueries.length}  Corpus: ${corpus.length}`);
  console.log(`Total pairs: ${activeQueries.length * corpus.length}`);

  // Build tasks: all query × wine pairs
  type Task = () => Promise<JudgmentRow>;
  const tasks: Task[] = [];

  for (const q of activeQueries) {
    for (const wine of corpus) {
      tasks.push(async (): Promise<JudgmentRow> => {
        const canonicalEntityId = sourceToCanonical.get(wine.sourceId);
        if (canonicalEntityId === undefined) {
          throw new Error(`Missing canonical entity id for corpus sourceId=${wine.sourceId}`);
        }
        if (DRY_RUN) {
          return {
            qid: q.qid,
            entityId: canonicalEntityId,
            grade: 0,
            reason: 'dry-run',
            model: MODEL,
            category: q.category,
          };
        }

        const messages: ChatMessage[] = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(q.query, wine) },
        ];

        let attempt = 0;
        while (attempt < 3) {
          try {
            const result = await callJudge(JUDGE_LLM, messages);
            return {
              qid: q.qid,
              entityId: canonicalEntityId,
              grade: result.grade,
              reason: result.reason,
              model: MODEL,
              ...(q.category !== undefined ? { category: q.category } : {}),
            };
          } catch (err) {
            attempt++;
            if (attempt >= 3) {
              console.error(`  FAILED qid=${q.qid} entityId=${canonicalEntityId}: ${String(err).slice(0, 100)}`);
              return {
                qid: q.qid,
                entityId: canonicalEntityId,
                grade: 0,
                reason: 'judge_error',
                model: MODEL,
                ...(q.category !== undefined ? { category: q.category } : {}),
              };
            }
            // Exponential backoff: 2s, 4s
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        }
        // Unreachable but TypeScript needs it
        return {
          qid: q.qid,
          entityId: canonicalEntityId,
          grade: 0,
          reason: 'judge_error',
          model: MODEL,
        };
      });
    }
  }

  console.log(`\nRunning ${tasks.length} judge calls at concurrency=${CONCURRENCY}...`);
  const startMs = Date.now();
  const rows = await runConcurrent(tasks, CONCURRENCY);
  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);

  // Write output
  const lines = rows.map((r) => JSON.stringify(r, null, 0)).join('\n') + '\n';
  await writeFile(OUTPUT_FILE, lines, 'utf8');

  // Stats
  const gradeCount = [0, 1, 2, 3].map((g) => ({
    grade: g,
    count: rows.filter((r) => r.grade === g).length,
  }));
  const avgGrade = rows.reduce((s, r) => s + r.grade, 0) / rows.length;

  console.log(`\nDone in ${elapsedS}s`);
  console.log(`Output: ${OUTPUT_FILE} (${rows.length} rows)`);
  console.log(`Grade distribution:`);
  for (const { grade, count } of gradeCount) {
    const pct = ((count / rows.length) * 100).toFixed(1);
    console.log(`  grade ${grade}: ${count} (${pct}%)`);
  }
  console.log(`Average grade: ${avgGrade.toFixed(3)}`);

  // Compute per-query NDCG@10 from LLM labels
  console.log(`\nNDCG@10 from LLM labels (requires Vespa results):`);
  console.log(`  Run: python3 /tmp/run-ndcg-eval.py with --judgments ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
