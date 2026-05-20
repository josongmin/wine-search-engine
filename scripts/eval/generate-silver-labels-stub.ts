#!/usr/bin/env tsx
/**
 * Offline stub variant of `generate-silver-labels.ts`.
 *
 * Mirrors the NDJSON-in / NDJSON-out contract of generate-silver-labels.ts but
 * uses a deterministic, in-memory stub LLM instead of Anthropic / OpenAI. This
 * is the "test mode" for the labeling pipeline: it proves the full wiring from
 * scenarios → labeling input → silver NDJSON → gold promotion WITHOUT any
 * network, API key, or cost — useful for CI, local smoke runs, and unit tests.
 *
 * The stub's grading policy is intentionally simple and fully deterministic:
 *   - Shared tokens between query and canonical label ≥ 2 → grade 3, confidence 0.90
 *   - Shared tokens == 1                                  → grade 2, confidence 0.80
 *   - Shared tokens == 0, but any alias/region overlap    → grade 1, confidence 0.55
 *   - Otherwise                                           → grade 0, confidence 0.40
 *
 * Thresholds line up with `promote-to-gold.ts` buckets
 * (HIGH_CONFIDENCE_THRESHOLD = 0.85, AUDIT_LOWER_BOUND = 0.5) so that the stub
 * exercises all three bucket branches naturally.
 *
 * Usage:
 *   npx tsx scripts/eval/generate-silver-labels-stub.ts \
 *     --input data/relevance/scenarios-labeling-input.jsonl \
 *     --output data/relevance/scenarios-silver-stub.ndjson
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { bootstrapLogger } from '../../src/domain/shared/bootstrap-logger.js';
import type {
  RelevanceGrade,
  RelevanceJudgment,
} from '../../src/domain/evaluation/model/relevance-judgment.js';
import { tokenize } from './tokenize-text.js';
import {
  RELEVANCE_LABELING_INPUT_CORPUS,
  requireFixtureCorpusPath,
} from './fixture-corpus-paths.js';

// ── Named constants ────────────────────────────────────────────────────────

const DEFAULT_OUTPUT = 'data/relevance/scenarios-silver-stub.snapshot.ndjson';
const STUB_MODEL_NAME = 'stub-labeler-v1';

/** Confidence returned for "strong match" stub decisions (≥ 2 shared tokens). */
const STUB_CONF_STRONG = 0.9;
/** Confidence for "single-token match" — lands in the audit bucket. */
const STUB_CONF_MEDIUM = 0.8;
/** Confidence for "weak alias/region hit" — still in audit. */
const STUB_CONF_WEAK = 0.55;
/** Confidence for "no match" — lands in the rejected bucket. */
const STUB_CONF_NONE = 0.4;

const MAX_CANDIDATES_PER_QUERY = 10;

// ── Input schema (MUST match generate-silver-labels.ts InputLineSchema) ────

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
type InputCandidate = z.infer<typeof CandidateSchema>;

// ── CLI ────────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly input: string;
  readonly output: string;
  readonly help: boolean;
}

function printHelp(): void {
  process.stderr.write(`
generate-silver-labels-stub — offline deterministic silver label generator

Usage:
  npx tsx scripts/eval/generate-silver-labels-stub.ts [options]

Options:
  --input <path>       Input NDJSON. Default: external fixture relevance labeling corpus
  --output <path>      Output NDJSON. Default: ${DEFAULT_OUTPUT}
  --help, -h           Show this help and exit.
`);
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  let input = requireFixtureCorpusPath(
    RELEVANCE_LABELING_INPUT_CORPUS,
    'generate-silver-labels-stub default input resolution',
  );
  let output = DEFAULT_OUTPUT;
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
      default:
        break;
    }
  }

  return { input, output, help };
}

// ── Stub grading ───────────────────────────────────────────────────────────

interface StubDecision {
  readonly grade: RelevanceGrade;
  readonly confidence: number;
  readonly rationale: string;
}

/**
 * Deterministic 32-bit FNV-1a hash. Used only as a stable key for the stub
 * decision rotation — same input always yields the same bucket, with no
 * reliance on iteration order or Math.random.
 */
