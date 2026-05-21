/**
 * OpenTelemetry tracing regression — locks span lifecycle, gen-ai semantic
 * conventions, context propagation, error recording, sampling policy, and
 * status code mapping for `src/infrastructure/telemetry/`.
 *
 * Uses OTel `InMemorySpanExporter` (re-exported via `@opentelemetry/sdk-node`)
 * so the suite is fully offline — no collector, no LLM, no network.
 *
 * Append-only test: never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SpanStatusCode,
  context,
  trace,
  type Tracer,
  type Span,
} from '@opentelemetry/api';
import { tracing, node as otelNode } from '@opentelemetry/sdk-node';

import { withGenAiSpan } from '../../src/infrastructure/telemetry/gen-ai-tracing.js';
import { SAMPLING_RATE_DEFAULT } from '../../src/infrastructure/telemetry/tracer.js';

const { NodeTracerProvider } = otelNode;
const {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  AlwaysOnSampler,
  AlwaysOffSampler,
  TraceIdRatioBasedSampler,
} = tracing;

/**
 * Capture spans from the global tracer used by gen-ai-tracing ('wine-search-engine').
 * Uses `NodeTracerProvider` (not `BasicTracerProvider`) so the async-hooks context
 * manager is registered automatically — required for `startActiveSpan` to propagate
 * context across `await` and produce parent/child span hierarchies.
 */
function installInMemoryExporter(sampler?: ConstructorParameters<typeof NodeTracerProvider>[0]['sampler']): {
  readonly exporter: InstanceType<typeof InMemorySpanExporter>;
  readonly provider: NodeTracerProvider;
  readonly tracer: Tracer;
  readonly dispose: () => Promise<void>;
} {
  // Disable any previously-registered provider so `trace.getTracer(...)` resolves
  // to the new one (the API caches ProxyTracer instances per name).
  trace.disable();
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider(
    sampler !== undefined ? { sampler } : {},
  );
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  const tracer = trace.getTracer('wine-search-engine');
  return {
    exporter,
    provider,
    tracer,
    dispose: async () => {
      await provider.shutdown();
      trace.disable();
    },
  };
}

