#!/usr/bin/env tsx
/**
 * Silver Label Generator — LLM-based relevance labeling over (query, candidate) pairs.
 *
 * FIXTURE-BASED variant (preferred for testing + deterministic runs):
 *   Input: NDJSON where each line is:
 *     {
 *       "queryId": "q-001",
 *       "query": "burgundy pinot noir under $50",
 *       "candidates": [
 *         { "entityId": "wine-42", "canonicalLabel": "...", "producer": "...", ... },
 *         ... up to 10 candidates ...
 *       ]
 *     }
 *
 *   Output: NDJSON, one RelevanceJudgment per (query, candidate) pair.
 *
 * N-sample voting:
 *   - Requests `--samples` labels per pair (default 3), takes median grade.
 *   - On ties (even sample count or split disagreement), picks the conservative
 *     LOWER grade to avoid inflation (matches CLAUDE.md silver-label spec).
 *   - Reports the average confidence across samples.
 *
 * Usage:
 *   npx tsx scripts/eval/generate-silver-labels.ts \
 *     --input data/silver-labels-input.jsonl \
 *     --output data/relevance/silver-labels.ndjson \
 *     --samples 3 \
 *     --model claude-haiku-4-5
 *
 *   npx tsx scripts/eval/generate-silver-labels.ts --help
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { bootstrapLogger } from '../../src/domain/shared/bootstrap-logger.js';
import {
  labelRelevance,
  type LabelingCandidate,
  type LabelingResult,
} from '../../src/domain/evaluation/service/llm-relevance-labeler.js';
import type {
  RelevanceGrade,
  RelevanceJudgment,
} from '../../src/domain/evaluation/model/relevance-judgment.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import { AnthropicChatLlm } from '../../src/infrastructure/ai/anthropic-chat-llm.js';
import { createChatLlmFromEnv } from '../../src/infrastructure/ai/chat-llm-from-env.js';

// ── Named constants ────────────────────────────────────────────────────────

const DEFAULT_SAMPLES = 3;
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_INPUT = 'data/silver-labels-input.jsonl';
const DEFAULT_OUTPUT_DIR = 'data/relevance';
const HTTP_TIMEOUT_MS = 30_000;
const MAX_CANDIDATES_PER_QUERY = 10;

// ── CLI ────────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly input: string;
  readonly output: string;
  readonly samples: number;
  readonly model: string;
  readonly concurrency: number;
  readonly provider: 'anthropic' | 'openai';
  readonly help: boolean;
}

function printHelp(): void {
  process.stderr.write(`
generate-silver-labels — LLM silver relevance labels (NDJSON → NDJSON)

Usage:
  npx tsx scripts/eval/generate-silver-labels.ts [options]

Options:
  --input <path>         Input NDJSON fixture with query+candidates lines.
                         Default: ${DEFAULT_INPUT}
  --output <path>        Output NDJSON path. Default: ${DEFAULT_OUTPUT_DIR}/silver-labels-<date>.ndjson
  --samples <n>          N-sample voting count (default ${DEFAULT_SAMPLES}). Median grade;
                         ties resolve to the conservative lower grade.
  --model <name>         LLM model to use. Default: ${DEFAULT_MODEL}
  --provider <name>      'anthropic' | 'openai'. Default: anthropic
  --concurrency <n>      Max parallel LLM calls. Default: ${DEFAULT_CONCURRENCY}
  --help, -h             Show this help and exit.

Environment:
  ANTHROPIC_API_KEY      Required when provider=anthropic
  OPENAI_API_KEY         Optional when provider=openai; Codex login token also works
  OPENAI_BASE_URL        Optional OpenAI base URL override
`);
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const date = new Date().toISOString().slice(0, 10);
  const defaultOutput = path.join(DEFAULT_OUTPUT_DIR, `silver-labels-${date}.ndjson`);

  let input = DEFAULT_INPUT;
  let output = defaultOutput;
  let samples = DEFAULT_SAMPLES;
  let model = DEFAULT_MODEL;
  let concurrency = DEFAULT_CONCURRENCY;
  let provider: 'anthropic' | 'openai' = 'anthropic';
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--input':
        if (next) { input = next; i++; }
        break;
      case '--output':
        if (next) { output = next; i++; }
        break;
      case '--samples':
        if (next) { samples = Number.parseInt(next, 10); i++; }
        break;
      case '--model':
        if (next) { model = next; i++; }
        break;
      case '--provider':
        if (next === 'anthropic' || next === 'openai') { provider = next; i++; }
        break;
      case '--concurrency':
        if (next) { concurrency = Number.parseInt(next, 10); i++; }
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(samples) || samples < 1) samples = DEFAULT_SAMPLES;
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = DEFAULT_CONCURRENCY;

  return { input, output, samples, model, concurrency, provider, help };
}

// ── Input schema ───────────────────────────────────────────────────────────

const CandidateSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  producer: z.string().optional(),
  region: z.string().optional(),
  grapes: z.array(z.string()).optional(),
  style: z.string().optional(),
  priceUsd: z.number().finite().optional(),
  vintageYear: z.number().int().optional(),
});

const InputLineSchema = z.object({
  queryId: z.string().min(1),
  query: z.string().min(1),
  candidates: z.array(CandidateSchema).min(1).max(MAX_CANDIDATES_PER_QUERY),
});

type InputLine = z.infer<typeof InputLineSchema>;

// ── LLM adapter factory ────────────────────────────────────────────────────

function buildLlm(provider: 'anthropic' | 'openai', model: string): ChatLlmPort {
  if (provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for provider=anthropic');
    return new AnthropicChatLlm({
      apiKey,
      defaultModel: model,
      httpTimeoutMs: HTTP_TIMEOUT_MS,
    });
  }
  const llm = createChatLlmFromEnv({
    env: process.env,
    defaultModel: model,
    httpTimeoutMs: HTTP_TIMEOUT_MS,
    allowCodexFallback: true,
  });
  if (llm === undefined) {
    throw new Error('provider=openai requires OPENAI_API_KEY/OPENAI_API_KEYS or a valid Codex ChatGPT login token');
  }
  return llm;
}

// ── Input reader ───────────────────────────────────────────────────────────

async function loadInput(filePath: string): Promise<readonly InputLine[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split('\n');
  const out: InputLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bootstrapLogger.warn(
        { file: filePath, lineNumber: i + 1, error: msg },
        'generate-silver-labels: skipping malformed input line',
      );
      continue;
    }
    const result = InputLineSchema.safeParse(json);
    if (!result.success) {
      bootstrapLogger.warn(
        { file: filePath, lineNumber: i + 1, issues: result.error.issues },
        'generate-silver-labels: skipping input line that failed schema validation',
      );
      continue;
    }
    out.push(result.data);
  }
  return out;
}

// ── N-sample voting ────────────────────────────────────────────────────────

/**
 * Median grade with conservative tie-break: if the two middle values differ
 * (even-count samples) we pick the LOWER grade. This prevents silver label
 * inflation from 50/50 splits between grade N and grade N+1.
 */
