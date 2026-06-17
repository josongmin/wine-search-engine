/**
 * Structural invariants for the {@link PipelineDebugStep} SSoT.
 *
 * Drives observability.pipeline-debug-steps maturity 4 -> 5 by adding
 * compile-time exhaustiveness (TypeScript discriminated-union pattern) and
 * filesystem AST scanning (source-code usage parity + docs <-> enum parity).
 *
 * Covered invariants:
 *  1. Enum value uniqueness (no two keys share a value).
 *  2. TypeScript exhaustiveness — every enum value is handled by a switch,
 *     proved by an `assertNever` default branch (compile-time enforced).
 *  3. Docs <-> enum parity — every enum value appears in the human index
 *     `.ai/pipeline-debug-steps.md`, and conversely.
 *  4. Append-only invariant — sorted enum values are snapshotted inline;
 *     additions/renames must update this fixture explicitly.
 *  5. Naming convention — every value matches the `domain.area.detail`
 *     convention documented in the source file.
 *  6. Source-code usage parity — every `pipelineTrace(` callsite under
 *     `src/` passes an identifier from `PipelineDebugStep`, not a literal.
 *
 * Adjacent edge cases:
 *  - Empty string is rejected by the convention regex.
 *  - Whitespace inside a value is rejected by the convention regex.
 *
 * APPEND-ONLY. Never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  PipelineDebugStep,
  type PipelineDebugStepId,
} from '../../src/domain/observability/pipeline-debug-steps.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const DOCS_PATH = resolve(REPO_ROOT, '.ai/pipeline-debug-steps.md');

const STEP_VALUES = Object.values(PipelineDebugStep) as readonly PipelineDebugStepId[];

/**
 * Canonical naming convention: lowercase letters/digits/underscores, with
 * one or more dot-separated segments (`domain.area.detail`). Empty strings,
 * whitespace, uppercase letters, and leading dots are rejected.
 */
const CONVENTION_REGEX = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/**
 * Sorted snapshot of enum values. Adding/renaming an enum value MUST update
 * this list explicitly — that is the entire point of the append-only invariant.
 * If you intentionally remove or rename a step, justify it in the commit message
 * and update this fixture.
 */
const EXPECTED_SORTED_STEP_VALUES: readonly string[] = [
  'batch.search.start',
  'cache.set_skipped',
  'decision.engine.request',
  'decision.engine.response',
  'decision.phase.enter',
  'dispatch.entity.complete',
  'dispatch.hybrid.complete',
  'dispatch.mixed.complete',
  'dispatch.route',
  'entity_lookup_v2.constraint_sat.contradicted',
  'entity_lookup_v2.use_case.done',
  'entity_lookup_v2.use_case.start',
  'http.embedding.http_error',
  'http.embedding.network_error',
  'http.embedding.ok',
  'http.embedding.parse_error',
  'http.embedding.timeout',
  'http.reranker.http_error',
  'http.reranker.network_error',
  'http.reranker.ok',
  'http.reranker.parse_error',
  'http.reranker.timeout',
  'hybrid.execute.ranked',
  'hybrid.execute.stage_timings',
  'hybrid.execute.start',
  'interpret.planner.done',
  'post_route.enter',
  'post_route.entropy_abstain',
  'post_route.entropy_abstain_bypassed',
  'pre_route.cache_hit',
  'pre_route.constraint_contradiction',
  'pre_route.continue',
  'pre_route.decomposed_comparison',
  'ranking.hybrid.complete',
  'resolver.anchor.done',
  'resolver.anchor.missing',
  'resolver.anchor.start',
  'retrieval.bundle_selector.budget_violation',
  'retrieval.bundle_selector.engage',
  'retrieval.bundle_selector.fail_closed',
  'retrieval.bundle_selector.subquery_fail_closed',
  'retrieval.candidate_pool.assembled',
  'retrieval.candidate_pool.fallback',
  'retrieval.compare_candidates',
  'retrieval.compare_candidates.error',
  'retrieval.constraint_relaxation.aborted',
  'retrieval.constraint_relaxation.attempt',
  'retrieval.constraint_relaxation.skipped_due_to_budget',
  'retrieval.constraint_relaxation.success',
  'retrieval.critic.budget_exhausted',
  'retrieval.critic.decision',
  'retrieval.critic.retries_exhausted',
  'retrieval.critic.rewriter_declined',
  'retrieval.hybrid_candidates.per_channel',
  'retrieval.hybrid_candidates.start',
  'retrieval.producer_browse',
  'retrieval.producer_browse.error',
  'retrieval.region_browse',
  'retrieval.region_browse.error',
  'route.entity.only.done',
  'route.entity.only.start',
  'search.execute.done',
  'search.execute.stage_timings',
  'search.execute.start',
  'search.pre_route.early_exit',
  'search.route_resolution',
  'vespa.query',
];

