/**
 * OpenTelemetry GenAI semantic convention helper.
 *
 * Wraps LLM calls with W3C OTEL GenAI attributes:
 *   gen_ai.system, gen_ai.request.model, gen_ai.response.model,
 *   gen_ai.usage.input_tokens, gen_ai.usage.output_tokens,
 *   gen_ai.usage.cached_input_tokens, gen_ai.cost_usd
 *
 * Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * Cost calculation uses a static price table per model — keep in sync with
 * vendor pricing pages. Cached input tokens are billed at 10% of normal input
 * cost (Anthropic ephemeral cache; OpenAI prompt caching offers ~50% discount,
 * varies by model).
 */

import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

/** Model pricing per 1M tokens, USD. Updated 2026-Q1. */
export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  /** Cached input tokens (Anthropic ephemeral / OpenAI prompt caching). */
  readonly cachedInputPerMillion?: number;
}

/** Static pricing table — fail-open: unknown models have undefined cost. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // OpenAI GPT-5 series (2025+) — prompt caching discount is 50% of input price.
  'gpt-5': { inputPerMillion: 1.25, outputPerMillion: 10.0, cachedInputPerMillion: 0.625 },
  'gpt-5.4': { inputPerMillion: 2.5, outputPerMillion: 10.0, cachedInputPerMillion: 1.25 },
  'gpt-5.4-mini': { inputPerMillion: 0.25, outputPerMillion: 2.0, cachedInputPerMillion: 0.125 },
  'gpt-5.4-nano': { inputPerMillion: 0.05, outputPerMillion: 0.4, cachedInputPerMillion: 0.025 },
  // OpenAI GPT-4 series (legacy)
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0, cachedInputPerMillion: 1.25 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 },
  // Anthropic Claude 4 series (2025+)
  'claude-opus-4-6': { inputPerMillion: 15.0, outputPerMillion: 75.0, cachedInputPerMillion: 1.5 },
  'claude-sonnet-4-5': { inputPerMillion: 3.0, outputPerMillion: 15.0, cachedInputPerMillion: 0.3 },
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0, cachedInputPerMillion: 0.3 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4.0, cachedInputPerMillion: 0.08 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4.0, cachedInputPerMillion: 0.08 },
};

export interface GenAiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
}

/** One-time warnings so we notice missing pricing entries in production logs
 *  but don't spam per-request. Set is process-lifetime scoped. */
const UNKNOWN_MODEL_WARNED = new Set<string>();

/** Compute USD cost from token usage and model pricing. Returns undefined for unknown models. */
export function computeGenAiCost(model: string, usage: GenAiUsage): number | undefined {
  // Try exact match first, then strip version suffix (claude-haiku-4-5-20251001 → claude-haiku-4-5)
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[stripVersionSuffix(model)];
  if (pricing === undefined) {
    if (!UNKNOWN_MODEL_WARNED.has(model)) {
      UNKNOWN_MODEL_WARNED.add(model);
      // stderr instead of a logger import to keep this module dependency-free
      // (it's imported by low-level adapters that must not pull in pino).
      console.warn(`[gen-ai-tracing] No pricing for model "${model}" — cost attribution disabled.`);
    }
    return undefined;
  }

  const cachedTokens = usage.cachedInputTokens ?? 0;
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedTokens);

  const PER_MILLION = 1_000_000;
  const inputCost = (uncachedInputTokens / PER_MILLION) * pricing.inputPerMillion;
  const cachedCost = (cachedTokens / PER_MILLION) * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion);
  const outputCost = (usage.outputTokens / PER_MILLION) * pricing.outputPerMillion;

  return inputCost + cachedCost + outputCost;
}

/** Strip OpenAI/Anthropic version date suffixes: "claude-haiku-4-5-20251001" → "claude-haiku-4-5". */
function stripVersionSuffix(model: string): string {
  return model.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

export type GenAiSystem = 'openai' | 'anthropic' | 'custom';

export interface GenAiSpanAttributes {
  /** LLM provider system (gen_ai.system) */
  readonly system: GenAiSystem;
  /** Requested model (gen_ai.request.model) */
  readonly requestModel: string;
  /** Operation type: 'chat' | 'embed' (gen_ai.operation.name) */
  readonly operation: 'chat' | 'embed';
  /** Optional caller context for span name (e.g., 'agent_step', 'judge_answer') */
  readonly caller?: string;
}

export interface GenAiResponseAttributes {
  /** Actual model returned in response (gen_ai.response.model) */
  readonly responseModel?: string;
  /** Token usage from API response */
  readonly usage?: GenAiUsage;
  /** finish_reason / stop_reason */
  readonly finishReason?: string;
}

/**
 * Wrap an LLM call with OTEL GenAI semantic conventions.
 *
 * Creates a child span tagged with W3C GenAI attributes, runs the LLM call,
 * tags the span with response attributes (usage, model, finish_reason, cost),
 * and ends the span. Errors are recorded but rethrown.
 *
 * Returns the LLM call result unchanged.
 *
 * Usage:
 * ```ts
 * const result = await withGenAiSpan(
 *   { system: 'openai', requestModel: 'gpt-5.4-mini', operation: 'chat', caller: 'agent_step' },
 *   async (recordResponse) => {
 *     const r = await openaiCall();
 *     recordResponse({ responseModel: r.model, usage: { inputTokens: r.usage.prompt_tokens, ... } });
 *     return r;
 *   },
 * );
 * ```
 */
export async function withGenAiSpan<T>(
  attrs: GenAiSpanAttributes,
  fn: (recordResponse: (resp: GenAiResponseAttributes) => void) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer('wine-search-engine');
  const spanName = attrs.caller !== undefined
    ? `gen_ai.${attrs.operation}.${attrs.caller}`
    : `gen_ai.${attrs.operation}`;

  return tracer.startActiveSpan(spanName, async (span: Span) => {
    // Set request-side attributes
    span.setAttributes({
      'gen_ai.system': attrs.system,
      'gen_ai.request.model': attrs.requestModel,
      'gen_ai.operation.name': attrs.operation,
    });

    let response: GenAiResponseAttributes | undefined;
    const recordResponse = (resp: GenAiResponseAttributes): void => {
      response = resp;
    };

    try {
      const result = await fn(recordResponse);

      // Set response-side attributes after the call completes
      if (response !== undefined) {
        if (response.responseModel !== undefined) {
          span.setAttribute('gen_ai.response.model', response.responseModel);
        }
        if (response.finishReason !== undefined) {
          span.setAttribute('gen_ai.response.finish_reasons', [response.finishReason]);
        }
        if (response.usage !== undefined) {
          span.setAttribute('gen_ai.usage.input_tokens', response.usage.inputTokens);
          span.setAttribute('gen_ai.usage.output_tokens', response.usage.outputTokens);
          if (response.usage.cachedInputTokens !== undefined && response.usage.cachedInputTokens > 0) {
            span.setAttribute('gen_ai.usage.cached_input_tokens', response.usage.cachedInputTokens);
          }
          // Cost calculation (custom attribute, not in OTEL spec yet)
          const cost = computeGenAiCost(attrs.requestModel, response.usage);
          if (cost !== undefined) {
            span.setAttribute('gen_ai.cost_usd', cost);
          }
        }
      }

      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}
