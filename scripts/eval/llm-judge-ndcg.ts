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
 *     [--concurrency 10] [--dry-run]
 *
 * Output (one line per query×wine pair):
 *   {"qid":"vv-001","entityId":"vivino-xxx","grade":3,"reason":"...","model":"gpt-5.4-mini"}
 */

import { createReadStream } from 'node:fs';
import { glob, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const MODEL = process.env.OPENAI_CHAT_MODEL ?? 'gpt-5.4-mini';

if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required. Run with --env-file=.env.local');
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

// ---------------------------------------------------------------------------
// JSONL reader + corpus glob resolver
// ---------------------------------------------------------------------------
async function readJsonl<T>(filePath: string): Promise<T[]> {
  const rows: T[] = [];
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) rows.push(JSON.parse(line) as T);
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

function buildUserMessage(query: string, wine: WineRecord): string {
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

async function callJudge(messages: ChatMessage[]): Promise<JudgeResult> {
  const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0,
      max_tokens: 100,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
  const content = data.choices[0]?.message?.content ?? '{}';
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
interface QueryRecord {
  qid: string;
  query: string;
  category?: string;
  difficulty?: string;
}

interface WineRecord {
  sourceId: string;
  canonicalLabel?: string;
  region?: string;
  country?: string;
  priceUsd?: string | number;
  priceBand?: string;
  grapes?: string[];
  grapePrimary?: string;
  pairingTags?: string[];
  wineType?: string;
}

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

  const queries = await readJsonl<QueryRecord>(QUERIES_FILE);
  const corpus = await readJsonl<WineRecord>(corpusFile);

  const activeQueries = SAMPLE_N > 0 ? queries.slice(0, SAMPLE_N) : queries;
  console.log(`\nQueries: ${activeQueries.length}  Corpus: ${corpus.length}`);
  console.log(`Total pairs: ${activeQueries.length * corpus.length}`);

  // Build tasks: all query × wine pairs
  type Task = () => Promise<JudgmentRow>;
  const tasks: Task[] = [];

  for (const q of activeQueries) {
    for (const wine of corpus) {
      tasks.push(async (): Promise<JudgmentRow> => {
        if (DRY_RUN) {
          return {
            qid: q.qid,
            entityId: wine.sourceId,
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
            const result = await callJudge(messages);
            return {
              qid: q.qid,
              entityId: wine.sourceId,
              grade: result.grade,
              reason: result.reason,
              model: MODEL,
              ...(q.category !== undefined ? { category: q.category } : {}),
            };
          } catch (err) {
            attempt++;
            if (attempt >= 3) {
              console.error(`  FAILED qid=${q.qid} entityId=${wine.sourceId}: ${String(err).slice(0, 100)}`);
              return {
                qid: q.qid,
                entityId: wine.sourceId,
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
          entityId: wine.sourceId,
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
