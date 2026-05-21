import { createRequire } from 'node:module';
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  propagation,
  trace,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import { NodeSDK, core as otelCore, tracing } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const SERVICE_NAME = 'wine-search-engine';
const require = createRequire(import.meta.url);
const SERVICE_VERSION = (
  require('../../../package.json') as { readonly version: string }
).version;

/**
 * W3C Trace Context version byte.
 *
 * The W3C spec (https://www.w3.org/TR/trace-context/) currently defines only
 * version `00`. Future versions are reserved; receivers MUST reject any
 * unrecognised version per the spec's forward-compatibility rules.
 *
 * Pinned as a named constant (test discipline rule 15 / SSoT rule 30) so any
 * upgrade can be located by grep, not buried in regex literals.
 */
export const W3C_TRACE_CONTEXT_VERSION = '00';

/**
 * W3C Trace Context HTTP header name. Lowercased per the spec — receivers MUST
 * normalise inbound header names case-insensitively, but outbound emission is
 * always lowercase.
 */
export const W3C_TRACE_CONTEXT_HEADER = 'traceparent';

/** W3C Trace Context companion header for opaque vendor state. */
export const W3C_TRACE_STATE_HEADER = 'tracestate';

/**
 * Default head-sampling rate for OpenTelemetry traces.
 *
 * 1.0 = sample every trace. Used in dev and pre-production where trace volume
 * is low and full visibility outweighs cost. Production deployments should
 * override via env (e.g. OTEL_TRACES_SAMPLER_ARG) and wrap with a parent-based
 * sampler so child spans honor the upstream decision.
 *
 * Kept as a named constant (not a magic number) so audits can grep for
 * sampling policy in one place — see test discipline rule 15 in CLAUDE.md.
 */
export const SAMPLING_RATE_DEFAULT = 1.0;

/**
 * Returns a named tracer for the wine-search-engine service.
 *
 * Must be called after {@link initTelemetry} to get a functional tracer;
 * before init, calls return a no-op tracer.
 */
export function getTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME);
}

/**
 * Bootstraps the OpenTelemetry NodeSDK with service resource attributes
 * and starts the SDK so traces are collected.
 *
 * Should be called once at application startup, before any requests are served.
 */
export function initTelemetry(): NodeSDK {
  // Parent-based ratio sampler: root spans use SAMPLING_RATE_DEFAULT; child
  // spans inherit the parent's sampling decision so a single trace is never
  // partially sampled. This is the standard OTel deployment pattern.
  const sampler = new tracing.ParentBasedSampler({
    root: new tracing.TraceIdRatioBasedSampler(SAMPLING_RATE_DEFAULT),
  });

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    }),
    sampler,
    // Register the W3C Trace Context propagator so inbound HTTP requests carrying
    // a `traceparent` header join the upstream trace, and outbound calls inject
    // the active SpanContext into a `traceparent` header. This is the
    // industry-standard cross-service propagator (W3C TC RFC).
    textMapPropagator: new otelCore.W3CTraceContextPropagator(),
  });

  sdk.start();

  return sdk;
}

/**
 * Registers the W3C Trace Context propagator on the global OTel propagation API.
 *
 * Useful for tests and for code paths that bootstrap a `NodeTracerProvider`
 * directly (without `NodeSDK`), where the SDK-level `textMapPropagator` config
 * does not apply. Idempotent: repeated calls overwrite the global propagator.
 */
export function installW3CTraceContextPropagator(): void {
  propagation.setGlobalPropagator(new otelCore.W3CTraceContextPropagator());
}

/**
 * Emits the W3C Trace Context `traceparent` header value for the currently
 * active span, or `undefined` when no span is active.
 *
 * The returned string matches the W3C TC format:
 *   `{version:2-hex}-{traceId:32-hex}-{spanId:16-hex}-{flags:2-hex}`
 *
 * Implementation note: we delegate to `propagation.inject()` using a transient
 * carrier so the value is produced by the registered propagator (W3C TC by
 * default) — never by ad-hoc string concatenation. This keeps the emission path
 * fully spec-compliant and future-proof against `tracestate` extensions.
 */
export function getTraceparentForCurrentSpan(): string | undefined {
  const active = trace.getActiveSpan();
  if (active === undefined) return undefined;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, defaultTextMapSetter);
  const value = carrier[W3C_TRACE_CONTEXT_HEADER];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Emits the W3C Trace Context `tracestate` header value for the currently
 * active span, or `undefined` when no span is active or the active SpanContext
 * carries no tracestate entries.
 *
 * Mirrors {@link getTraceparentForCurrentSpan}: delegates to
 * `propagation.inject()` against a transient carrier so the value is produced
 * by the registered propagator (W3C TC by default). The propagator only emits
 * the `tracestate` header when the active SpanContext has a non-empty
 * `traceState` — absence is signalled by returning `undefined`.
 *
 * Per W3C TC §3.3, tracestate is `key=value` list-members separated by `,`.
 * Receivers MUST tolerate missing tracestate; emission is best-effort.
 */
export function getTracestateForCurrentSpan(): string | undefined {
  const active = trace.getActiveSpan();
  if (active === undefined) return undefined;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, defaultTextMapSetter);
  const value = carrier[W3C_TRACE_STATE_HEADER];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extracts a W3C Trace Context `SpanContext` from inbound carrier headers,
 * returning `undefined` when no valid `traceparent` is present.
 *
 * Per W3C TC, malformed headers (wrong version, wrong hex length, non-hex
 * characters, all-zero traceId/spanId) are rejected — the propagator returns a
 * context without a SpanContext, and we surface that as `undefined`.
 *
 * The returned `SpanContext` carries `traceId`, `spanId`, `traceFlags`, and any
 * `tracestate` vendor fields supplied via the `tracestate` header.
 */
export function extractTraceparent(
  carrier: Readonly<Record<string, string | undefined>>,
): SpanContext | undefined {
  const extractedCtx = propagation.extract(context.active(), carrier, defaultTextMapGetter);
  const sc = trace.getSpanContext(extractedCtx);
  if (sc === undefined) return undefined;
  // Defensive: the propagator should never return an invalid SpanContext, but a
  // hand-rolled propagator could. Guard with the same checks the spec mandates.
  if (!/^[0-9a-f]{32}$/.test(sc.traceId) || /^0+$/.test(sc.traceId)) return undefined;
  if (!/^[0-9a-f]{16}$/.test(sc.spanId) || /^0+$/.test(sc.spanId)) return undefined;
  return sc;
}
