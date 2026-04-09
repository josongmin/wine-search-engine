#!/usr/bin/env tsx
/**
 * Bridge: benchmark scenarios → LLM labeling input NDJSON.
 *
 * For each scenario in `test/benchmark/agent/scenarios.ts`, emits one NDJSON
 * line shaped for `scripts/eval/generate-silver-labels.ts` InputLineSchema:
 *
 *   { queryId, query, candidates: [{entityId, canonicalLabel, ...}] }
 *
 * Candidates are chosen DETERMINISTICALLY from a catalog snapshot
 * (`data/entity-ontology.json`) via a simple keyword-overlap (Jaccard) score.
 * This is intentionally NOT a real retrieval — we want an offline, stable,
 * reproducible fixture for exercising the labeling pipeline end-to-end.
 *
 * Usage:
 *   npx tsx scripts/eval/scenarios-to-labeling-input.ts \
 *     --output data/relevance/scenarios-labeling-input.jsonl \
 *     --limit 50
 *
 *   npx tsx scripts/eval/scenarios-to-labeling-input.ts --help
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { bootstrapLogger } from '../../src/config/bootstrap-logger.js';
import { AGENT_SCENARIOS } from '../../test/benchmark/agent/scenarios.js';
import type { AgentBenchmarkScenario } from '../../test/benchmark/agent/scenario.js';

// ── Named constants ─────────────────────────────────────────────────────────

/** Default max scenarios to emit — keeps downstream labeling runs fast. */
export const DEFAULT_SCENARIO_LIMIT = 50;

/** Top-K candidates to emit per scenario (≤ labeler MAX_CANDIDATES_PER_QUERY). */
export const DEFAULT_TOP_K_CANDIDATES = 10;

/**
 * Minimum Jaccard score a candidate must reach to be emitted. Zero-overlap
 * "padding" candidates are unhelpful — they just force the downstream labeler
 * (real or stub) to grade irrelevant pairs and flood the rejected bucket. By
 * filtering to score > 0 we get a smaller, more informative fixture that
 * actually exercises the audit + gold promotion branches.
 */
export const MIN_OVERLAP_SCORE = Number.EPSILON;

/** Ontology snapshot path (deterministic catalog pool). */
export const DEFAULT_ONTOLOGY_PATH = 'data/entity-ontology.json';

/** Default output path. */
const DEFAULT_OUTPUT = 'data/relevance/scenarios-labeling-input.jsonl';

/** Minimum token length to be considered a content-bearing keyword. */
const MIN_TOKEN_LENGTH = 2;

// ── Ontology schema (permissive — we only read the fields we use) ──────────

const OntologyNodeSchema = z.object({
  id: z.string().min(1),
  entityType: z.string().min(1),
  canonicalLabel: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  parents: z.array(z.string()).default([]),
});

const OntologySchema = z.object({
  version: z.string().optional(),
  nodes: z.array(OntologyNodeSchema).min(1),
});

type OntologyNode = z.infer<typeof OntologyNodeSchema>;

// ── CLI ────────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly output: string;
  readonly limit: number;
  readonly topK: number;
  readonly ontology: string;
  readonly help: boolean;
}

