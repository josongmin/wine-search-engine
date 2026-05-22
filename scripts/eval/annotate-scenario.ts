#!/usr/bin/env npx tsx
/**
 * Scenario annotation CLI.
 *
 * Usage:
 *   tsx scripts/eval/annotate-scenario.ts <scenarioId>
 *     # Prints the scenario block, opens an annotation prompt on stdin.
 *     # Save by writing a JSON object to stdin and closing it (EOF / Ctrl-D).
 *     # The CLI validates with Zod and writes
 *     # test/benchmark/agent/annotations/<scenarioId>.json on success.
 *
 *   tsx scripts/eval/annotate-scenario.ts <scenarioId> --from <path>
 *     # Read JSON annotation from a file (non-interactive). Useful in batch
 *     # seed scripts and CI.
 *
 *   tsx scripts/eval/annotate-scenario.ts --list
 *     # List every scenario id with an existing annotation file.
 *
 * Validation is via `parseScenarioAnnotation` — bad input fails loudly with
 * the field path that broke (no silent partial saves).
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import {
  parseScenarioAnnotation,
  scenarioAnnotationSchema,
  type ScenarioAnnotation,
} from '../../test/benchmark/agent/annotation-schema.js';
import { defaultAnnotationDir } from '../../test/benchmark/agent/annotation-loader.js';
import { AGENT_SCENARIOS } from '../../test/benchmark/agent/scenarios.js';
import type { AgentBenchmarkScenario } from '../../test/benchmark/agent/scenario.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ─── helpers ───────────────────────────────────────────────────────────────

interface CliArgs {
  readonly scenarioId?: number;
  readonly fromPath?: string;
  readonly list: boolean;
  readonly print: boolean;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const list = argv.includes('--list');
  const print = argv.includes('--print');
  const fromIdx = argv.indexOf('--from');
  const fromPath = fromIdx >= 0 && fromIdx + 1 < argv.length ? argv[fromIdx + 1] : undefined;

  let scenarioId: number | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--')) continue;
    const n = Number.parseInt(arg, 10);
    if (Number.isFinite(n)) { scenarioId = n; break; }
  }

  return {
    ...(scenarioId !== undefined ? { scenarioId } : {}),
    ...(fromPath !== undefined ? { fromPath } : {}),
    list,
    print,
  };
}

function findScenario(id: number): AgentBenchmarkScenario | undefined {
  return AGENT_SCENARIOS.find((s) => s.id === id);
}

function readStdin(): Promise<string> {
  return new Promise((resolveInner, rejectInner) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { buf += chunk; });
    process.stdin.on('end', () => resolveInner(buf));
    process.stdin.on('error', rejectInner);
  });
}

async function listAnnotations(): Promise<void> {
  const dir = defaultAnnotationDir();
  let entries: readonly string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    console.error(`(no annotations at ${dir})`);
    return;
  }
  const annotated = entries
    .filter((e) => e.endsWith('.json'))
    .map((e) => Number.parseInt(e.replace(/\.json$/u, ''), 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  console.error(`Annotated scenarios (${annotated.length}):`);
  console.error(annotated.join(', '));
}

function printScenarioBlock(scenario: AgentBenchmarkScenario): void {
  console.error(`\n── Scenario #${scenario.id} (${scenario.tier}) ──`);
  console.error(`Query:       ${scenario.query}`);
  console.error(`Description: ${scenario.description}`);
  const exp = scenario.expectation;
  console.error(`maxSteps:    ${exp.maxSteps}`);
  if (exp.rubric !== undefined) console.error(`rubric:      ${exp.rubric.slice(0, 120)}…`);
  if (exp.answerContains !== undefined) console.error(`answerContains: ${JSON.stringify(exp.answerContains)}`);
  if (exp.answerExcludes !== undefined) console.error(`answerExcludes: ${JSON.stringify(exp.answerExcludes)}`);
  if (exp.expectedConstraints !== undefined) console.error(`expectedConstraints: ${JSON.stringify(exp.expectedConstraints, null, 2).slice(0, 500)}`);
  if (exp.terminationReason !== undefined) console.error(`terminationReason: ${exp.terminationReason}`);
  if (scenario.goldenKeywords !== undefined) console.error(`goldenKeywords: ${JSON.stringify(scenario.goldenKeywords)}`);
}

function printPromptTemplate(scenarioId: number): void {
  // Authoring template — printed to stderr so a `tee` to a JSON file is clean.
  const template = {
    scenarioId,
    annotatedBy: '<email or handle>',
    annotatedAt: new Date().toISOString(),
    notes: '<one-line rationale>',
    expectedConstraints: { hard: [], soft: [], inferred: [] },
    expectedEntities: [],
    expectedRetrievalIds: [],
    expectedClaims: { mustMention: [], mustNotMention: [] },
    expectedSteps: { min: 1, max: 3 },
    expectedTerminationReason: 'answer',
    expectedRubric: [],
  };
  console.error('\n── Annotation template (edit, then pipe to stdin or save to a file) ──');
  console.error(JSON.stringify(template, null, 2));
}

async function writeAnnotation(annotation: ScenarioAnnotation): Promise<string> {
  const dir = defaultAnnotationDir();
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `${annotation.scenarioId}.json`);
  await fs.writeFile(path, JSON.stringify(annotation, null, 2) + '\n', 'utf8');
  return path;
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.list) {
    await listAnnotations();
    return;
  }

  if (args.scenarioId === undefined) {
    console.error('USAGE: annotate-scenario <scenarioId> [--from <path>] [--print] [--list]');
    process.exit(2);
  }

  const scenario = findScenario(args.scenarioId);
  if (scenario === undefined) {
    console.error(`Scenario id=${args.scenarioId} not found in AGENT_SCENARIOS`);
    process.exit(3);
  }

  printScenarioBlock(scenario);

  if (args.print) {
    printPromptTemplate(scenario.id);
    return;
  }

  // Source the JSON: --from file, else stdin.
  let jsonText: string;
  if (args.fromPath !== undefined) {
    const fullPath = resolve(REPO_ROOT, args.fromPath);
    jsonText = await fs.readFile(fullPath, 'utf8');
  } else {
    printPromptTemplate(scenario.id);
    console.error('\n── Paste annotation JSON, then send EOF (Ctrl-D) ──');
    jsonText = await readStdin();
  }

  // CLAUDE.md rule 12: parse to unknown first, then validate.
  const raw = JSON.parse(jsonText) as unknown;
  // Force `scenarioId` to match the CLI arg — drift between CLI id and embedded id is a frequent mistake.
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    (raw as Record<string, unknown>)['scenarioId'] = scenario.id;
  }

  let annotation: ScenarioAnnotation;
  try {
    annotation = parseScenarioAnnotation(raw);
  } catch (err) {
    console.error(`\n[VALIDATION] Annotation rejected:`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(4);
  }

  // Sanity: confirm Zod round-trip is loss-less (catches "as" cast smuggling).
  scenarioAnnotationSchema.parse(annotation);

  const path = await writeAnnotation(annotation);
  console.error(`\n[OK] wrote ${path}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
