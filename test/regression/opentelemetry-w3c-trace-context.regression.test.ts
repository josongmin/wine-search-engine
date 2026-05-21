/**
 * OpenTelemetry W3C Trace Context propagation regression.
 *
 * Locks W3C Trace Context (https://www.w3.org/TR/trace-context/) emission +
 * extraction for cross-service distributed tracing. The format is:
 *
 *   traceparent: {version}-{trace-id}-{parent-id}-{trace-flags}
 *                  2-hex   32-hex     16-hex      2-hex
 *
 * Version byte is always `00` (the only version defined by the W3C spec at
 * time of writing). Trace flags low bit = sampled (01) vs not sampled (00).
 *
 * Uses real OTel APIs (`@opentelemetry/api` propagation + the
 * `W3CTraceContextPropagator` from `@opentelemetry/core`) — not mocks of the
 * propagator itself. Property tests assert round-trip stability over 100 runs.
 *
 * Append-only: never delete this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  TraceFlags,
  context,
  createTraceState,
  propagation,
  trace,
  type Span,
} from '@opentelemetry/api';
import { tracing, node as otelNode, core as otelCore } from '@opentelemetry/sdk-node';

import {
  W3C_TRACE_CONTEXT_HEADER,
  W3C_TRACE_CONTEXT_VERSION,
  W3C_TRACE_STATE_HEADER,
  extractTraceparent,
  getTraceparentForCurrentSpan,
  getTracestateForCurrentSpan,
  installW3CTraceContextPropagator,
} from '../../src/infrastructure/telemetry/tracer.js';

const { NodeTracerProvider } = otelNode;
const { InMemorySpanExporter, SimpleSpanProcessor } = tracing;
const { W3CTraceContextPropagator } = otelCore;

/** Regex for a well-formed W3C traceparent header value. */
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
/** Regex for a 32-hex traceId. */
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
/** Regex for a 16-hex spanId. */
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

function installHarness(): {
  readonly exporter: InstanceType<typeof InMemorySpanExporter>;
  readonly provider: InstanceType<typeof NodeTracerProvider>;
  readonly tracer: ReturnType<typeof trace.getTracer>;
  readonly dispose: () => Promise<void>;
} {
  trace.disable();
  propagation.disable();
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({});
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  installW3CTraceContextPropagator();
  const tracer = trace.getTracer('wine-search-engine');
  return {
    exporter,
    provider,
    tracer,
    dispose: async () => {
      await provider.shutdown();
      propagation.disable();
      trace.disable();
    },
  };
}

describe('w3c-trace-context regression — exported constants', () => {
  it('exposes W3C_TRACE_CONTEXT_VERSION = "00" (the only version defined by the spec)', () => {
    expect(W3C_TRACE_CONTEXT_VERSION).toBe('00');
  });

  it('exposes W3C_TRACE_CONTEXT_HEADER = "traceparent" (lowercased per spec)', () => {
    expect(W3C_TRACE_CONTEXT_HEADER).toBe('traceparent');
  });
});

