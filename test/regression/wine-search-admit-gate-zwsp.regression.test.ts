/**
 * P-L1 — admit-gate zero-width-character regression.
 *
 * Before the P-L1 fix, `WineSearchOrchestrator.runAdmitGate` used
 * `String.prototype.trim()` which strips only Unicode WhiteSpace property
 * runs. ZWSP (U+200B), ZWNJ (U+200C), ZWJ (U+200D), and BOM (U+FEFF) are
 * NOT WhiteSpace, so a query containing only those characters survived the
 * gate, propagated into the analyzer, and surfaced as a Layer-4 fallback
 * with confusing termination reasons.
 *
 * After the fix:
 *   - The admit gate strips zero-width characters BEFORE the trim check.
 *   - A query of only ZWSPs is rejected as empty by the admit gate
 *     (S1 semantic split: unsupported_intent, NOT security_block).
 *   - Mixed queries (ZWSP + real content) keep flowing — the strip only
 *     affects the gate decision; the inner pipeline sees the original
 *     query.
 *
 * Also covers the secondary P-L1 issue: the HTTP request schema now bounds
 * `query` by codepoints (not UTF-16 code units), so emoji-only queries at
 * the documented limit are accepted and over-limit are rejected with a
 * 400.
 *
 * Append-only regression — CLAUDE.md test-discipline rule.
 */

import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type {
  AnalyzeRequest,
  AnalyzeResult,
  ExecuteRequest,
  ExecuteResult,
  StructuredLlmPort,
  SynthesizeRequest,
  TokenUsage,
} from '../../src/domain/ai/port/structured-llm.port.js';

import { DeterministicRouter } from '../../src/application/wine-search/deterministic-router.js';
import { ExecutionRunner } from '../../src/application/wine-search/execution-runner.js';
import { WineAgentLoopRunner } from '../../src/application/wine-search/wine-agent-loop.js';
import { QueryAnalyzerService } from '../../src/application/wine-search/query-analyzer.js';
import { SynthesisRunner } from '../../src/application/wine-search/synthesis-runner.js';
import { type SynthesisAnswer } from '../../src/application/wine-search/synthesis-schemas.js';
import {
  WineSearchOrchestrator,
  type WineSearchInput,
} from '../../src/application/wine-search/wine-search-orchestrator.js';
import { TERMINATION_KIND_UNSUPPORTED_INTENT } from '../../src/application/wine-search/wine-search-result-schemas.js';
import { WineSearchRequestSchema } from '../../src/interface/http/schemas/wine-search.schema.js';
import { MAX_AGENT_HTTP_QUERY_CHARS } from '../../src/interface/http/constants.js';
import type { SearchUseCasePort } from '../../src/application/wine-search/execution-runner.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

const ZWSP = '​';
const ZWNJ = '‌';
const ZWJ = '‍';
const BOM = '﻿';

const REQUEST_ID = 'req-p-l1-zwsp';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeTokenUsage(input: number, output: number): TokenUsage {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function makeSearchResponse(entityIds: readonly string[]): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results: entityIds.map((id) => ({
      entity: { entityId: id, canonicalLabel: `Wine ${id}` },
    })) as unknown as SearchResponseV1['results'],
    meta: { generatedAt: new Date().toISOString() } as unknown as SearchResponseV1['meta'],
  };
}

function makeStubLlm(): StructuredLlmPort {
  const defaultSynth: SynthesisAnswer = { answer: 'Default synth.', citations: [] };
  return {
    analyze: ((_req: AnalyzeRequest<z.ZodTypeAny>): Promise<AnalyzeResult<unknown>> => {
      throw new Error('analyze should not be called');
    }) as StructuredLlmPort['analyze'],
    execute: ((_req: ExecuteRequest): Promise<ExecuteResult> => {
      throw new Error('execute should not be called');
    }) as StructuredLlmPort['execute'],
    synthesize: (((_req: SynthesizeRequest<z.ZodTypeAny>) =>
      Promise.resolve({
        data: defaultSynth,
        usage: makeTokenUsage(0, 0),
        durationMs: 5,
      })) as unknown) as StructuredLlmPort['synthesize'],
  };
}

function makeSearchPort(): SearchUseCasePort {
  return { execute: () => Promise.resolve(makeSearchResponse(['wine-1'])) };
}

function buildOrchestrator() {
  const llm = makeStubLlm();
  const logger = makeLogger();
  const queryAnalyzer = new QueryAnalyzerService({ structuredLlm: undefined, logger });
  const router = new DeterministicRouter();
  const executionRunner = new ExecutionRunner({ searchUseCase: makeSearchPort() });
  const wineAgentLoopRunner = new WineAgentLoopRunner({ structuredLlm: llm, logger });
  const synthesisRunner = new SynthesisRunner({ structuredLlm: llm, logger });
  return new WineSearchOrchestrator({
    queryAnalyzer,
    router,
    executionRunner,
    wineAgentLoopRunner,
    synthesisRunner,
    logger,
  });
}

