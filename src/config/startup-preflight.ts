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

import { bootstrapLogger } from '../domain/shared/bootstrap-logger.js';
import { snapshotActivations } from '../domain/observability/feature-activation-registry.js';

/**
 * Minimal config surface needed for pre-flight checks.
 * Mirrors the relevant slices of {@link Config} without importing the full
 * module (avoids circular deps and keeps this module testable in isolation).
 */
interface StartupPreflightConfig {
  readonly vespa?: { readonly url?: string | undefined } | undefined;
  readonly openai?: {
    readonly apiKey?: string | undefined;
    readonly apiKeys?: readonly string[] | undefined;
  } | undefined;
  readonly cohere?: { readonly apiKey?: string | undefined } | undefined;
}

/**
 * Minimal PG-config surface needed for the SSL sanity check. Mirrors the
 * relevant slices of `config.pg` (env.ts) without importing the full env
 * module — keeps this file testable in isolation.
 */
export interface PgPreflightConfig {
  readonly connectionString?: string | undefined;
  readonly host?: string | undefined;
  readonly ssl: boolean;
}

/** Hosts for which an unencrypted PG connection is benign (no SSL warning). */
const LOCAL_PG_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Resolve the effective PG host from a config slice. Prefers the host parsed
 * out of a `connectionString` (DATABASE_URL), falling back to the discrete
 * `host` field. Returns `undefined` when no host can be safely determined.
 *
 * `new URL()` THROWS on malformed strings (Rule: external/string parsing must
 * not crash startup), so the parse is wrapped in try/catch. A parse failure
 * yields `undefined`, which the caller treats as "cannot determine — no warn"
 * to avoid false positives on exotic but valid DSNs.
 */
function resolvePgHost(pgConfig: PgPreflightConfig): string | undefined {
  const connectionString = pgConfig.connectionString;
  if (connectionString != null && connectionString !== '') {
    try {
      // node-postgres DSNs are URL-shaped (postgresql://user:pass@host:port/db).
      // URL.hostname extracts ONLY the authority host — credentials that happen
      // to contain 'localhost' as a substring do NOT leak into hostname.
      const parsed = new URL(connectionString);
      const hostname = parsed.hostname;
      if (hostname !== '') return hostname;
    } catch {
      // Malformed connection string — cannot determine host safely. Do not
      // warn (avoids false positives); the pool itself will surface a real
      // connect error if the DSN is genuinely broken.
      return undefined;
    }
  }
  if (pgConfig.host != null && pgConfig.host !== '') return pgConfig.host;
  return undefined;
}

/**
 * Warn when PostgreSQL SSL is disabled while connecting to a NON-local host.
 *
 * Unencrypted PG traffic to a remote DB (RDS, managed PG, any non-loopback
 * host) exposes credentials and query payloads on the wire. Local/loopback
 * connections are exempt — SSL there is pointless overhead and operators
 * routinely run plaintext locally.
 *
 * Does NOT throw; emits a single warn so operators can react without the app
 * refusing to boot in degraded environments.
 */
export function pgConfigSanityCheck(pgConfig: PgPreflightConfig): void {
  if (pgConfig.ssl) return; // SSL on — nothing to warn about.

  const host = resolvePgHost(pgConfig);
  if (host === undefined) return; // Cannot determine host — no false-positive warn.
  if (LOCAL_PG_HOSTS.has(host.toLowerCase())) return; // Loopback — plaintext is fine.

  bootstrapLogger.warn(
    { pgHost: host },
    'PG_SSL is disabled while connecting to a non-local PostgreSQL host — ' +
      'credentials and query payloads travel UNENCRYPTED. Set PG_SSL=true for remote databases.',
  );
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
export function warnStartupMisconfigurations(
  config: StartupPreflightConfig,
  pgConfig?: PgPreflightConfig,
): void {
  if (config.vespa?.url == null || config.vespa.url === '') {
    bootstrapLogger.warn(
      'VESPA_URL not configured — sparse/dense retrieval will fail',
    );
  }

  const hasOpenAiKey =
    (config.openai?.apiKey != null && config.openai.apiKey !== '') ||
    (config.openai?.apiKeys?.some((key) => key.trim().length > 0) ?? false);
  if (!hasOpenAiKey) {
    bootstrapLogger.warn(
      'No embedding source configured — dense retrieval degraded (set OPENAI_API_KEY or OPENAI_API_KEYS)',
    );
  }

  const hasCohereKey = config.cohere?.apiKey != null && config.cohere.apiKey !== '';
  if (!hasCohereKey) {
    bootstrapLogger.warn(
      'No reranker configured — results will use heuristic ranking only' +
      ' (set COHERE_API_KEY)',
    );
  }

  if (pgConfig !== undefined) {
    pgConfigSanityCheck(pgConfig);
  }

  // Wave 2 — single startup line summarising every registered SOTA
  // feature flag's activation state. Operators read this first when
  // diagnosing "is feature X actually on right now?" without having to
  // grep N separate modules' env reads.
  bootstrapLogger.info(
    { feature_activations: snapshotActivations() },
    'feature activation snapshot at startup',
  );
}
