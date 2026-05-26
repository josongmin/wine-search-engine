/**
 * Wave 2 — process-wide registry of SOTA feature-activation states.
 *
 * The repo's SOTA features (multi-query / HyDE rewrite, tool result
 * cache, alias overlay graceful fallback, per-tool fail-closed
 * vocabulary, OpenAI reasoning effort/headroom, Vespa bulk-hydration
 * timing) are gated by independent env vars scattered across
 * `src/config/`, `src/application/`, and `src/infrastructure/`. The
 * registry centralises their states so:
 *
 *  - One pipeline_debug payload can show "which features are on for
 *    this request" without joining 8 separate log lines.
 *  - The startup-preflight log can emit a one-line summary of
 *    activation state — the operator's first signal that
 *    e.g. `WINE_SEARCH_MULTI_QUERY_ENABLED=true` did NOT take effect
 *    (e.g. typo on the env var name).
 *  - New features register themselves at module load via
 *    {@link registerFeature}; the call is idempotent (last-write-wins
 *    so test bootstraps can re-register without crashing).
 *
 * The registry is intentionally a module-scope singleton — one process
 * has one set of features. Tests can call {@link __resetFeatureActivationRegistryForTests}
 * to clear between cases.
 */

/**
 * Activation states are narrow on purpose — operators don't need
 * the env value, they need to know whether the feature is on,
 * off, or under controlled experiment.
 *
 *  - `'on'`         → feature is enabled for ALL traffic.
 *  - `'off'`        → feature is disabled (the default for opt-in
 *                     flags; or explicit override).
 *  - `'experiment'` → feature runs for a SUBSET (canary / A-B /
 *                     allowlist). Use this when the env value
 *                     selects a partial cohort.
 */
export type FeatureActivationState = 'on' | 'off' | 'experiment';

interface FeatureActivation {
  readonly name: string;
  readonly getActivationState: () => FeatureActivationState;
}

const features = new Map<string, FeatureActivation>();

/**
 * Register a feature with a getter that returns its current activation
 * state. The getter is invoked at snapshot time so callers always see
 * the latest state (handy when tests mutate `process.env` between
 * cases). Re-registering the same name OVERWRITES the prior entry
 * (last-write-wins) — this is deliberate so test bootstraps and
 * container rebuilds don't fail loudly. Production registers each
 * feature exactly once at module load.
 */
export function registerFeature(
  name: string,
  getActivationState: () => FeatureActivationState,
): void {
  features.set(name, { name, getActivationState });
}

/**
 * Snapshot the current activation state of every registered feature.
 * The returned object is a plain `Record` so it serialises cleanly
 * into pipeline_debug payloads and startup-preflight logs without
 * extra projection.
 */
export function snapshotActivations(): Record<string, FeatureActivationState> {
  const snapshot: Record<string, FeatureActivationState> = {};
  for (const [name, feature] of features) {
    snapshot[name] = feature.getActivationState();
  }
  return snapshot;
}

/** Test helper — clear all registrations. Production never calls this. */
export function __resetFeatureActivationRegistryForTests(): void {
  features.clear();
}

// ---------------------------------------------------------------------------
// Module-load registration of repo-wide SOTA feature flags.
//
// Each entry below maps an existing env var to its production semantics.
// Adding a new feature flag? Register it HERE rather than in 8 scattered
// modules — that is the entire point of this registry (Wave 2).
//
// Registrations are intentionally co-located with the registry rather
// than inlined at each call-site so:
//   1. There's a single place to audit "every active feature flag".
//   2. Adding a feature only requires editing this file + the consumer.
//   3. The consumer module's env read remains the SOURCE OF TRUTH —
//      this registry just MIRRORS that read for observability.
// ---------------------------------------------------------------------------

/** Multi-Query + HyDE rewrite (Wave 2: default ON). */
registerFeature('multi_query_rewrite', () =>
  // Default ON. Only `'false'` explicitly disables. Other unset/garbage
  // values fall through to ON so a typo in the env var name does NOT
  // silently disable the feature — operators must opt OUT explicitly.
  process.env['WINE_SEARCH_MULTI_QUERY_ENABLED'] === 'false' ? 'off' : 'on',
);

/** Mini-loop tool result cache (Redis-backed). */
registerFeature('tool_result_cache', () =>
  // Default ON (cache enabled). `'0'` disables it. Mirrors the
  // semantics of `src/application/wine-search/mini-loop.ts`.
  process.env['WINE_SEARCH_TOOL_CACHE_ENABLED'] === '0' ? 'off' : 'on',
);

/** Per-tool fail-closed vocabulary. */
registerFeature('disabled_tools_fail_closed', () => {
  // Treated as ON when at least one tool name is present in the
  // env-supplied comma-list. Empty / unset → OFF (no tools blocked).
  const raw = process.env['WINE_SEARCH_DISABLED_TOOLS'];
  if (raw == null || raw.trim().length === 0) return 'off';
  const tools = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  return tools.length > 0 ? 'on' : 'off';
});

/** OpenAI reasoning headroom token override. */
registerFeature('openai_reasoning_headroom_override', () => {
  // Treated as ON when the operator explicitly sets a numeric value.
  // Unset = OFF (default headroom applies). A non-numeric value falls
  // back to OFF so a typo does NOT register as "experiment".
  const raw = process.env['WINE_SEARCH_REASONING_HEADROOM_TOKENS'];
  if (raw == null || raw.trim().length === 0) return 'off';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? 'on' : 'off';
});

/** OpenAI reasoning effort override. */
registerFeature('openai_reasoning_effort_override', () => {
  // ON when explicitly set to any non-empty value. The downstream
  // adapter validates the actual effort value; here we report whether
  // an override was supplied at all.
  const raw = process.env['WINE_SEARCH_REASONING_EFFORT'];
  return raw != null && raw.trim().length > 0 ? 'on' : 'off';
});

/** Vespa bulk-hydration per-request timeout override. */
registerFeature('vespa_bulk_hydration_timeout_override', () => {
  const raw = process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'];
  if (raw == null || raw.trim().length === 0) return 'off';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? 'on' : 'off';
});

/** Vespa bulk-hydration batch-size override. */
registerFeature('vespa_bulk_hydration_batch_size_override', () => {
  const raw = process.env['VESPA_BULK_HYDRATION_BATCH_SIZE'];
  if (raw == null || raw.trim().length === 0) return 'off';
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? 'on' : 'off';
});