export function medianGradeConservative(grades: readonly RelevanceGrade[]): RelevanceGrade {
  if (grades.length === 0) return 1 satisfies RelevanceGrade;
  const sorted = [...grades].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) {
    return sorted[(n - 1) / 2] as RelevanceGrade;
  }
  const lower = sorted[n / 2 - 1] as RelevanceGrade;
  // Conservative: always take the lower of the two middles on even counts.
  return lower;
}

function averageConfidence(results: readonly LabelingResult[]): number {
  if (results.length === 0) return 0;
  let sum = 0;
  for (const r of results) sum += r.confidence;
  return sum / results.length;
}

// ── Simple concurrency semaphore ───────────────────────────────────────────

class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
  }

  release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ── Core pipeline ──────────────────────────────────────────────────────────

interface LabelingTask {
  readonly queryId: string;
  readonly query: string;
  readonly candidate: LabelingCandidate;
}

async function labelOnePair(
  llm: ChatLlmPort,
  task: LabelingTask,
  samples: number,
  model: string,
): Promise<RelevanceJudgment> {
  const results: LabelingResult[] = [];
  for (let s = 0; s < samples; s++) {
    const r = await labelRelevance(
      llm,
      { query: task.query, candidate: task.candidate },
      { warn: (msg) => bootstrapLogger.warn({ task: task.queryId }, msg) },
    );
    results.push(r);
  }

  const grades = results.map((r) => r.grade);
  const medianGrade = medianGradeConservative(grades);
  const avgConfidence = averageConfidence(results);
  const rationale = results[0]?.rationale ?? '';

  return {
    queryId: task.queryId,
    query: task.query,
    entityId: task.candidate.entityId,
    canonicalLabel: task.candidate.canonicalLabel,
    grade: medianGrade,
    confidence: avgConfidence,
    source: 'llm_silver',
    labelerModel: model,
    rationale,
  };
}

async function run(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  process.stderr.write(
    `generate-silver-labels: input=${args.input} output=${args.output} samples=${args.samples} model=${args.model} provider=${args.provider} concurrency=${args.concurrency}\n`,
  );

  const inputs = await loadInput(args.input);
  if (inputs.length === 0) {
    process.stderr.write('No valid input lines. Exiting.\n');
    return;
  }

  const llm = buildLlm(args.provider, args.model);
  const sem = new Semaphore(args.concurrency);

  // Ensure output directory exists.
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  const outHandle = await fs.open(args.output, 'w');

  const tasks: LabelingTask[] = [];
  for (const line of inputs) {
    for (const candidate of line.candidates) {
      tasks.push({ queryId: line.queryId, query: line.query, candidate });
    }
  }

  const gradeCounts = new Map<RelevanceGrade, number>();
  let completed = 0;

  try {
    const runners = tasks.map(async (task) => {
      await sem.acquire();
      try {
        const judgment = await labelOnePair(llm, task, args.samples, args.model);
        await outHandle.write(`${JSON.stringify(judgment)}\n`);
        gradeCounts.set(judgment.grade, (gradeCounts.get(judgment.grade) ?? 0) + 1);
        completed++;
        if (completed % 10 === 0) {
          process.stderr.write(`  progress: ${completed}/${tasks.length}\n`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bootstrapLogger.warn(
          { queryId: task.queryId, entityId: task.candidate.entityId, error: msg },
          'generate-silver-labels: labeling task failed',
        );
      } finally {
        sem.release();
      }
    });
    await Promise.all(runners);
  } finally {
    await outHandle.close();
  }

  process.stderr.write(
    `generate-silver-labels: wrote ${completed}/${tasks.length} judgments to ${args.output}\n`,
  );
  process.stderr.write('grade distribution:\n');
  for (const g of [0, 1, 2, 3] as const) {
    process.stderr.write(`  grade ${g}: ${gradeCounts.get(g) ?? 0}\n`);
  }
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`generate-silver-labels: fatal: ${msg}\n`);
    process.exit(1);
  });
}
