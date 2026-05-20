/**
 * Feature flag for the Plan-then-Execute `/v1/wine-search` route.
 *
 * Production rollout follows a strangler-fig pattern: the legacy agent route
 * (`POST /v1/agent/*`) remains the default surface. The new orchestrator is
 * wired into the composition root unconditionally — when this flag is OFF,
 * `Container.wineSearch` resolves to `undefined` and the route is not
 * registered, so there is zero runtime cost.
 *
 * Env var: `WINE_SEARCH_ENABLED`. Default OFF for safe rollout. After Track D
 * shadow-mode validation, operators flip to `true` in the deployment env.
 *
 * The flag is intentionally read at composition-root construction time only —
 * NOT per request — so flipping it at runtime requires a process restart.
 * This matches `AGENT_ENABLED` semantics and keeps the wiring branch-free
 * during request handling.
 *
 * SOTA+++++ design notes:
 *  - Single source of truth for the env var name (`WINE_SEARCH_FEATURE_FLAG_ENV`).
 *    Importers MUST reference the constant, not the literal string, so
 *    grep-driven audits find every read site.
 *  - Strict string equality (`=== 'true'`). Any other value, including
 *    `'TRUE'`, `'1'`, or empty string, resolves to `false`. This matches the
 *    `z.enum(['true','false']).transform` pattern used across the env schemas
 *    and avoids "is this truthy?" ambiguity.
 *  - No side effects on import. Pure function so unit tests can pass synthetic
 *    `env` records without monkey-patching `process.env`.
 */

/** Canonical env-var name. Import this rather than typing the literal. */
export const WINE_SEARCH_FEATURE_FLAG_ENV = 'WINE_SEARCH_ENABLED';

/** The exact string value (case-sensitive) that enables the route. */
const WINE_SEARCH_FLAG_ENABLED_VALUE = 'true';

/**
 * Returns `true` iff `WINE_SEARCH_ENABLED=true` is set in the supplied env.
 *
 * @param env - Defaults to `process.env`. Tests pass a synthetic record.
 */
export function isWineSearchEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[WINE_SEARCH_FEATURE_FLAG_ENV] === WINE_SEARCH_FLAG_ENABLED_VALUE;
}