function printHelp(): void {
  process.stderr.write(`
scenarios-to-labeling-input — benchmark scenarios → labeling input NDJSON

Usage:
  npx tsx scripts/eval/scenarios-to-labeling-input.ts [options]

Options:
  --output <path>      Output NDJSON path. Default: ${DEFAULT_OUTPUT}
  --limit <n>          Max scenarios to emit. Default: ${DEFAULT_SCENARIO_LIMIT}
  --top-k <n>          Candidates per scenario. Default: ${DEFAULT_TOP_K_CANDIDATES}
  --ontology <path>    Catalog snapshot JSON. Default: ${DEFAULT_ONTOLOGY_PATH}
  --help, -h           Show this help and exit.
`);
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  let output = DEFAULT_OUTPUT;
  let limit = DEFAULT_SCENARIO_LIMIT;
  let topK = DEFAULT_TOP_K_CANDIDATES;
  let ontology = DEFAULT_ONTOLOGY_PATH;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        help = true;
        break;
      case '--output':
        if (next) { output = next; i++; }
        break;
      case '--limit':
        if (next) { limit = Number.parseInt(next, 10); i++; }
        break;
      case '--top-k':
        if (next) { topK = Number.parseInt(next, 10); i++; }
        break;
      case '--ontology':
        if (next) { ontology = next; i++; }
        break;
      default:
        break;
    }
  }

  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_SCENARIO_LIMIT;
  if (!Number.isFinite(topK) || topK < 1) topK = DEFAULT_TOP_K_CANDIDATES;

  return { output, limit, topK, ontology, help };
}

// ── Tokenization ───────────────────────────────────────────────────────────

/**
 * Split text into lowercased content tokens. We intentionally use a Unicode
 * property-class boundary (`\p{L}\p{N}` as a character class) so Korean and
 * accented Latin text are tokenised, not silently dropped. `\b` would be
 * ASCII-only here — see CLAUDE.md test discipline rule 8.
 */
export function tokenize(text: string): readonly string[] {
  const lowered = text.normalize('NFKC').toLowerCase();
  const matches = lowered.match(/[\p{L}\p{N}]+/gu) ?? [];
  return matches.filter((t) => t.length >= MIN_TOKEN_LENGTH);
}

// ── Candidate scoring ──────────────────────────────────────────────────────

interface ScoredCandidate {
  readonly node: OntologyNode;
  readonly score: number;
}

/**
 * Build a keyword bag for an ontology node from canonical label + aliases +
 * parents + entity type (so "grape_primary:pinot noir" matches queries
 * mentioning "pinot noir" AND queries mentioning "grape").
 */
function nodeKeywordBag(node: OntologyNode): ReadonlySet<string> {
  const bag = new Set<string>();
  for (const tok of tokenize(node.canonicalLabel)) bag.add(tok);
  for (const alias of node.aliases) {
    for (const tok of tokenize(alias)) bag.add(tok);
  }
  for (const parent of node.parents) {
    for (const tok of tokenize(parent)) bag.add(tok);
  }
  for (const tok of tokenize(node.entityType.replace(/_/g, ' '))) bag.add(tok);
  return bag;
}

/**
 * Jaccard overlap between query tokens and node keyword bag. Deterministic:
 * no randomness, no iteration-order dependence.
 */
export function jaccardScore(
  queryTokens: ReadonlySet<string>,
  nodeBag: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0 || nodeBag.size === 0) return 0;
  let intersect = 0;
  for (const t of queryTokens) if (nodeBag.has(t)) intersect++;
  const union = queryTokens.size + nodeBag.size - intersect;
  return union > 0 ? intersect / union : 0;
}

/**
 * Pick the top-K candidates from the ontology for a given query.
 * Tie-break is deterministic on (score desc, id asc).
 */
export function pickTopKCandidates(
  query: string,
  nodes: readonly OntologyNode[],
  bags: ReadonlyMap<string, ReadonlySet<string>>,
  topK: number,
): readonly ScoredCandidate[] {
  const queryTokens = new Set(tokenize(query));
  const scored: ScoredCandidate[] = [];
  for (const node of nodes) {
    const bag = bags.get(node.id);
    if (!bag) continue;
    const score = jaccardScore(queryTokens, bag);
    scored.push({ node, score });
  }
  // Filter to candidates with meaningful overlap — avoids flooding the fixture
  // with lexicographically-padded zero-overlap "candidates" that only waste
  // labeler budget and never exercise the audit/gold branches.
  const filtered = scored.filter((s) => s.score >= MIN_OVERLAP_SCORE);
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.node.id.localeCompare(b.node.id);
  });
  return filtered.slice(0, topK);
}

// ── Candidate emission (ontology nodes → LabelingCandidate shape) ──────────