function runInput(query: string): WineSearchInput {
  // T-MTA-01: messages-native input — the single query becomes one user
  // message; the admit-gate ZWSP-strip semantics apply to the anchor.
  return { messages: [{ role: 'user', content: query }], requestId: REQUEST_ID };
}

// ---------------------------------------------------------------------------
// 1. Admit-gate strips ZWSPs before trim.
// ---------------------------------------------------------------------------

describe('P-L1 — admit gate strips zero-width characters before trim', () => {
  it('ZWSP-only query is rejected as empty (kind=unsupported_intent)', async () => {
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.execute(runInput(`${ZWSP}${ZWSP}${ZWSP}`));

    expect(result.terminationReason).toBe('blocked');
    expect(result.terminationKind).toBe(TERMINATION_KIND_UNSUPPORTED_INTENT);
    expect(result.planKind).toBe('reject');
    // The admit-gate step is recorded as `rejected_at_gate: empty_query`.
    const gateStep = result.executionSteps.find(
      (s) => s.source === 'analyzer' && s.summary.startsWith('rejected_at_gate:'),
    );
    expect(gateStep?.summary).toBe('rejected_at_gate: empty_query');
  });

  it('ZWNJ / ZWJ / BOM only query is also rejected as empty', async () => {
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.execute(runInput(`${ZWNJ}${ZWJ}${BOM}`));

    expect(result.terminationReason).toBe('blocked');
    expect(result.terminationKind).toBe(TERMINATION_KIND_UNSUPPORTED_INTENT);
    expect(result.planKind).toBe('reject');
  });

  it('mixed query "  ZWSP wine ZWSP  " strips zero-widths and admits the surrounding content', async () => {
    const orchestrator = buildOrchestrator();
    // After strip+trim → "wine" is admitted; analyzer runs (sees the
    // original query with ZWSPs intact — strip only affects the GATE
    // decision, not the downstream pipeline). The runner reaches the
    // synthesizer.
    const result = await orchestrator.execute(
      runInput(`  ${ZWSP}  Burgundy Pinot Noir  ${ZWSP}  `),
    );

    // Admit-gate did NOT reject (no `rejected_at_gate:` step exists).
    const gateRejectStep = result.executionSteps.find(
      (s) => s.summary.startsWith('rejected_at_gate:'),
    );
    expect(gateRejectStep).toBeUndefined();
    // The orchestrator reached the analyzer + router phases.
    const sources = result.executionSteps.map((s) => s.source);
    expect(sources).toContain('analyzer');
  });

  it('whitespace + ZWSP combination is still rejected as empty', async () => {
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.execute(
      runInput(`  ${ZWSP} ${ZWNJ}   ${BOM}   `),
    );

    expect(result.terminationReason).toBe('blocked');
    expect(result.terminationKind).toBe(TERMINATION_KIND_UNSUPPORTED_INTENT);
  });
});

// ---------------------------------------------------------------------------
// 2. Codepoint-bound HTTP query length (P-L1 secondary fix).
// ---------------------------------------------------------------------------

describe('P-L1 — HTTP query length is bounded by codepoints, not UTF-16 code units', () => {
  it('ASCII query at exactly MAX_AGENT_HTTP_QUERY_CHARS passes Zod', () => {
    const at = 'a'.repeat(MAX_AGENT_HTTP_QUERY_CHARS);
    expect(WineSearchRequestSchema.safeParse({ query: at }).success).toBe(true);
  });

  it('Emoji query at exactly MAX_AGENT_HTTP_QUERY_CHARS codepoints passes Zod (was rejected before P-L1 fix)', () => {
    // Each '🍷' is one codepoint but two UTF-16 code units. The previous
    // `.max(N)` would have measured 2*N code units and rejected this.
    const atCodepoints = '🍷'.repeat(MAX_AGENT_HTTP_QUERY_CHARS);
    // Iterator-based codepoint count (no spread — see lint rule
    // `no-misused-spread`).
    let cpCount = 0;
    for (const ch of atCodepoints) { void ch; cpCount += 1; }
    expect(cpCount).toBe(MAX_AGENT_HTTP_QUERY_CHARS);
    expect(WineSearchRequestSchema.safeParse({ query: atCodepoints }).success).toBe(true);
  });

  it('Emoji query just-over MAX_AGENT_HTTP_QUERY_CHARS codepoints is rejected', () => {
    const overCodepoints = '🍷'.repeat(MAX_AGENT_HTTP_QUERY_CHARS + 1);
    const result = WineSearchRequestSchema.safeParse({ query: overCodepoints });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The error message documents the codepoint boundary.
      expect(JSON.stringify(result.error.issues)).toMatch(/codepoints/u);
    }
  });

  it('Korean (hangul, BMP) query at MAX_AGENT_HTTP_QUERY_CHARS passes Zod', () => {
    const at = '가'.repeat(MAX_AGENT_HTTP_QUERY_CHARS);
    expect(WineSearchRequestSchema.safeParse({ query: at }).success).toBe(true);
  });
});