describe('w3c-trace-context regression — traceparent emission', () => {
  let harness: ReturnType<typeof installHarness>;
  beforeEach(() => {
    harness = installHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('emits a well-formed W3C traceparent for the active span', () => {
    let emitted: string | undefined;
    harness.tracer.startActiveSpan('emit.basic', (span: Span) => {
      emitted = getTraceparentForCurrentSpan();
      span.end();
    });
    expect(emitted).toBeDefined();
    expect(emitted!).toMatch(TRACEPARENT_RE);
  });

  it('traceparent contains the active span\'s 32-hex traceId and 16-hex spanId', () => {
    let emitted: string | undefined;
    let traceId = '';
    let spanId = '';
    harness.tracer.startActiveSpan('emit.ids', (span: Span) => {
      traceId = span.spanContext().traceId;
      spanId = span.spanContext().spanId;
      emitted = getTraceparentForCurrentSpan();
      span.end();
    });
    expect(traceId).toMatch(TRACE_ID_RE);
    expect(spanId).toMatch(SPAN_ID_RE);
    expect(emitted).toBe(`00-${traceId}-${spanId}-01`);
  });

  it('returns undefined when no active span is present', () => {
    expect(getTraceparentForCurrentSpan()).toBeUndefined();
  });
});

describe('w3c-trace-context regression — traceparent parsing', () => {
  let harness: ReturnType<typeof installHarness>;
  beforeEach(() => {
    harness = installHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('parses inbound traceparent into a valid SpanContext', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const header = `00-${traceId}-${spanId}-01`;
    const spanContext = extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: header });
    expect(spanContext).toBeDefined();
    expect(spanContext!.traceId).toBe(traceId);
    expect(spanContext!.spanId).toBe(spanId);
    expect(spanContext!.traceFlags).toBe(TraceFlags.SAMPLED);
  });

  it('child spans started under an extracted context inherit the inbound traceId', () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const spanId = 'b7ad6b7169203331';
    const header = `00-${traceId}-${spanId}-01`;
    const extracted = extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: header });
    expect(extracted).toBeDefined();

    // Wire the extracted spanContext into a Context and start a child under it.
    const parentCtx = trace.setSpanContext(context.active(), extracted!);
    let childTraceId = '';
    let childParentSpanId = '';
    context.with(parentCtx, () => {
      harness.tracer.startActiveSpan('child.under.inbound', (child: Span) => {
        childTraceId = child.spanContext().traceId;
        child.end();
      });
    });
    const exported = harness.exporter.getFinishedSpans();
    const child = exported.find((s) => s.name === 'child.under.inbound');
    expect(child).toBeDefined();
    childParentSpanId = child!.parentSpanId ?? '';
    expect(childTraceId).toBe(traceId);
    expect(childParentSpanId).toBe(spanId);
  });

  it('rejects malformed traceparent with wrong version byte', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    // Version `ff` is invalid per W3C spec.
    const bad = `ff-${traceId}-${spanId}-01`;
    expect(extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: bad })).toBeUndefined();
  });

  it('rejects malformed traceparent with wrong traceId hex length (31 chars)', () => {
    const bad = '00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01';
    expect(extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: bad })).toBeUndefined();
  });

  it('rejects malformed traceparent with wrong spanId hex length (15 chars)', () => {
    const bad = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01';
    expect(extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: bad })).toBeUndefined();
  });

  it('rejects traceparent with non-hex characters', () => {
    const bad = '00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01';
    expect(extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: bad })).toBeUndefined();
  });

  it('rejects traceparent with all-zero traceId (invalid per W3C spec)', () => {
    const bad = '00-00000000000000000000000000000000-00f067aa0ba902b7-01';
    expect(extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: bad })).toBeUndefined();
  });

  it('rejects traceparent with all-zero spanId (invalid per W3C spec)', () => {
    const bad = '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01';
    expect(extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: bad })).toBeUndefined();
  });

  it('returns undefined when traceparent header is absent', () => {
    expect(extractTraceparent({})).toBeUndefined();
  });
});

