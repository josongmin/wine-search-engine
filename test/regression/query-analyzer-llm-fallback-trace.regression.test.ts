/**
 * Regression — `QueryAnalyzerService` emits an explicit `llmFallbackOutcome`
 * trace on its result so the orchestrator can distinguish:
 *   (a) deterministic-only analyses (LLM not attempted),
 *   (b) genuine LLM successes,
 *   (c) LLM failures that PRESERVE `intent='unknown'` (no silent soften).
 *
 * Before this trace existed, branch (c) silently softened `intent='unknown'`
 * to `intent='search'`, masquerading an LLM outage as a confident search and
 * bypassing the deterministic-router's `unsupported_intent` reject. The
 * analyzer now keeps `intent='unknown'` and records the failure as
 * `failed_preserved_unknown`. See `src/application/wine-search/query-analyzer.ts`.
 *
 * This test is append-only per repo policy (CLAUDE.md "Test discipline").
 */

import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  StructuredLlmCircuitOpenError,
  StructuredLlmPartialOutputError,
  StructuredLlmRefusalError,
  StructuredLlmTimeoutError,
  StructuredLlmValidationError,
  type AnalyzeRequest,
  type AnalyzeResult,
  type ExecuteRequest,
  type ExecuteResult,
  type StructuredLlmPort,
  type SynthesizeRequest,
  type SynthesizeResult,
} from '@domain/ai/port/structured-llm.port.js';
import { QueryAnalyzerService } from '@app/wine-search/query-analyzer.js';
import { DeterministicRouter } from '@app/wine-search/deterministic-router.js';
import {
  WineSearchAnalysisSchema,
  type WineSearchAnalysis,
} from '@app/wine-search/wine-search-schemas.js';

const REQUEST_ID = 'req-llm-fallback-trace-0001';
const PER_STEP_TIMEOUT_MS = 5_000;

function makeLogger(): {
  logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
} {
  return { logger: { warn: vi.fn(), info: vi.fn() } };
}

interface StubLlmPort extends StructuredLlmPort {
  readonly analyzeMock: ReturnType<typeof vi.fn>;
}

function makeStubLlm(
  impl: (
    req: AnalyzeRequest<typeof WineSearchAnalysisSchema>,
  ) => Promise<AnalyzeResult<WineSearchAnalysis>>,
): StubLlmPort {
  const analyzeMock = vi.fn(impl);
  return {
    analyzeMock,
    analyze: <TSchema extends z.ZodTypeAny>(
      req: AnalyzeRequest<TSchema>,
    ): Promise<AnalyzeResult<z.infer<TSchema>>> =>
      analyzeMock(
        req as unknown as AnalyzeRequest<typeof WineSearchAnalysisSchema>,
      ) as unknown as Promise<AnalyzeResult<z.infer<TSchema>>>,
    execute: (_req: ExecuteRequest): Promise<ExecuteResult> => {
      throw new Error('execute not used');
    },
    synthesize: <TSchema extends z.ZodTypeAny>(
      _req: SynthesizeRequest<TSchema>,
    ): Promise<SynthesizeResult<z.infer<TSchema>>> => {
      throw new Error('synthesize not used');
    },
  };
}

async function runAnalyze(
  query: string,
  opts?: { structuredLlm?: StubLlmPort; logger?: ReturnType<typeof makeLogger>['logger'] },
) {
  const logger = opts?.logger ?? makeLogger().logger;
  const analyzer = new QueryAnalyzerService({
    logger,
    ...(opts?.structuredLlm !== undefined ? { structuredLlm: opts.structuredLlm } : {}),
  });
  const out = await analyzer.analyze({
    query,
    requestId: REQUEST_ID,
    perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
  });
  return { out, logger };
}