describe('opentelemetry-tracing regression — span lifecycle & exporter', () => {
  let harness: ReturnType<typeof installInMemoryExporter>;

  beforeEach(() => {
    harness = installInMemoryExporter();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('exports a span with attributes after start → setAttributes → end', () => {
    const span = harness.tracer.startSpan('test.basic');
    span.setAttribute('test.key', 'value');
    span.setAttribute('test.number', 42);
    span.end();

    const exported = harness.exporter.getFinishedSpans();
    expect(exported).toHaveLength(1);
    const first = exported[0]!;
    expect(first.name).toBe('test.basic');
    expect(first.attributes['test.key']).toBe('value');
    expect(first.attributes['test.number']).toBe(42);
  });

  it('exports an empty span (no operations between start and end) with minimal attributes', () => {
    const span = harness.tracer.startSpan('test.empty');
    span.end();

    const exported = harness.exporter.getFinishedSpans();
    expect(exported).toHaveLength(1);
    const first = exported[0]!;
    expect(first.name).toBe('test.empty');
    // No user-set attributes
    expect(Object.keys(first.attributes)).toHaveLength(0);
  });
});

describe('opentelemetry-tracing regression — gen-ai semantic conventions', () => {
  let harness: ReturnType<typeof installInMemoryExporter>;

  beforeEach(() => {
    harness = installInMemoryExporter();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('tags LLM call spans with gen_ai.system, request.model, usage tokens', async () => {
    await withGenAiSpan(
      {
        system: 'openai',
        requestModel: 'gpt-5.4-mini',
        operation: 'chat',
        caller: 'agent_step',
      },
      (recordResponse) => {
        recordResponse({
          responseModel: 'gpt-5.4-mini',
          usage: { inputTokens: 100, outputTokens: 50 },
          finishReason: 'stop',
        });
        return Promise.resolve('ok');
      },
    );

    const spans = harness.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('gen_ai.chat.agent_step');
    expect(span.attributes['gen_ai.system']).toBe('openai');
    expect(span.attributes['gen_ai.request.model']).toBe('gpt-5.4-mini');
    expect(span.attributes['gen_ai.response.model']).toBe('gpt-5.4-mini');
    expect(span.attributes['gen_ai.operation.name']).toBe('chat');
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(100);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(50);
    // Cost should be computed for a known model (gpt-5.4-mini)
    expect(typeof span.attributes['gen_ai.cost_usd']).toBe('number');
  });

  it('omits gen_ai.usage.* attributes when LLM call has no token info (not zero, not undefined)', async () => {
    await withGenAiSpan(
      {
        system: 'anthropic',
        requestModel: 'claude-haiku-4-5',
        operation: 'chat',
      },
      (recordResponse) => {
        // recordResponse never called with usage — tests the "no token info" branch
        recordResponse({ responseModel: 'claude-haiku-4-5' });
        return Promise.resolve('ok');
      },
    );

    const spans = harness.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const attrs = spans[0]!.attributes;
    expect(attrs).not.toHaveProperty('gen_ai.usage.input_tokens');
    expect(attrs).not.toHaveProperty('gen_ai.usage.output_tokens');
    expect(attrs).not.toHaveProperty('gen_ai.usage.cached_input_tokens');
    expect(attrs).not.toHaveProperty('gen_ai.cost_usd');
  });
});

describe('opentelemetry-tracing regression — context propagation & hierarchy', () => {
  let harness: ReturnType<typeof installInMemoryExporter>;

  beforeEach(() => {
    harness = installInMemoryExporter();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('child spans inherit parent traceId when nested via startActiveSpan', () => {
    let childTraceId = '';
    let childSpanId = '';
    let parentTraceId = '';
    let parentSpanId = '';

    harness.tracer.startActiveSpan('parent', (parent: Span) => {
      parentTraceId = parent.spanContext().traceId;
      parentSpanId = parent.spanContext().spanId;
      harness.tracer.startActiveSpan('child', (child: Span) => {
        childTraceId = child.spanContext().traceId;
        childSpanId = child.spanContext().spanId;
        child.end();
      });
      parent.end();
    });

    expect(childTraceId).toBe(parentTraceId);
    expect(childSpanId).not.toBe(parentSpanId);

    const spans = harness.exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const child = spans.find((s) => s.name === 'child')!;
    const parent = spans.find((s) => s.name === 'parent')!;
    expect(child.parentSpanId).toBe(parent.spanContext().spanId);
  });

  it('two concurrent async spans do not cross-pollute attributes or trace IDs', async () => {
    const aDone = harness.tracer.startActiveSpan('concurrent.a', async (span: Span) => {
      span.setAttribute('lane', 'a');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const traceId = span.spanContext().traceId;
      span.end();
      return traceId;
    });
    const bDone = harness.tracer.startActiveSpan('concurrent.b', async (span: Span) => {
      span.setAttribute('lane', 'b');
      await new Promise((resolve) => setTimeout(resolve, 5));
      const traceId = span.spanContext().traceId;
      span.end();
      return traceId;
    });
    const [traceA, traceB] = await Promise.all([aDone, bDone]);

    expect(traceA).not.toBe(traceB);
    const spans = harness.exporter.getFinishedSpans();
    const a = spans.find((s) => s.name === 'concurrent.a')!;
    const b = spans.find((s) => s.name === 'concurrent.b')!;
    expect(a.attributes['lane']).toBe('a');
    expect(b.attributes['lane']).toBe('b');
  });
});

describe('opentelemetry-tracing regression — error recording & status mapping', () => {
  let harness: ReturnType<typeof installInMemoryExporter>;

  beforeEach(() => {
    harness = installInMemoryExporter();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('records exception type + message and sets ERROR status when fn throws', async () => {
    class CustomLlmError extends Error {
      override readonly name = 'CustomLlmError';
    }

    let caught: unknown;
    try {
      await withGenAiSpan(
        { system: 'openai', requestModel: 'gpt-5.4-mini', operation: 'chat' },
        () => {
          throw new CustomLlmError('rate limit exceeded');
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CustomLlmError);
    const spans = harness.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('rate limit exceeded');
    // Exception event recorded
    const exceptionEvent = span.events.find((e) => e.name === 'exception');
    expect(exceptionEvent).toBeDefined();
    expect(exceptionEvent!.attributes?.['exception.type']).toBe('CustomLlmError');
    expect(exceptionEvent!.attributes?.['exception.message']).toBe('rate limit exceeded');
  });

  it('sets OK status on successful gen-ai span', async () => {
    await withGenAiSpan(
      { system: 'openai', requestModel: 'gpt-5.4-mini', operation: 'chat' },
      () => Promise.resolve('ok'),
    );
    const spans = harness.exporter.getFinishedSpans();
    expect(spans[0]!.status.code).toBe(SpanStatusCode.OK);
  });
});

describe('opentelemetry-tracing regression — sampling policy', () => {
  afterEach(() => {
    trace.disable();
  });

  it('exposes SAMPLING_RATE_DEFAULT = 1.0 (sample everything by default)', () => {
    expect(SAMPLING_RATE_DEFAULT).toBe(1.0);
  });

  it('AlwaysOnSampler (rate=1) exports every span', async () => {
    const h = installInMemoryExporter(new AlwaysOnSampler());
    for (let i = 0; i < 20; i += 1) {
      h.tracer.startSpan(`sampled.${i}`).end();
    }
    expect(h.exporter.getFinishedSpans()).toHaveLength(20);
    await h.dispose();
  });

  it('AlwaysOffSampler (rate=0) exports zero spans', async () => {
    const h = installInMemoryExporter(new AlwaysOffSampler());
    for (let i = 0; i < 20; i += 1) {
      h.tracer.startSpan(`dropped.${i}`).end();
    }
    expect(h.exporter.getFinishedSpans()).toHaveLength(0);
    await h.dispose();
  });

  it('TraceIdRatioBasedSampler with SAMPLING_RATE_DEFAULT samples every span (rate=1.0)', async () => {
    const h = installInMemoryExporter(new TraceIdRatioBasedSampler(SAMPLING_RATE_DEFAULT));
    for (let i = 0; i < 50; i += 1) {
      h.tracer.startSpan(`ratio.${i}`).end();
    }
    expect(h.exporter.getFinishedSpans()).toHaveLength(50);
    await h.dispose();
  });
});

describe('opentelemetry-tracing regression — non-ASCII attribute preservation', () => {
  let harness: ReturnType<typeof installInMemoryExporter>;

  beforeEach(() => {
    harness = installInMemoryExporter();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('preserves Korean string attributes verbatim (no escaping/mangling)', () => {
    const span = harness.tracer.startSpan('korean.query');
    span.setAttribute('user.query', '와인 추천');
    span.setAttribute('user.region', '보르도');
    span.end();

    const exported = harness.exporter.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0]!.attributes['user.query']).toBe('와인 추천');
    expect(exported[0]!.attributes['user.region']).toBe('보르도');
  });

  it('preserves Korean attribute values through gen-ai span pipeline', async () => {
    await withGenAiSpan(
      {
        system: 'openai',
        requestModel: 'gpt-5.4-mini',
        operation: 'chat',
        caller: 'agent_step',
      },
      (recordResponse) => {
        const span = trace.getActiveSpan();
        span?.setAttribute('user.query', '레드와인 추천해줘');
        recordResponse({ usage: { inputTokens: 10, outputTokens: 5 } });
        return Promise.resolve('ok');
      },
    );

    const spans = harness.exporter.getFinishedSpans();
    expect(spans[0]!.attributes['user.query']).toBe('레드와인 추천해줘');
  });
});

describe('opentelemetry-tracing regression — context activation contract', () => {
  let harness: ReturnType<typeof installInMemoryExporter>;

  beforeEach(() => {
    harness = installInMemoryExporter();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('trace.getActiveSpan() returns the span inside startActiveSpan callback', () => {
    let activeInside: Span | undefined;
    harness.tracer.startActiveSpan('active.parent', (span: Span) => {
      activeInside = trace.getActiveSpan();
      span.end();
    });
    expect(activeInside).toBeDefined();
    expect(activeInside!.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('context.active() is defined and yields a valid context object', () => {
    const ctx = context.active();
    expect(ctx).toBeDefined();
    expect(typeof ctx.getValue).toBe('function');
  });
});
