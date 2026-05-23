/**
 * Shared StructuredLlmPort construction for the composition root.
 *
 * Until this module existed, the structured LLM was built INSIDE
 * `buildWineSearchContainerServices` — making it unavailable to other
 * use cases (e.g. the multi-query / HyDE generators wired into
 * `SearchUseCase`). Lifting it here lets both consumers share the same
 * adapter instance, which:
 *
 *  - keeps a single circuit breaker registration per provider, and
 *  - lets ops point both surfaces at the same `WINE_SEARCH_OPENAI_MODEL`
 *    via a single env var.
 *
 * Returns `null` when no usable credential is configured for the
 * selected provider — callers must degrade gracefully (skip features
 * that need an LLM rather than crash startup).
 */

import { ClaudeStructuredLlmAdapter } from '../infrastructure/ai/claude-structured-llm-adapter.js';
import { OpenAIStructuredLlmAdapter } from '../infrastructure/ai/openai-structured-llm-adapter.js';
import type { StructuredLlmPort } from '../domain/ai/port/structured-llm.port.js';
import type { Config } from './env.js';

/**
 * Default OpenAI model used when no `WINE_SEARCH_OPENAI_MODEL` /
 * `WINE_SEARCH_REWRITE_MODEL` override is set. Matches the wine-search
 * orchestrator default — the multi-query/HyDE generators reuse the same
 * cheap-and-fast model.
 */
export const DEFAULT_WINE_SEARCH_OPENAI_MODEL = 'gpt-5-mini';

export interface SharedStructuredLlmServices {
  readonly structuredLlm: StructuredLlmPort;
  /** True when the OpenAI adapter is in use (selected via
   *  `WINE_SEARCH_LLM_PROVIDER=openai`). Callers can use this to derive
   *  default model strings — Anthropic models have different naming. */
  readonly providerOpenAi: boolean;
}

/**
 * Build the shared `StructuredLlmPort` instance, OR return `null` when
 * no credential is available for the selected provider.
 *
 * Provider selection mirrors `container.ts`:
 *  - `WINE_SEARCH_LLM_PROVIDER=openai` → OpenAI adapter (requires
 *    `OPENAI_API_KEY`).
 *  - default → Anthropic adapter (requires `config.anthropic.apiKey`).
 */
export function buildSharedStructuredLlm(
  config: Config,
): SharedStructuredLlmServices | null {
  const useOpenAi = process.env['WINE_SEARCH_LLM_PROVIDER'] === 'openai';

  if (useOpenAi) {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (apiKey === undefined || apiKey.length === 0) {
      return null;
    }
    const modelOverride = process.env['WINE_SEARCH_OPENAI_MODEL'];
    const structuredLlm = new OpenAIStructuredLlmAdapter({
      apiKey,
      httpTimeoutMs: config.openai.httpTimeoutMs,
      ...(modelOverride !== undefined && modelOverride.length > 0
        ? { defaultModel: modelOverride }
        : {}),
    });
    return { structuredLlm, providerOpenAi: true };
  }

  if (config.anthropic.apiKey === undefined) {
    return null;
  }
  const structuredLlm = new ClaudeStructuredLlmAdapter({
    apiKey: config.anthropic.apiKey,
    httpTimeoutMs: config.openai.httpTimeoutMs,
  });
  return { structuredLlm, providerOpenAi: false };
}

/**
 * Resolve the model string used by the multi-query / HyDE generators.
 * Order of preference:
 *  1. `WINE_SEARCH_REWRITE_MODEL` — dedicated override for the cheap
 *     rewrite path (lets ops point this lane at a smaller/cheaper model
 *     while keeping the orchestrator on a larger one).
 *  2. `WINE_SEARCH_OPENAI_MODEL` — falls through to the shared
 *     orchestrator model.
 *  3. `DEFAULT_WINE_SEARCH_OPENAI_MODEL`.
 */
export function resolveMultiQueryRewriteModel(): string {
  const override = process.env['WINE_SEARCH_REWRITE_MODEL'];
  if (override !== undefined && override.length > 0) return override;
  const orchestratorModel = process.env['WINE_SEARCH_OPENAI_MODEL'];
  if (orchestratorModel !== undefined && orchestratorModel.length > 0) {
    return orchestratorModel;
  }
  return DEFAULT_WINE_SEARCH_OPENAI_MODEL;
}
