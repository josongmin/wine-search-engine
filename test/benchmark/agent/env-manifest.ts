/**
 * Reproducibility env-manifest for a benchmark run.
 *
 * The bench report already carries `model`, `judgeModel`, `container`, `seed`,
 * `nodeVersion`, `platform`, `promptHash`. This module adds the missing
 * dimensions an operator needs to re-run a previous bench against an
 * identical environment:
 *
 *   - dated model checkpoint (e.g. `gpt-5.4-mini-2026-04-15`)
 *   - Vespa snapshot id
 *   - git sha + dirty flag
 *   - OS string (`process.platform` + release)
 *   - judge model id (same dated checkpoint resolution)
 *   - embedding model id
 *   - api base domain
 *
 * Plus a stable hash so two runs with the same manifest can be compared
 * by hash without a deep object diff. The hash deliberately EXCLUDES
 * timestamp-like fields so equivalent configs hash identically.
 *
 * Surfaced as `summary.environment` on every report AND as a standalone
 * `<path>` file when `--env-manifest <path>` is passed to the runner.
 *
 * All env-variable reads accept fallback constants so the manifest is
 * always well-formed (Zod `.parse()` in the schema accepts undefined →
 * defaults to '<unknown>' string, never throws).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { platform as osPlatform, release as osRelease } from 'node:os';
import { z } from 'zod';

// ─── named constants (CLAUDE.md rule 15) ──────────────────────────────────
/** Slice length for SHA-256 truncation. 16 hex = 64 bits, low collision. */
const HASH_HEX_SLICE_LENGTH = 16;
/** Max length of a captured env value to keep the manifest bounded. */
const MAX_ENV_VALUE_LENGTH = 256;
/** Sentinel for missing fields — never null/undefined to keep schema strict. */
const UNKNOWN = '<unknown>';
/** Bound on git-describe output captured in manifest. */
const MAX_GIT_DESCRIBE_LENGTH = 96;

// ─────────────────────────────────────────────────────────────────────────
// Zod schema
// ─────────────────────────────────────────────────────────────────────────

export const envManifestSchema = z.object({
  /** ISO 8601 timestamp of when the manifest was built (EXCLUDED from hash). */
  capturedAt: z.string(),

  /** Agent model id (with dated checkpoint when env supplies one). */
  agentModel: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
  /** Judge model id ('disabled' when judge is off). */
  judgeModel: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
  /** Embedding model id. */
  embeddingModel: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
  /** OpenAI API hostname (no auth). */
  apiBaseDomain: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),

  /** Vespa snapshot id pointer at run time (env var or '<unknown>'). */
  vespaSnapshotId: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
  /** Vespa tenant ('aoa' for current ops infra; '<unknown>' otherwise). */
  vespaTenant: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),

  /** Node.js version (e.g. 'v22.4.0'). */
  nodeVersion: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
  /** OS string: `${platform}-${release}`. */
  os: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),

  /** Git sha (full or short — long-form preferred for unambiguous diffs). */
  gitSha: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
  /** True when working tree is dirty (uncommitted edits). */
  gitDirty: z.boolean(),
  /** git describe --always --dirty --tags output for human display. */
  gitDescribe: z.string().min(1).max(MAX_GIT_DESCRIBE_LENGTH).optional(),

  /** Container mode the runner used ('real' for current bench). */
  container: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
  /** Seed value supplied at run time. 'none' when unseeded. */
  seed: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
  /** Profile flag supplied (e.g. 'standard', 'quick'). 'none' when unspecified. */
  profile: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),

  /** SHA-256 (sliced) of the agent system prompt. */
  promptHash: z.string().min(1).max(MAX_ENV_VALUE_LENGTH),
}).strict();

export type EnvManifest = z.infer<typeof envManifestSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────────

interface BuildEnvManifestInput {
  readonly agentModel: string;
  readonly judgeModel: string | null;
  readonly embeddingModel: string;
  readonly apiBaseDomain: string;
  readonly container: string;
  readonly seed: number | null;
  readonly profile: string | undefined;
  readonly promptHash: string;
}