describe('regression: query-analyzer LLM-fallback observability trace', () => {
  it('emits outcome=not_attempted when deterministic pipeline yields anchors/constraints', async () => {
    const llm = makeStubLlm(() => {
      throw new Error('LLM should not be called');
    });
    // Korean: "프랑스 와인 추천" — country=France constraint fires deterministically.
    const { out } = await runAnalyze('프랑스 와인 추천', { structuredLlm: llm });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.analysis.llmFallbackOutcome).toEqual({ kind: 'not_attempted' });
    expect(llm.analyzeMock).not.toHaveBeenCalled();
  });

  it('emits outcome=not_attempted when no structuredLlm port is wired (even for ambiguous query)', async () => {
    const { out } = await runAnalyze('asdf');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // Port absent → fallback not invoked → outcome must be not_attempted.
    expect(out.analysis.llmFallbackOutcome).toEqual({ kind: 'not_attempted' });
    // Intent stays 'unknown' (no LLM rescue, no failure-softening path).
    expect(out.analysis.intent).toBe('unknown');
  });

  it('emits outcome=success when LLM fallback returns a valid analysis', async () => {
    const llmAnalysis: WineSearchAnalysis = {
      intent: 'search',
      anchors: [],
      normalizedConstraints: [],
      contract: {
        requiresDrinkabilityCheck: false,
        requiresGroundedWineSearch: true,
        hasEntityMetadataSignal: false,
      },
      expectedMultiStep: false,
      recommendedBudget: { maxSteps: 4, perToolCap: 3 },
      hangulDominant: false,
      preservedSurface: 'asdf',
    };
    const stub = makeStubLlm(() =>
      Promise.resolve({
        data: llmAnalysis,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        durationMs: 42,
      }),
    );
    const { out } = await runAnalyze('asdf', { structuredLlm: stub });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(stub.analyzeMock).toHaveBeenCalledTimes(1);
    expect(out.analysis.llmFallbackOutcome).toEqual({ kind: 'success' });
  });

  it.each<{ readonly label: string; readonly err: Error; readonly reason: string }>([
    {
      label: 'timeout',
      err: new StructuredLlmTimeoutError(),
      reason: 'timeout',
    },
    {
      label: 'refusal',
      err: new StructuredLlmRefusalError(),
      reason: 'refusal',
    },
    {
      label: 'validation',
      err: new StructuredLlmValidationError([], { broken: true }),
      reason: 'validation',
    },
    {
      label: 'partial_output',
      err: new StructuredLlmPartialOutputError({ truncated: true }),
      reason: 'partial_output',
    },
    {
      label: 'circuit_open',
      err: new StructuredLlmCircuitOpenError('analyzer'),
      reason: 'circuit_open',
    },
    {
      label: 'unknown (plain Error)',
      err: new Error('boom'),
      reason: 'unknown',
    },
  ])(
    'emits outcome=failed_preserved_unknown with reason=$reason for $label',
    async ({ err, reason }) => {
      const stub = makeStubLlm(() => Promise.reject(err));
      const { logger } = makeLogger();
      const { out } = await runAnalyze('asdf', { structuredLlm: stub, logger });
      expect(out.kind).toBe('ok');
      if (out.kind !== 'ok') return;
      // Intent is PRESERVED as 'unknown' (no silent soften to 'search') so the
      // deterministic-router can route the ambiguous query honestly.
      expect(out.analysis.intent).toBe('unknown');
      // Outcome must record the failure + reason — this is the observability contract.
      expect(out.analysis.llmFallbackOutcome).toEqual({
        kind: 'failed_preserved_unknown',
        failureReason: reason,
      });
      // Structured log emits the canonical event name + reason for grep-ability.
      expect(logger.warn).toHaveBeenCalled();
      const [logPayload] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
      expect(logPayload.event).toBe('analyzer.llm_fallback_failed');
      expect(logPayload.failureReason).toBe(reason);
    },
  );

  it('backward-compat: schema parses analyses that omit llmFallbackOutcome', () => {
    // A pre-trace fixture written by external code (or stored in cache) must
    // still parse cleanly; the field is optional precisely to protect this
    // legacy shape until callers migrate.
    const legacy: WineSearchAnalysis = {
      intent: 'search',
      anchors: [],
      normalizedConstraints: [],
      contract: {
        requiresDrinkabilityCheck: false,
        requiresGroundedWineSearch: false,
        hasEntityMetadataSignal: false,
      },
      expectedMultiStep: false,
      recommendedBudget: { maxSteps: 4, perToolCap: 3 },
      hangulDominant: false,
      preservedSurface: 'legacy',
    };
    const parsed = WineSearchAnalysisSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.llmFallbackOutcome).toBeUndefined();
  });

  it('backward-compat: caller that ignores the new field still sees a valid analysis shape', async () => {
    const stub = makeStubLlm(() => Promise.reject(new Error('boom')));
    const { out } = await runAnalyze('asdf', { structuredLlm: stub });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    // Simulate a legacy caller that destructures only the pre-trace fields.
    const {
      intent,
      anchors,
      normalizedConstraints,
      contract,
      expectedMultiStep,
      recommendedBudget,
      hangulDominant,
      preservedSurface,
    } = out.analysis;
    // All the legacy fields are still present and well-typed. Intent is now
    // PRESERVED as 'unknown' on fallback failure (no silent soften to 'search').
    expect(intent).toBe('unknown');
    expect(anchors).toEqual([]);
    expect(normalizedConstraints).toEqual([]);
    expect(contract.requiresDrinkabilityCheck).toBe(false);
    expect(typeof expectedMultiStep).toBe('boolean');
    expect(typeof recommendedBudget.maxSteps).toBe('number');
    expect(typeof hangulDominant).toBe('boolean');
    expect(preservedSurface).toBe('asdf');
  });

  it('routing consequence: preserved-unknown fallback failure → router reject with honest analysis_unavailable reason', async () => {
    // The whole point of preserving intent='unknown' instead of softening to
    // 'search': a fully-ambiguous query whose LLM disambiguation FAILED must be
    // rejected by the deterministic-router (no anchors, no constraints, no
    // wine-domain keyword), NOT force-routed into a search that masquerades the
    // LLM outage as a confident hit.
    //
    // Move 2: because the LLM fallback was ATTEMPTED and FAILED (vs a genuinely
    // out-of-scope query), the router carries that cause forward as the honest
    // `analysis_unavailable` reason (→ "AI analysis unavailable" message),
    // rather than the query-blaming `unsupported_intent`.
    const stub = makeStubLlm(() => Promise.reject(new Error('boom')));
    const { out } = await runAnalyze('asdf', { structuredLlm: stub });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.analysis.intent).toBe('unknown');

    const router = new DeterministicRouter();
    const plan = router.route(out.analysis);
    expect(plan.kind).toBe('reject');
    if (plan.kind !== 'reject') return;
    expect(plan.reason).toBe('analysis_unavailable');
  });
});