interface EmittedCandidate {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly region?: string;
  readonly grapes?: readonly string[];
  readonly style?: string;
}

function toEmittedCandidate(node: OntologyNode): EmittedCandidate {
  // Ontology nodes have no producer / vintage / price — only the shape we can
  // safely project. Use conditional spreads to respect exactOptionalPropertyTypes.
  const parentsNonEmpty = node.parents.filter((p) => p.length > 0);
  const regionHint = parentsNonEmpty[0];

  const isGrape = node.entityType === 'grape_primary';
  const isWineType = node.entityType === 'wine_type';

  return {
    entityId: node.id,
    canonicalLabel: node.canonicalLabel,
    ...(regionHint !== undefined ? { region: regionHint } : {}),
    ...(isGrape ? { grapes: [node.canonicalLabel] } : {}),
    ...(isWineType ? { style: node.canonicalLabel.toLowerCase() } : {}),
  };
}

// ── Output line ────────────────────────────────────────────────────────────

interface OutputLine {
  readonly queryId: string;
  readonly query: string;
  readonly candidates: readonly EmittedCandidate[];
}

function scenarioToQueryId(scenario: AgentBenchmarkScenario): string {
  return `scenario-${scenario.id}`;
}

// ── Core pipeline ──────────────────────────────────────────────────────────

async function loadOntology(filePath: string): Promise<readonly OntologyNode[]> {
  const raw = await fs.readFile(filePath, 'utf8');
  const json: unknown = JSON.parse(raw);
  const parsed = OntologySchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Ontology at ${filePath} failed schema validation: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data.nodes;
}

export interface BridgeResult {
  readonly linesWritten: number;
  readonly outputPath: string;
}

export async function runBridge(args: CliArgs): Promise<BridgeResult> {
  const nodes = await loadOntology(args.ontology);

  // Precompute keyword bags once — deterministic and O(|nodes|).
  const bags = new Map<string, ReadonlySet<string>>();
  for (const node of nodes) bags.set(node.id, nodeKeywordBag(node));

  const scenarios = AGENT_SCENARIOS.slice(0, args.limit);

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  const outHandle = await fs.open(args.output, 'w');

  let written = 0;
  try {
    for (const scenario of scenarios) {
      // Skip scenarios with empty / whitespace-only queries — the downstream
      // labeling InputLineSchema requires query.min(1).
      if (scenario.query.trim().length === 0) {
        bootstrapLogger.warn(
          { scenarioId: scenario.id },
          'scenarios-to-labeling-input: empty scenario query — skipping',
        );
        continue;
      }
      const scored = pickTopKCandidates(scenario.query, nodes, bags, args.topK);
      if (scored.length === 0) {
        bootstrapLogger.warn(
          { scenarioId: scenario.id },
          'scenarios-to-labeling-input: no ontology candidates — skipping',
        );
        continue;
      }
      const line: OutputLine = {
        queryId: scenarioToQueryId(scenario),
        query: scenario.query,
        candidates: scored.map((s) => toEmittedCandidate(s.node)),
      };
      await outHandle.write(`${JSON.stringify(line)}\n`);
      written++;
    }
  } finally {
    await outHandle.close();
  }

  return { linesWritten: written, outputPath: args.output };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  process.stderr.write(
    `scenarios-to-labeling-input: ontology=${args.ontology} limit=${args.limit} topK=${args.topK} output=${args.output}\n`,
  );

  const result = await runBridge(args);
  process.stderr.write(
    `scenarios-to-labeling-input: wrote ${result.linesWritten} lines to ${result.outputPath}\n`,
  );
  // Reference MIN_OVERLAP_SCORE so tuning knob remains discoverable.
  process.stderr.write(`  (min overlap score threshold: ${MIN_OVERLAP_SCORE})\n`);
}

// ── Entrypoint ─────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`scenarios-to-labeling-input: fatal: ${msg}\n`);
    process.exit(1);
  });
}