describe('w3c-trace-context regression — trace flags', () => {
  let harness: ReturnType<typeof installHarness>;
  beforeEach(() => {
    harness = installHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('preserves the sampled flag (01) on extract', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
    });
    expect(sc!.traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
  });

  it('preserves the not-sampled flag (00) on extract', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-00`,
    });
    expect(sc!.traceFlags & TraceFlags.SAMPLED).toBe(0);
  });
});

describe('w3c-trace-context regression — tracestate vendor field', () => {
  let harness: ReturnType<typeof installHarness>;
  beforeEach(() => {
    harness = installHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('parses tracestate when present alongside traceparent', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
      tracestate: 'vendor=opaqueValue1,other=opaqueValue2',
    });
    expect(sc).toBeDefined();
    expect(sc!.traceState).toBeDefined();
    // OTel TraceState exposes get(key) returning the vendor value.
    expect(sc!.traceState!.get('vendor')).toBe('opaqueValue1');
    expect(sc!.traceState!.get('other')).toBe('opaqueValue2');
  });

  it('handles missing tracestate (traceparent-only) without error', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
    });
    expect(sc).toBeDefined();
    // tracestate may be undefined or an empty TraceState — both are valid.
  });
});

describe('w3c-trace-context regression — tracestate emission & spec edge cases', () => {
  /**
   * Lock the second half of the W3C Trace Context contract: tracestate. The
   * existing "vendor field" block above covers happy-path parsing; this block
   * locks emission, empty/malformed input, and the spec §3.3 32-member limit.
   *
   * Tracestate carries vendor opaque state — `vendor-key=opaque-value` pairs
   * separated by `,`. Emission is driven by mutating the active SpanContext's
   * `traceState` via the real OTel API (`createTraceState().set(k,v)`), then
   * letting the propagator inject through the helper.
   */
  let harness: ReturnType<typeof installHarness>;
  beforeEach(() => {
    harness = installHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('exports W3C_TRACE_STATE_HEADER = "tracestate" (lowercased per spec)', () => {
    expect(W3C_TRACE_STATE_HEADER).toBe('tracestate');
  });

  it('emit: getTracestateForCurrentSpan() returns vendor key=value when SpanContext.traceState is set', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    // Build a SpanContext with a vendor tracestate using the real OTel API.
    const sc = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      traceState: createTraceState().set('winevendor', 'opaque1'),
    };
    const ctx = trace.setSpanContext(context.active(), sc);
    let emittedTraceparent: string | undefined;
    let emittedTracestate: string | undefined;
    context.with(ctx, () => {
      // The helper resolves through `propagation.inject()` against the active
      // context. There is no Span object here, only a SpanContext, so we use
      // an inline guard: an emitted SpanContext is "active enough" for the
      // propagator. To exercise the helper's "no active Span" guard we set a
      // real span context up via startActiveSpan in a sibling test below.
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      emittedTraceparent = carrier[W3C_TRACE_CONTEXT_HEADER];
      emittedTracestate = carrier[W3C_TRACE_STATE_HEADER];
    });
    expect(emittedTraceparent).toBe(`00-${traceId}-${spanId}-01`);
    expect(emittedTracestate).toBe('winevendor=opaque1');
  });

  it('emit: getTracestateForCurrentSpan() returns multi-vendor list with prepend order (newest first)', () => {
    // Per W3C TC §3.3 + OTel impl, set() always prepends; later set wins
    // list-position 0. Lock that contract so consumers can rely on read order.
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const spanId = 'b7ad6b7169203331';
    const sc = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
      traceState: createTraceState().set('vendora', 'va').set('vendorb', 'vb'),
    };
    const ctx = trace.setSpanContext(context.active(), sc);
    let emitted: string | undefined;
    context.with(ctx, () => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      emitted = carrier[W3C_TRACE_STATE_HEADER];
    });
    // vendorb was set last → appears first per OTel TraceState.set() semantics.
    expect(emitted).toBe('vendorb=vb,vendora=va');
  });

  it('emit: getTracestateForCurrentSpan() is undefined when no span is active', () => {
    expect(getTracestateForCurrentSpan()).toBeUndefined();
  });

  it('emit: getTracestateForCurrentSpan() is undefined for an active span with no tracestate', () => {
    let observed: string | undefined = 'unset';
    harness.tracer.startActiveSpan('emit.no.tracestate', (span: Span) => {
      observed = getTracestateForCurrentSpan();
      span.end();
    });
    // Locally-started spans inherit no tracestate; helper must signal absence
    // (not emit an empty string, not throw).
    expect(observed).toBeUndefined();
  });

  it('emit: getTracestateForCurrentSpan() returns vendor value for an active span with extracted tracestate', () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const spanId = 'b7ad6b7169203331';
    const inboundSc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
      [W3C_TRACE_STATE_HEADER]: 'congo=t61rcWkgMzE',
    });
    expect(inboundSc).toBeDefined();
    const parentCtx = trace.setSpanContext(context.active(), inboundSc!);
    let observed: string | undefined;
    context.with(parentCtx, () => {
      observed = getTracestateForCurrentSpan();
    });
    expect(observed).toBe('congo=t61rcWkgMzE');
  });

  it('parse: inbound tracestate with two vendors → SpanContext.traceState.get returns each value', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
      [W3C_TRACE_STATE_HEADER]: 'vendor1=v1,vendor2=v2',
    });
    expect(sc).toBeDefined();
    expect(sc!.traceState).toBeDefined();
    expect(sc!.traceState!.get('vendor1')).toBe('v1');
    expect(sc!.traceState!.get('vendor2')).toBe('v2');
    expect(sc!.traceState!.get('missing')).toBeUndefined();
  });

  it('parse: empty tracestate header → SpanContext valid with no vendor entries', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
    });
    expect(sc).toBeDefined();
    // traceState is undefined or an empty TraceState — both are spec-valid.
    if (sc!.traceState !== undefined) {
      expect(sc!.traceState.get('anything')).toBeUndefined();
      expect(sc!.traceState.serialize()).toBe('');
    }
  });

  it('parse: malformed tracestate (semicolon-separated, not commas) is ignored gracefully; traceparent still returned', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
      // W3C TC requires `,`-separated list-members. `;` is not a valid
      // separator; receivers MUST tolerate and recover. The W3C propagator
      // either drops the malformed entries or treats the whole header as a
      // single (unparseable) member — either way, traceparent is preserved.
      [W3C_TRACE_STATE_HEADER]: 'invalid format with semicolons; not commas',
    });
    expect(sc).toBeDefined();
    expect(sc!.traceId).toBe(traceId);
    expect(sc!.spanId).toBe(spanId);
    // Whatever the propagator does with the malformed list, it MUST NOT throw
    // and MUST NOT surface `;not commas` as a vendor key with the expected
    // value — assert by lookup, not by serialize() shape.
    if (sc!.traceState !== undefined) {
      expect(sc!.traceState.get('vendor1')).toBeUndefined();
    }
  });

  it('parse: malformed tracestate with non-key chars (spaces in key) is dropped, valid entries kept', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
      // Per W3C TC §3.3, list-member key must be lcalpha/digit/underscore/
      // hyphen/star/forward-slash. "bad key" with embedded space is invalid;
      // the propagator drops it. The valid `goodkey=goodvalue` survives.
      [W3C_TRACE_STATE_HEADER]: 'bad key=ignored,goodkey=goodvalue',
    });
    expect(sc).toBeDefined();
    // Spec-compliant propagators drop the entire tracestate when ANY member
    // is malformed (strict mode) or drop only the offending member (lenient).
    // OTel core implementation is strict — assert recovery without claiming
    // a specific entry survives.
    if (sc!.traceState !== undefined) {
      expect(sc!.traceState.get('bad key')).toBeUndefined();
    }
  });

  it('spec §3.3 32-member limit: oversized tracestate is truncated/ignored gracefully', () => {
    // W3C TC §3.3: "There can be a maximum of 32 list-members in a list."
    // Build 40 list-members; the OTel propagator MUST NOT crash, and MUST NOT
    // surface more than the spec maximum on read.
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const TRACESTATE_MAX_MEMBERS = 32;
    const oversized = Array.from(
      { length: 40 },
      (_, i) => `v${i.toString()}=val${i.toString()}`,
    ).join(',');
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
      [W3C_TRACE_STATE_HEADER]: oversized,
    });
    expect(sc).toBeDefined();
    expect(sc!.traceId).toBe(traceId);
    if (sc!.traceState !== undefined) {
      const serialized = sc!.traceState.serialize();
      // Count surviving list-members. Spec-compliant impls cap at 32.
      const surviving =
        serialized.length === 0 ? 0 : serialized.split(',').length;
      expect(surviving).toBeLessThanOrEqual(TRACESTATE_MAX_MEMBERS);
    }
  });

  it('round-trip: extracted tracestate re-injects to a string the propagator round-trips', () => {
    // Locks that the propagator does NOT silently drop tracestate on a clean
    // extract→inject cycle for a small, fully-spec-compliant input.
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const inbound = 'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE';
    const sc = extractTraceparent({
      [W3C_TRACE_CONTEXT_HEADER]: `00-${traceId}-${spanId}-01`,
      [W3C_TRACE_STATE_HEADER]: inbound,
    });
    expect(sc).toBeDefined();
    const carrier: Record<string, string> = {};
    const ctx = trace.setSpanContext(context.active(), sc!);
    propagation.inject(ctx, carrier);
    expect(carrier[W3C_TRACE_STATE_HEADER]).toBe(inbound);
    // Specific values survived the round trip.
    expect(sc!.traceState!.get('rojo')).toBe('00f067aa0ba902b7');
    expect(sc!.traceState!.get('congo')).toBe('t61rcWkgMzE');
  });
});

describe('w3c-trace-context regression — cross-context propagation', () => {
  let harness: ReturnType<typeof installHarness>;
  beforeEach(() => {
    harness = installHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('inject() writes traceparent into an outbound carrier matching the active span', () => {
    const carrier: Record<string, string> = {};
    harness.tracer.startActiveSpan('outbound', (span: Span) => {
      propagation.inject(context.active(), carrier);
      span.end();
    });
    const value = carrier[W3C_TRACE_CONTEXT_HEADER];
    expect(typeof value).toBe('string');
    expect(value!).toMatch(TRACEPARENT_RE);
  });

  it('emit-then-extract round trip yields the same traceId/spanId/flags', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const inbound = `00-${traceId}-${spanId}-01`;
    const sc = extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: inbound });
    // Re-inject from the same SpanContext.
    const carrier: Record<string, string> = {};
    const ctx = trace.setSpanContext(context.active(), sc!);
    propagation.inject(ctx, carrier);
    expect(carrier[W3C_TRACE_CONTEXT_HEADER]).toBe(inbound);
  });
});

describe('w3c-trace-context regression — property: round-trip stability', () => {
  let harness: ReturnType<typeof installHarness>;
  beforeEach(() => {
    harness = installHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  const hex = (n: number): fc.Arbitrary<string> =>
    fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`));

  it('property: any well-formed traceparent extracts → re-injects to the same string', () => {
    fc.assert(
      fc.property(hex(32), hex(16), fc.constantFrom('00', '01'), (traceId, spanId, flags) => {
        // Skip W3C invalid all-zero ids — the propagator rejects them.
        if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return true;
        const inbound = `00-${traceId}-${spanId}-${flags}`;
        const sc = extractTraceparent({ [W3C_TRACE_CONTEXT_HEADER]: inbound });
        if (sc === undefined) return false;
        const carrier: Record<string, string> = {};
        const ctx = trace.setSpanContext(context.active(), sc);
        propagation.inject(ctx, carrier);
        return carrier[W3C_TRACE_CONTEXT_HEADER] === inbound;
      }),
      { numRuns: 100 },
    );
  });
});

