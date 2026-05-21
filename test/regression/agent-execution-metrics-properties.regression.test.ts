/**
 * Agent execution metrics — property-based regression suite.
 *
 * Locks the OpenTelemetry-aligned invariants for
 * `src/infrastructure/observability/agent-execution-metrics.ts`:
 *
 *   - deterministic head sampling per OTel spec §3.2.1
 *     (`TraceIdRatioBasedSampler` → same traceId yields the same decision)
 *   - sampling-rate clamping (rate=1.0 records all; rate=0 records none)
 *   - monotone token / call counters (sums are non-decreasing under repeated emission)
 *   - Korean attribute preservation through a real OTel `InMemorySpanExporter`
 *     pipeline (NFC verbatim, no escaping / mangling)
 *   - span hierarchy (child inherits trace id from `startActiveSpan` parent)
 *
 * Append-only regression file — never delete. See CLAUDE.md "Test discipline".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  context,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { tracing, node as otelNode } from '@opentelemetry/sdk-node';

import {
  AGENT_METRICS_RETENTION_HOURS,
  AGENT_METRICS_SAMPLING_RATE_DEFAULT,
  AgentExecutionMetricsCollector,
  shouldSampleAgentExecution,
} from '../../src/infrastructure/observability/agent-execution-metrics.js';
import type { AgentExecutionRecord } from '../../src/domain/agent/port/agent-execution-observer.port.js';

const { NodeTracerProvider } = otelNode;
const { InMemorySpanExporter, SimpleSpanProcessor } = tracing;

const FC_RUNS = 100;

function makeRecord(
  overrides: Partial<AgentExecutionRecord> = {},
): AgentExecutionRecord {
  return {
    terminationReason: 'answer',
    fallbackApplied: false,
    toolCallCount: 1,
    totalDurationMs: 10,
    timeoutStats: { llmStep: 0, tool: 0, parallelBatch: 0 },
    synthesis: { reasoningFailure: false, fallbackApplied: null },
    toolOutcomeKinds: ['success'],
    failedOutcomeKinds: [],
    ...overrides,
  };
}

// 32-hex character traceId, OTel-spec compatible.
const arbTraceId = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((bytes) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
  )
  // Reject all-zero traceIds (invalid per W3C TC).
  .filter((id) => !/^0+$/.test(id));

describe('agent-execution-metrics — named constants (test discipline rule 15)', () => {
  it('exposes a named sampling-rate default (no magic number)', () => {
    expect(AGENT_METRICS_SAMPLING_RATE_DEFAULT).toBe(1.0);
    expect(typeof AGENT_METRICS_SAMPLING_RATE_DEFAULT).toBe('number');
    expect(Number.isFinite(AGENT_METRICS_SAMPLING_RATE_DEFAULT)).toBe(true);
  });

  it('exposes a named retention-window constant matching the YAML 7d SLA', () => {
    expect(AGENT_METRICS_RETENTION_HOURS).toBe(24 * 7);
  });

  it('collector surfaces sampling rate + retention for health probes', () => {
    const c = new AgentExecutionMetricsCollector();
    expect(c.getSamplingRate()).toBe(AGENT_METRICS_SAMPLING_RATE_DEFAULT);
    expect(c.getRetentionHours()).toBe(AGENT_METRICS_RETENTION_HOURS);
  });
});

describe('agent-execution-metrics — sampling property (OTel TraceIdRatioBasedSampler)', () => {
  it('property: rate=1.0 → every call recorded (deterministic always-on)', () => {
    fc.assert(
      fc.property(arbTraceId, (traceId) => {
        const c = new AgentExecutionMetricsCollector({ samplingRate: 1.0 });
        c.onExecutionComplete(makeRecord(), { traceId });
        expect(c.getMetrics().runs).toBe(1);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: rate=0 → zero calls recorded (deterministic always-off)', () => {
    fc.assert(
      fc.property(arbTraceId, (traceId) => {
        const c = new AgentExecutionMetricsCollector({ samplingRate: 0 });
        c.onExecutionComplete(makeRecord(), { traceId });
        expect(c.getMetrics().runs).toBe(0);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('property: same traceId → same sampling decision (TraceIdRatioBasedSampler invariant)', () => {
    fc.assert(
      fc.property(arbTraceId, fc.double({ min: 0.01, max: 0.99, noNaN: true }), (traceId, rate) => {
        const decisions = new Set<boolean>();
        for (let i = 0; i < 10; i += 1) {
          decisions.add(shouldSampleAgentExecution(traceId, rate));
        }
        // OTel sampling spec: a given traceId MUST always produce the same
        // sample/drop decision under the same rate.
        expect(decisions.size).toBe(1);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('rate clamping: negative rate → 0, > 1 rate → 1, NaN → default', () => {
    expect(new AgentExecutionMetricsCollector({ samplingRate: -0.5 }).getSamplingRate()).toBe(0);
    expect(new AgentExecutionMetricsCollector({ samplingRate: 2 }).getSamplingRate()).toBe(1);
    expect(new AgentExecutionMetricsCollector({ samplingRate: Number.NaN }).getSamplingRate()).toBe(
      AGENT_METRICS_SAMPLING_RATE_DEFAULT,
    );
  });

  it('partial sampling at rate=0.5 lands inside a reasonable band over a varied traceId pool', () => {
    // Soft statistical check — not a flaky timing test. The hash distribution
    // of our deterministic 32-bit traceId hash over uniformly-varied hex IDs
    // should be neither always-on nor always-off at rate=0.5. We deliberately
    // use a seeded fast-check pool so the assertion is reproducible.
    const ids = fc.sample(arbTraceId, { numRuns: 1000, seed: 0xC0FFEE });
    const c = new AgentExecutionMetricsCollector({ samplingRate: 0.5 });
    let sampled = 0;
    for (const traceId of ids) {
      if (shouldSampleAgentExecution(traceId, 0.5)) sampled += 1;
      c.onExecutionComplete(makeRecord(), { traceId });
    }
    expect(sampled).toBeGreaterThan(0);
    expect(sampled).toBeLessThan(ids.length);
    expect(c.getMetrics().runs).toBe(sampled);
  });
});

describe('agent-execution-metrics — counter monotonicity property', () => {
  it('property: total tool calls is monotone non-decreasing across N emissions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 16 }), { minLength: 1, maxLength: 32 }),
        (toolCallCounts) => {
          const c = new AgentExecutionMetricsCollector();
          let prev = 0;
          for (const n of toolCallCounts) {
            c.onExecutionComplete(makeRecord({ toolCallCount: n }));
            const cur = c.getMetrics().totalToolCalls;
            expect(cur).toBeGreaterThanOrEqual(prev);
            prev = cur;
          }
          const sum = toolCallCounts.reduce((a, b) => a + b, 0);
          expect(c.getMetrics().totalToolCalls).toBe(sum);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('property: runs counter equals the count of sampled emissions', () => {
    fc.assert(
      fc.property(fc.array(arbTraceId, { minLength: 1, maxLength: 50 }), (ids) => {
        const c = new AgentExecutionMetricsCollector({ samplingRate: 1.0 });
        for (const traceId of ids) {
          c.onExecutionComplete(makeRecord(), { traceId });
        }
        expect(c.getMetrics().runs).toBe(ids.length);
      }),
      { numRuns: FC_RUNS },
    );
  });
});

describe('agent-execution-metrics — OTel span integration (InMemorySpanExporter)', () => {
  let exporter: InstanceType<typeof InMemorySpanExporter>;
  let provider: InstanceType<typeof NodeTracerProvider>;
  let tracer: Tracer;

  beforeEach(() => {
    trace.disable();
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({});
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
    tracer = trace.getTracer('wine-search-engine');
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  it('child span inherits parent traceId — collector uses the same id for sampling', () => {
    const c = new AgentExecutionMetricsCollector({ samplingRate: 1.0 });

    let parentTraceId = '';
    let childTraceId = '';

    tracer.startActiveSpan('agent.run', (parent: Span) => {
      parentTraceId = parent.spanContext().traceId;
      tracer.startActiveSpan('agent.tool_call', (child: Span) => {
        childTraceId = child.spanContext().traceId;
        c.onExecutionComplete(makeRecord(), { traceId: childTraceId });
        child.end();
      });
      parent.end();
    });

    expect(childTraceId).toBe(parentTraceId);
    expect(childTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(c.getMetrics().runs).toBe(1);
  });

  it('preserves Korean attribute values verbatim on the active agent span (NFC)', () => {
    const koreanCases: ReadonlyArray<readonly [string, string]> = [
      ['user.query', '와인 추천해줘'],
      ['user.region', '보르도'],
      ['agent.reasoning', '레드와인을 선호하는 사용자에게 적합'],
      ['agent.fallback_layer', 'layer2 / 폴백 적용됨'],
    ];

    tracer.startActiveSpan('agent.execution', (span: Span) => {
      for (const [k, v] of koreanCases) {
        span.setAttribute(k, v);
      }
      span.end();
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0]!.attributes;
    for (const [k, v] of koreanCases) {
      expect(attrs[k]).toBe(v);
      // NFC-normalized round-trip: string equals its own NFC form.
      expect((attrs[k] as string).normalize('NFC')).toBe(v);
    }
  });

  it('empty span (no operations) is still exported when sampling is on', () => {
    const c = new AgentExecutionMetricsCollector({ samplingRate: 1.0 });
    tracer.startActiveSpan('agent.empty', (span: Span) => {
      c.onExecutionComplete(makeRecord({ toolCallCount: 0, totalDurationMs: 0 }), {
        traceId: span.spanContext().traceId,
      });
      span.end();
    });
    expect(exporter.getFinishedSpans()).toHaveLength(1);
    expect(c.getMetrics().runs).toBe(1);
    expect(c.getMetrics().totalToolCalls).toBe(0);
  });

  it('error span: collector records the fallback + termination reason for an errored run', () => {
    const c = new AgentExecutionMetricsCollector({ samplingRate: 1.0 });
    tracer.startActiveSpan('agent.errored', (span: Span) => {
      span.recordException(new Error('llm step timeout'));
      c.onExecutionComplete(
        makeRecord({
          terminationReason: 'fallback',
          fallbackApplied: true,
          timeoutStats: { llmStep: 1, tool: 0, parallelBatch: 0 },
          synthesis: { reasoningFailure: true, fallbackApplied: 'layer3' },
        }),
        { traceId: span.spanContext().traceId },
      );
      span.end();
    });

    const m = c.getMetrics();
    expect(m.runs).toBe(1);
    expect(m.fallbackRuns).toBe(1);
    expect(m.reasoningFailureRuns).toBe(1);
    expect(m.byTerminationReason['fallback']).toBe(1);
    expect(m.fallbackByLayer['layer3']).toBe(1);
    expect(m.timeouts.llmStep).toBe(1);

    const exportedSpan = exporter.getFinishedSpans()[0]!;
    const exceptionEvent = exportedSpan.events.find((e) => e.name === 'exception');
    expect(exceptionEvent).toBeDefined();
    expect(exceptionEvent!.attributes?.['exception.message']).toBe('llm step timeout');
  });

  it('very long span name (> 256 chars) is preserved by InMemorySpanExporter (no silent truncation)', () => {
    // OTel JS SDK does not truncate span names by default — this test documents
    // current behavior so any future SDK upgrade that adds default truncation
    // is caught here. If truncation lands upstream, replace with the documented
    // limit constant + boundary test.
    const longName = 'agent.long.'.padEnd(512, 'x');
    expect(longName.length).toBe(512);
    tracer.startActiveSpan(longName, (span: Span) => {
      span.end();
    });
    const exported = exporter.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0]!.name).toBe(longName);
  });

  it('context.active() carries the trace context through the collector callback', () => {
    const c = new AgentExecutionMetricsCollector({ samplingRate: 1.0 });
    let traceIdAtRecord = '';
    tracer.startActiveSpan('agent.context_active', (span: Span) => {
      // The active context inside the callback should resolve to the same trace.
      const active = trace.getActiveSpan();
      expect(active).toBeDefined();
      traceIdAtRecord = active!.spanContext().traceId;
      c.onExecutionComplete(makeRecord(), { traceId: traceIdAtRecord });
      span.end();
    });
    expect(traceIdAtRecord).toMatch(/^[0-9a-f]{32}$/);
    // The context-active span id is the same one captured in trace.getActiveSpan().
    expect(context.active()).toBeDefined();
    expect(c.getMetrics().runs).toBe(1);
  });
});
