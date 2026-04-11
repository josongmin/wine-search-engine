/**
 * Suite registry — single source of truth for fixture suite metadata.
 *
 * Every suite entry records its:
 *  - canonical ID (used in case files and Zod schemas)
 *  - directory name (under suites/ in the fixture repo)
 *  - case ID prefix (the 2-3 letter prefix before the dash, e.g. "eek" in eek-001)
 *
 * Adding a new suite requires exactly ONE change: append a row here.
 * ALL_SUITE_IDS, SUITE_DIR_MAP, SUITE_ID_TO_DIR, and CASE_PREFIX_TO_SUITE
 * are ALL derived from this registry — never edit them directly.
 *
 * @module suite-registry
 */

export const SUITE_REGISTRY = [
  { id: 'exact_entity_recovery',   dir: 'exact-entity-ko',          prefix: 'eek' },
  { id: 'ambiguous_shortform',     dir: 'ambiguous-shortform',       prefix: 'asf' },
  { id: 'mixed_script_entity',     dir: 'mixed-script-entity',       prefix: 'mse' },
  { id: 'noisy_attribute_recovery', dir: 'noisy-attribute',          prefix: 'nar' },
  { id: 'search_feature_behavior', dir: 'search-feature-behavior',   prefix: 'sfb' },
  { id: 'agentic_tool_use',        dir: 'agentic-tool-use',          prefix: 'atu' },
  { id: 'agentic_answer_quality',  dir: 'agentic-answer-quality',    prefix: 'aaq' },
  { id: 'performance_latency',     dir: 'performance-latency',       prefix: 'plt' },
  { id: 'performance_load',        dir: 'performance-load',          prefix: 'plo' },
] as const satisfies ReadonlyArray<{ id: string; dir: string; prefix: string }>;

export type SuiteRegistryEntry = (typeof SUITE_REGISTRY)[number];
export type SuiteId = SuiteRegistryEntry['id'];

// ---------------------------------------------------------------------------
// Derived maps — computed once at module load, never written by hand
// ---------------------------------------------------------------------------

/** All 9 suite IDs in definition order. Used for z.enum() and iteration. */
export const ALL_SUITE_IDS = SUITE_REGISTRY.map((r) => r.id) as unknown as readonly [SuiteId, ...SuiteId[]];

/** fixture-repo directory name → SuiteId */
export const SUITE_DIR_MAP: Readonly<Record<string, SuiteId>> = Object.fromEntries(
  SUITE_REGISTRY.map((r) => [r.dir, r.id]),
);

/** SuiteId → fixture-repo directory name */
export const SUITE_ID_TO_DIR: Readonly<Record<SuiteId, string>> = Object.fromEntries(
  SUITE_REGISTRY.map((r) => [r.id, r.dir]),
) as Record<SuiteId, string>;

/** Case ID prefix (e.g. "eek") → SuiteId. Used by inferSuiteFromCaseId. */
export const CASE_PREFIX_TO_SUITE: Readonly<Record<string, SuiteId>> = Object.fromEntries(
  SUITE_REGISTRY.map((r) => [r.prefix, r.id]),
);

// ---------------------------------------------------------------------------
// Startup integrity assertions — catch registry mistakes at module load time
// ---------------------------------------------------------------------------

// These throw immediately if SUITE_REGISTRY has duplicate ids, prefixes, or dirs,
// so bugs surface at import rather than silently corrupting derived maps.
const _idSet = new Set(SUITE_REGISTRY.map((r) => r.id));
const _prefixSet = new Set(SUITE_REGISTRY.map((r) => r.prefix));
const _dirSet = new Set(SUITE_REGISTRY.map((r) => r.dir));

if (_idSet.size !== SUITE_REGISTRY.length) {
  throw new Error(`SUITE_REGISTRY integrity: duplicate suite IDs detected`);
}
if (_prefixSet.size !== SUITE_REGISTRY.length) {
  throw new Error(`SUITE_REGISTRY integrity: duplicate case ID prefixes detected`);
}
if (_dirSet.size !== SUITE_REGISTRY.length) {
  throw new Error(`SUITE_REGISTRY integrity: duplicate directory names detected`);
}