function fnv1a(input: string): number {
  let hash = 0x811c_9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic labeling decision. Pure function — same (query, candidate)
 * always yields the same result. No Math.random, no Date, no env.
 *
 * Decision tree:
 *  1. If canonicalLabel / region / grapes / style tokens overlap with the
 *     query tokens, return a strong match (grade 3, gold bucket).
 *  2. Otherwise, rotate through {MEDIUM, WEAK, NONE} via an FNV-1a hash of
 *     the (queryId-free) entityId+query pair so the stub exercises all three
 *     promoter buckets even when the fixture has no semantic overlap.
 */
export function stubGrade(query: string, candidate: InputCandidate): StubDecision {
  const qTokens = new Set(tokenize(query));
  const labelTokens = new Set(tokenize(candidate.canonicalLabel));

  let primaryOverlap = 0;
  for (const t of qTokens) if (labelTokens.has(t)) primaryOverlap++;

  if (primaryOverlap >= 2) {
    return {
      grade: 3,
      confidence: STUB_CONF_STRONG,
      rationale: `stub: ${primaryOverlap} canonical-label tokens match`,
    };
  }
  if (primaryOverlap === 1) {
    return {
      grade: 3,
      confidence: STUB_CONF_STRONG,
      rationale: 'stub: canonical-label token match',
    };
  }

  // Secondary signals: region / grapes / style.
  const secondary = new Set<string>();
  if (candidate.region) for (const t of tokenize(candidate.region)) secondary.add(t);
  if (candidate.grapes) {
    for (const g of candidate.grapes) for (const t of tokenize(g)) secondary.add(t);
  }
  if (candidate.style) for (const t of tokenize(candidate.style)) secondary.add(t);

  let secondaryOverlap = 0;
  for (const t of qTokens) if (secondary.has(t)) secondaryOverlap++;

  if (secondaryOverlap > 0) {
    return {
      grade: 2,
      confidence: STUB_CONF_STRONG,
      rationale: `stub: ${secondaryOverlap} region/grape/style token match`,
    };
  }

  // No semantic signal — rotate through the three non-gold buckets so the
  // pipeline exercises audit + rejected branches in every fixture.
  const bucket = fnv1a(`${candidate.entityId}|${query}`) % 3;
  if (bucket === 0) {
    return {
      grade: 2,
      confidence: STUB_CONF_MEDIUM,
      rationale: 'stub: deterministic rotation (audit)',
    };
  }
  if (bucket === 1) {
    return {
      grade: 1,
      confidence: STUB_CONF_WEAK,
      rationale: 'stub: deterministic rotation (audit-low)',
    };
  }
  return {
    grade: 0,
    confidence: STUB_CONF_NONE,
    rationale: 'stub: deterministic rotation (reject)',
  };
}

// ── Input loader (mirrors generate-silver-labels.ts loadInput) ─────────────

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
        'generate-silver-labels-stub: skipping malformed input line',
      );
      continue;
    }
    const result = InputLineSchema.safeParse(json);
    if (!result.success) {
      bootstrapLogger.warn(
        { file: filePath, lineNumber: i + 1, issues: result.error.issues },
        'generate-silver-labels-stub: skipping input line that failed schema validation',
      );
      continue;
    }
    out.push(result.data);
  }
  return out;
}

// ── Pipeline ───────────────────────────────────────────────────────────────

export interface StubRunResult {
  readonly judgmentsWritten: number;
  readonly gradeCounts: Readonly<Record<RelevanceGrade, number>>;
  readonly outputPath: string;
}

export async function runStubLabeler(args: CliArgs): Promise<StubRunResult> {
  const inputs = await loadInput(args.input);
  const gradeCounts: Record<RelevanceGrade, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  const outHandle = await fs.open(args.output, 'w');
  let written = 0;
  try {
    for (const line of inputs) {
      for (const candidate of line.candidates) {
        const decision = stubGrade(line.query, candidate);
        const judgment: RelevanceJudgment = {
          queryId: line.queryId,
          query: line.query,
          entityId: candidate.entityId,
          canonicalLabel: candidate.canonicalLabel,
          grade: decision.grade,
          confidence: decision.confidence,
          source: 'llm_silver',
          labelerModel: STUB_MODEL_NAME,
          rationale: decision.rationale,
        };
        await outHandle.write(`${JSON.stringify(judgment)}\n`);
        gradeCounts[decision.grade]++;
        written++;
      }
    }
  } finally {
    await outHandle.close();
  }

  return { judgmentsWritten: written, gradeCounts, outputPath: args.output };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  process.stderr.write(
    `generate-silver-labels-stub: input=${args.input} output=${args.output}\n`,
  );

  const result = await runStubLabeler(args);
  process.stderr.write(
    `generate-silver-labels-stub: wrote ${result.judgmentsWritten} judgments to ${result.outputPath}\n`,
  );
  process.stderr.write('grade distribution:\n');
  for (const g of [0, 1, 2, 3] as const) {
    process.stderr.write(`  grade ${g}: ${result.gradeCounts[g]}\n`);
  }
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`generate-silver-labels-stub: fatal: ${msg}\n`);
    process.exit(1);
  });
}