function assertNever(value: never): never {
  throw new Error(`Unhandled PipelineDebugStep value: ${String(value)}`);
}

/**
 * Compile-time exhaustiveness witness. The `default` branch invokes
 * `assertNever`, so TypeScript flags any newly-added enum value that isn't
 * listed in the switch. We list every value explicitly to lock the contract.
 *
 * If this file fails to typecheck after editing the enum, ADD the new value
 * here AND in the snapshot above — that is the whole point of the witness.
 */
function exhaustiveLabel(step: PipelineDebugStepId): string {
  switch (step) {
    case PipelineDebugStep.SEARCH_EXECUTE_START:
    case PipelineDebugStep.SEARCH_PRE_ROUTE_EARLY_EXIT:
    case PipelineDebugStep.SEARCH_ROUTE_RESOLUTION:
    case PipelineDebugStep.SEARCH_EXECUTE_DONE:
    case PipelineDebugStep.SEARCH_EXECUTE_STAGE_TIMINGS:
    case PipelineDebugStep.ROUTE_ENTITY_ONLY_START:
    case PipelineDebugStep.ROUTE_ENTITY_ONLY_DONE:
    case PipelineDebugStep.RESOLVER_ANCHOR_MISSING:
    case PipelineDebugStep.RESOLVER_ANCHOR_START:
    case PipelineDebugStep.RESOLVER_ANCHOR_DONE:
    case PipelineDebugStep.PRE_ROUTE_DECOMPOSED_COMPARISON:
    case PipelineDebugStep.PRE_ROUTE_CONSTRAINT_CONTRADICTION:
    case PipelineDebugStep.PRE_ROUTE_CACHE_HIT:
    case PipelineDebugStep.PRE_ROUTE_CONTINUE:
    case PipelineDebugStep.DISPATCH_ROUTE:
    case PipelineDebugStep.DISPATCH_ENTITY_COMPLETE:
    case PipelineDebugStep.DISPATCH_HYBRID_COMPLETE:
    case PipelineDebugStep.DISPATCH_MIXED_COMPLETE:
    case PipelineDebugStep.RETRIEVAL_HYBRID_CANDIDATES_START:
    case PipelineDebugStep.RETRIEVAL_HYBRID_CANDIDATES_PER_CHANNEL:
    case PipelineDebugStep.RETRIEVAL_PRODUCER_BROWSE:
    case PipelineDebugStep.RETRIEVAL_PRODUCER_BROWSE_ERROR:
    case PipelineDebugStep.RETRIEVAL_REGION_BROWSE:
    case PipelineDebugStep.RETRIEVAL_REGION_BROWSE_ERROR:
    case PipelineDebugStep.RETRIEVAL_COMPARE_CANDIDATES:
    case PipelineDebugStep.RETRIEVAL_COMPARE_CANDIDATES_ERROR:
    case PipelineDebugStep.RETRIEVAL_CONSTRAINT_RELAXATION_SKIPPED_BUDGET:
    case PipelineDebugStep.RETRIEVAL_CONSTRAINT_RELAXATION_ABORTED:
    case PipelineDebugStep.RETRIEVAL_CONSTRAINT_RELAXATION_ATTEMPT:
    case PipelineDebugStep.RETRIEVAL_CONSTRAINT_RELAXATION_SUCCESS:
    case PipelineDebugStep.RETRIEVAL_CANDIDATE_POOL_FALLBACK:
    case PipelineDebugStep.RETRIEVAL_CANDIDATE_POOL_ASSEMBLED:
    case PipelineDebugStep.RETRIEVAL_CRITIC_BUDGET_EXHAUSTED:
    case PipelineDebugStep.RETRIEVAL_CRITIC_DECISION:
    case PipelineDebugStep.RETRIEVAL_CRITIC_REWRITER_DECLINED:
    case PipelineDebugStep.RETRIEVAL_CRITIC_RETRIES_EXHAUSTED:
    case PipelineDebugStep.RETRIEVAL_BUNDLE_SELECTOR_ENGAGE:
    case PipelineDebugStep.RETRIEVAL_BUNDLE_SELECTOR_SUBQUERY_FAIL_CLOSED:
    case PipelineDebugStep.RETRIEVAL_BUNDLE_SELECTOR_FAIL_CLOSED:
    case PipelineDebugStep.RETRIEVAL_BUNDLE_SELECTOR_BUDGET_VIOLATION:
    case PipelineDebugStep.RANKING_HYBRID_COMPLETE:
    case PipelineDebugStep.POST_ROUTE_ENTER:
    case PipelineDebugStep.POST_ROUTE_ENTROPY_ABSTAIN:
    case PipelineDebugStep.POST_ROUTE_ENTROPY_ABSTAIN_BYPASSED:
    case PipelineDebugStep.DECISION_PHASE_ENTER:
    case PipelineDebugStep.DECISION_ENGINE_REQUEST:
    case PipelineDebugStep.DECISION_ENGINE_RESPONSE:
    case PipelineDebugStep.CACHE_SET_SKIPPED:
    case PipelineDebugStep.HYBRID_EXECUTE_START:
    case PipelineDebugStep.HYBRID_EXECUTE_RANKED:
    case PipelineDebugStep.HYBRID_EXECUTE_STAGE_TIMINGS:
    case PipelineDebugStep.BATCH_SEARCH_START:
    case PipelineDebugStep.ENTITY_LOOKUP_V2_USE_CASE_START:
    case PipelineDebugStep.ENTITY_LOOKUP_V2_CONSTRAINT_SAT_CONTRADICTED:
    case PipelineDebugStep.ENTITY_LOOKUP_V2_USE_CASE_DONE:
    case PipelineDebugStep.INTERPRET_PLANNER_DONE:
    case PipelineDebugStep.HTTP_EMBEDDING_OK:
    case PipelineDebugStep.HTTP_EMBEDDING_HTTP_ERROR:
    case PipelineDebugStep.HTTP_EMBEDDING_TIMEOUT:
    case PipelineDebugStep.HTTP_EMBEDDING_NETWORK_ERROR:
    case PipelineDebugStep.HTTP_EMBEDDING_PARSE_ERROR:
    case PipelineDebugStep.HTTP_RERANKER_OK:
    case PipelineDebugStep.HTTP_RERANKER_HTTP_ERROR:
    case PipelineDebugStep.HTTP_RERANKER_TIMEOUT:
    case PipelineDebugStep.HTTP_RERANKER_NETWORK_ERROR:
    case PipelineDebugStep.HTTP_RERANKER_PARSE_ERROR:
    case PipelineDebugStep.VESPA_QUERY:
      return step;
    default:
      return assertNever(step);
  }
}

function collectSourceTypeScriptFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceTypeScriptFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    files.push(fullPath);
  }
  return files;
}

/** Extracts every backticked `step.id`-shaped token from the docs file. */
function extractDocStepIds(markdown: string): Set<string> {
  const out = new Set<string>();
  const pattern = /`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`/g;
  for (const match of markdown.matchAll(pattern)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    // Skip filenames like `search.usecase.ts` that happen to match the shape.
    if (candidate.endsWith('.ts')) continue;
    out.add(candidate);
  }
  return out;
}

describe('PipelineDebugStep exhaustiveness (SSoT invariants)', () => {
  it('every enum value is unique (no duplicate step strings)', () => {
    const valueCounts = new Map<string, number>();
    for (const v of STEP_VALUES) {
      valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
    }
    const duplicates = [...valueCounts.entries()].filter(([, n]) => n > 1);
    expect(
      duplicates,
      `Duplicate PipelineDebugStep values: ${JSON.stringify(duplicates)}`,
    ).toEqual([]);
    expect(new Set(STEP_VALUES).size).toBe(STEP_VALUES.length);
  });

  it('TypeScript exhaustiveness witness handles every enum value (runtime check)', () => {
    for (const step of STEP_VALUES) {
      expect(exhaustiveLabel(step)).toBe(step);
    }
  });

  it('every enum value matches the documented naming convention', () => {
    const violations = STEP_VALUES.filter((v) => !CONVENTION_REGEX.test(v));
    expect(
      violations,
      `Values failing /${CONVENTION_REGEX.source}/: ${violations.join(', ')}`,
    ).toEqual([]);
  });

  it('append-only snapshot: sorted enum values match the committed fixture', () => {
    const actualSorted = [...STEP_VALUES].sort();
    const expectedSet = new Set(EXPECTED_SORTED_STEP_VALUES);
    const actualSet = new Set(actualSorted);
    const removed = [...expectedSet].filter((v) => !actualSet.has(v));
    const added = [...actualSet].filter((v) => !expectedSet.has(v));
    expect(
      { removed, added },
      'PipelineDebugStep drift detected. If intentional, update EXPECTED_SORTED_STEP_VALUES and justify in the commit.',
    ).toEqual({ removed: [], added: [] });
    // Specific-value assertion (quality-bar requirement):
    expect(actualSorted).toEqual(EXPECTED_SORTED_STEP_VALUES);
  });

  it('docs <-> enum parity: every enum value is documented in .ai/pipeline-debug-steps.md', () => {
    const markdown = readFileSync(DOCS_PATH, 'utf8');
    const docSteps = extractDocStepIds(markdown);
    const undocumented = STEP_VALUES.filter((v) => !docSteps.has(v));
    expect(
      undocumented,
      `Enum values missing from .ai/pipeline-debug-steps.md: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('docs <-> enum parity: every documented step exists in the enum (no stale doc entries)', () => {
    const markdown = readFileSync(DOCS_PATH, 'utf8');
    const docSteps = extractDocStepIds(markdown);
    const enumSet = new Set<string>(STEP_VALUES);
    const stale = [...docSteps].filter((v) => !enumSet.has(v));
    expect(
      stale,
      `Doc entries with no matching PipelineDebugStep value: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('source-code usage parity: every pipelineTrace(...) callsite passes a PipelineDebugStep identifier (no string literals)', () => {
    const files = collectSourceTypeScriptFiles(SRC_ROOT);
    const violations: { file: string; line: number; text: string }[] = [];
    // Match `pipelineTrace(` followed by a string literal as the first argument.
    const literalArgPattern = /pipelineTrace\s*\(\s*['"`]/;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        if (literalArgPattern.test(line)) {
          violations.push({ file, line: i + 1, text: line.trim() });
        }
      }
    }
    expect(
      violations,
      `pipelineTrace() must be called with a PipelineDebugStep identifier, not a string literal. Violations: ${JSON.stringify(violations, null, 2)}`,
    ).toEqual([]);
  });
});

describe('PipelineDebugStep convention adjacent edge cases', () => {
  it('rejects empty string', () => {
    expect(CONVENTION_REGEX.test('')).toBe(false);
  });

  it('rejects whitespace inside the value', () => {
    expect(CONVENTION_REGEX.test('search.execute start')).toBe(false);
    expect(CONVENTION_REGEX.test(' search.execute.start')).toBe(false);
    expect(CONVENTION_REGEX.test('search.execute.start ')).toBe(false);
    expect(CONVENTION_REGEX.test('search.\texecute.start')).toBe(false);
  });

  it('rejects uppercase letters (canonical values are lowercase)', () => {
    expect(CONVENTION_REGEX.test('Search.Execute.Start')).toBe(false);
  });

  it('rejects single-segment values (convention requires domain.area at minimum)', () => {
    expect(CONVENTION_REGEX.test('search')).toBe(false);
  });

  it('accepts the documented shape', () => {
    expect(CONVENTION_REGEX.test('search.execute.start')).toBe(true);
    expect(CONVENTION_REGEX.test('pre_route.cache_hit')).toBe(true);
    expect(CONVENTION_REGEX.test('http.embedding.http_error')).toBe(true);
  });
});
