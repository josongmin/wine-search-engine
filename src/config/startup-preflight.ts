/**
 * Startup pre-flight configuration validation (E3-T7: RCA-03).
 *
 * Emits structured warnings for missing or incomplete configuration at
 * application boot time so operators can diagnose degraded retrievals
 * without waiting for the first request to fail.
 *
 * Call {@link warnStartupMisconfigurations} early in main.ts / bootstrap,
 * before the HTTP server starts accepting connections.
 */

import { bootstrapLogger } from './bootstrap-logger.js';

/**
 * Minimal config surface needed for pre-flight checks.
 * Mirrors the relevant slices of {@link Config} without importing the full
 * module (avoids circular deps and keeps this module testable in isolation).
 */
export interface StartupPreflightConfig {
  readonly vespa?: { readonly url?: string | undefined } | undefined;
  readonly openai?: { readonly apiKey?: string | undefined } | undefined;
  readonly cohere?: { readonly apiKey?: string | undefined } | undefined;
}

/**
 * Emit warn-level log messages for missing critical configuration.
 *
 * The three checks correspond to the three pillars of the retrieval stack:
 *  1. Vespa — sparse + dense retrieval backbone
 *  2. Embedding source — dense retrieval cannot function without one
 *  3. Reranker — results fall back to heuristic ranking if missing
 *
 * Does NOT throw: the application can still start in a degraded mode.
 * Operators use the logs to understand which channels are unavailable.
 */
export function warnStartupMisconfigurations(config: StartupPreflightConfig): void {
  if (config.vespa?.url == null || config.vespa.url === '') {
    bootstrapLogger.warn(
      'VESPA_URL not configured — sparse/dense retrieval will fail',
    );
  }

  const hasOpenAiKey = config.openai?.apiKey != null && config.openai.apiKey !== '';
  if (!hasOpenAiKey) {
    bootstrapLogger.warn(
      'No embedding source configured — dense retrieval degraded (set OPENAI_API_KEY)',
    );
  }

  const hasCohereKey = config.cohere?.apiKey != null && config.cohere.apiKey !== '';
  if (!hasCohereKey) {
    bootstrapLogger.warn(
      'No reranker configured — results will use heuristic ranking only' +
      ' (set COHERE_API_KEY)',
    );
  }
}