/**
 * Build the env manifest for the current run. Reads from `process.env` for
 * Vespa snapshot pointer + dated model checkpoint hints, and shells out to
 * `git` for sha + dirty-flag detection. Failures fall back to UNKNOWN —
 * the manifest must never raise on missing optional inputs.
 *
 * The "dated checkpoint" rule:
 *   - If env vars `OPENAI_AGENT_MODEL_CHECKPOINT` or
 *     `OPENAI_JUDGE_MODEL_CHECKPOINT` are set, prefer those.
 *   - Otherwise the bare model id is captured (acceptable when no dated
 *     suffix is available — at least the rest of the manifest is reproducible).
 */
export function buildEnvManifest(input: BuildEnvManifestInput): EnvManifest {
  const agentCheckpoint = clipEnv(process.env['OPENAI_AGENT_MODEL_CHECKPOINT']);
  const judgeCheckpoint = clipEnv(process.env['OPENAI_JUDGE_MODEL_CHECKPOINT']);

  const vespaSnapshot = clipEnv(process.env['VESPA_SNAPSHOT_ID']) ?? UNKNOWN;
  const vespaTenant = clipEnv(process.env['VESPA_CLOUD_TENANT']) ?? UNKNOWN;

  const git = readGitState();

  const candidate: EnvManifest = {
    capturedAt: new Date().toISOString(),
    agentModel: agentCheckpoint ?? input.agentModel,
    judgeModel: input.judgeModel === null ? 'disabled' : (judgeCheckpoint ?? input.judgeModel),
    embeddingModel: input.embeddingModel,
    apiBaseDomain: input.apiBaseDomain,
    vespaSnapshotId: vespaSnapshot,
    vespaTenant,
    nodeVersion: process.version,
    os: `${osPlatform()}-${osRelease()}`.slice(0, MAX_ENV_VALUE_LENGTH),
    gitSha: git.sha,
    gitDirty: git.dirty,
    ...(git.describe !== undefined ? { gitDescribe: git.describe } : {}),
    container: input.container,
    seed: input.seed === null ? 'none' : String(input.seed),
    profile: input.profile ?? 'none',
    promptHash: input.promptHash,
  };

  // Round-trip through Zod — guarantees the consumer always sees a valid
  // manifest, and lets the test assert on shape stability cheaply.
  return envManifestSchema.parse(candidate);
}

/**
 * Compute a stable SHA-256 hash of the manifest's config-relevant fields.
 * Excludes `capturedAt` so two identical-config runs produce matching hashes.
 *
 * Stable JSON: keys serialized in alphabetic order to keep the hash
 * representation-agnostic.
 */
export function manifestHash(manifest: EnvManifest): string {
  const { capturedAt: _captured, ...rest } = manifest;
  const stable = stableStringify(rest);
  return createHash('sha256').update(stable).digest('hex').slice(0, HASH_HEX_SLICE_LENGTH);
}

// ─────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────

function clipEnv(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_ENV_VALUE_LENGTH);
}

interface GitState {
  readonly sha: string;
  readonly dirty: boolean;
  readonly describe?: string;
}

function readGitState(): GitState {
  // Each git call is best-effort. If `git` is absent or the cwd is not a
  // repo, we return UNKNOWN sha + dirty=false. NEVER throw — bench must run
  // outside repos too (CI extracted artifacts, container snapshots).
  let sha = UNKNOWN;
  let dirty = false;
  let describe: string | undefined;
  try {
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .slice(0, MAX_ENV_VALUE_LENGTH);
    if (sha.length === 0) sha = UNKNOWN;
  } catch {
    sha = UNKNOWN;
  }
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString();
    dirty = status.trim().length > 0;
  } catch {
    dirty = false;
  }
  try {
    const desc = execFileSync('git', ['describe', '--always', '--dirty', '--tags'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .slice(0, MAX_GIT_DESCRIBE_LENGTH);
    if (desc.length > 0) describe = desc;
  } catch {
    describe = undefined;
  }
  return describe !== undefined ? { sha, dirty, describe } : { sha, dirty };
}

/**
 * Deterministic JSON serializer with sorted keys at every level. Keeps the
 * manifest hash stable across runtime object-key insertion order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort((a, b) => a[0].localeCompare(b[0]));
  return '{' + entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',') + '}';
}