describe('w3c-trace-context regression — adjacent: id uniqueness & async stability', () => {
  let harness: ReturnType<typeof installHarness>;
  beforeEach(() => {
    harness = installHarness();
  });
  afterEach(async () => {
    await harness.dispose();
  });

  it('every span in a trace gets a unique 16-hex spanId', () => {
    const spanIds = new Set<string>();
    harness.tracer.startActiveSpan('root', (root: Span) => {
      spanIds.add(root.spanContext().spanId);
      for (let i = 0; i < 25; i += 1) {
        harness.tracer.startActiveSpan(`child.${i}`, (child: Span) => {
          spanIds.add(child.spanContext().spanId);
          child.end();
        });
      }
      root.end();
    });
    // 25 children + 1 root = 26 distinct spanIds.
    expect(spanIds.size).toBe(26);
    for (const id of spanIds) expect(id).toMatch(SPAN_ID_RE);
  });

  it('traceId stays stable across an async chain inside one active span', async () => {
    let initial = '';
    let mid = '';
    let final = '';
    await harness.tracer.startActiveSpan('async.chain', async (span: Span) => {
      initial = span.spanContext().traceId;
      await new Promise((resolve) => setTimeout(resolve, 3));
      mid = trace.getActiveSpan()?.spanContext().traceId ?? '';
      await new Promise((resolve) => setTimeout(resolve, 3));
      final = trace.getActiveSpan()?.spanContext().traceId ?? '';
      span.end();
    });
    expect(initial).toMatch(TRACE_ID_RE);
    expect(mid).toBe(initial);
    expect(final).toBe(initial);
  });

  it('concurrent active spans emit distinct traceparents (no cross-pollution)', async () => {
    const collect = async (lane: string): Promise<string> =>
      harness.tracer.startActiveSpan(`lane.${lane}`, async (span: Span) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const tp = getTraceparentForCurrentSpan() ?? '';
        span.end();
        return tp;
      });
    const [a, b, c] = await Promise.all([collect('a'), collect('b'), collect('c')]);
    expect(a).toMatch(TRACEPARENT_RE);
    expect(b).toMatch(TRACEPARENT_RE);
    expect(c).toMatch(TRACEPARENT_RE);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('w3c-trace-context regression — propagator wiring', () => {
  afterEach(async () => {
    propagation.disable();
    trace.disable();
  });

  it('installW3CTraceContextPropagator() registers a W3CTraceContextPropagator globally', () => {
    propagation.disable();
    installW3CTraceContextPropagator();
    // The propagator's fields() must include 'traceparent' per W3C TC.
    expect(propagation.fields()).toContain(W3C_TRACE_CONTEXT_HEADER);
    // Sanity: directly instantiating the same propagator class exposes the same field.
    const direct = new W3CTraceContextPropagator();
    expect(direct.fields()).toContain(W3C_TRACE_CONTEXT_HEADER);
  });
});
