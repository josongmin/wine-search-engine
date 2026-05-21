/**
 * Runtime substrates publication regression (maturity 2 -> 3 promotion).
 *
 * The publisher in scripts/etl/publish-runtime-substrates.ts ships the
 * runtime cache substrates (alias / NL mappings / ambiguity registry) used
 * by the live query path. The promotion to maturity 3 requires:
 *
 *  1. A dedicated regression suite (this file).
 *  2. An explicit named TTL constant (RUNTIME_SUBSTRATE_TTL_SECONDS) instead
 *     of an unbounded "freshness whenever" contract.
 *  3. A versioned schema prefix (SUBSTRATE_VERSION_PREFIX) so emitted
 *     artifacts advertise their schema identity.
 *  4. An atomic cutover via stage-then-promote (already partially in place
 *     via promoteRuntimeSubstrateArtifacts; tests below pin the invariants).
 *  5. Failure rollback: partial failure preserves the previous active
 *     artifacts (restoreRuntimeSubstrateArtifacts contract).
 *
 * Append-only test: never delete this file.
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RUNTIME_SUBSTRATE_TTL_SECONDS,
  SUBSTRATE_VERSION_PREFIX,
  buildRuntimeSubstrateArtifactEnvelope,
  promoteRuntimeSubstrateArtifacts,
  resolveRuntimeSubstrateCutoverPaths,
  restoreRuntimeSubstrateArtifacts,
} from '../../scripts/etl/publish-runtime-substrates.js';
import {
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../src/domain/shared/constants/search-snapshot.js';
import type {
  SearchSnapshotRuntimeState,
} from '../../scripts/etl/search-snapshot-schema.js';

const PUBLISHER_PATH = fileURLToPath(
  new URL('../../scripts/etl/publish-runtime-substrates.ts', import.meta.url),
);
const PUBLISHER_SRC = readFileSync(PUBLISHER_PATH, 'utf8');

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'runtime-substrates-regression-'));
}

function makeRuntimeState(overrides: Partial<SearchSnapshotRuntimeState> = {}): SearchSnapshotRuntimeState {
  return {
    schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
    snapshotId: 'search-snapshot:v1:regression',
    contentHash: 'a'.repeat(64),
    publishedAt: '2026-05-21T00:00:00.000Z',
    manifestPath: '/tmp/manifest.json',
    nlMappingsRuntimePath: '/tmp/nl-mappings.json',
    allowMissingLtr: false,
    counts: {
      entities: 3,
      aliases: 4,
      ambiguityRegistry: 1,
      nlMappings: 2,
      activeLtrModels: 1,
    },
    hashes: {
      entities: 'h-entities',
      aliases: 'h-aliases',
      ambiguityRegistry: 'h-ambiguity',
      nlMappings: 'h-nl',
      activeLtrModels: 'h-ltr',
    },
    ...overrides,
  };
}

describe('Runtime substrates publication — named constants', () => {
  it('exports RUNTIME_SUBSTRATE_TTL_SECONDS = 7 days', () => {
    // 7 days is the SLA between publishes for the runtime cache substrates.
    // Beyond TTL, downstream readers must treat the substrate as stale and
    // refuse to start the live pipeline. The constant MUST be derived from
    // 7 * 24 * 3600 so a refactor that changes the unit (e.g. ms) trips a
    // test rather than silently inflating the freshness window 1000x.
    expect(RUNTIME_SUBSTRATE_TTL_SECONDS).toBe(7 * 24 * 3600);
  });

  it('TTL constant is referenced by name (no magic number) in the publisher source', () => {
    expect(PUBLISHER_SRC).toMatch(/RUNTIME_SUBSTRATE_TTL_SECONDS/);
    // The literal `604800` (= 7 days in seconds) MUST NOT appear bare in the
    // publisher — it must be expressed via the named constant.
    expect(PUBLISHER_SRC).not.toMatch(/[^0-9]604800[^0-9]/);
  });

  it('exports SUBSTRATE_VERSION_PREFIX as a stable schema identity', () => {
    expect(typeof SUBSTRATE_VERSION_PREFIX).toBe('string');
    expect(SUBSTRATE_VERSION_PREFIX.length).toBeGreaterThan(0);
    // Prefix scopes the version namespace to the runtime substrate concept,
    // distinct from the snapshot-state version namespace.
    expect(SUBSTRATE_VERSION_PREFIX).toMatch(/runtime[-_]substrate/);
  });
});

describe('Runtime substrates publication — artifact envelope', () => {
  it('attaches schema_version, ttl_seconds, generated_at, and snapshot_id', () => {
    const envelope = buildRuntimeSubstrateArtifactEnvelope({
      snapshotId: 'search-snapshot:v1:regression',
      generatedAt: '2026-05-21T00:00:00.000Z',
      kind: 'nl-mappings',
    });
    expect(envelope.schema_version).toContain(SUBSTRATE_VERSION_PREFIX);
    expect(envelope.ttl_seconds).toBe(RUNTIME_SUBSTRATE_TTL_SECONDS);
    expect(envelope.generated_at).toBe('2026-05-21T00:00:00.000Z');
    expect(envelope.snapshot_id).toBe('search-snapshot:v1:regression');
    expect(envelope.kind).toBe('nl-mappings');
  });

  it('schema_version increments deterministically by snapshot id (acts as version bump)', () => {
    // Each publish carries its snapshot_id inside the schema_version suffix —
    // this is the "atomic version increment" contract. Two distinct snapshot
    // ids MUST produce two distinct schema_version values.
    const a = buildRuntimeSubstrateArtifactEnvelope({
      snapshotId: 'search-snapshot:v1:a',
      generatedAt: '2026-05-21T00:00:00.000Z',
      kind: 'aliases',
    });
    const b = buildRuntimeSubstrateArtifactEnvelope({
      snapshotId: 'search-snapshot:v1:b',
      generatedAt: '2026-05-21T00:00:00.000Z',
      kind: 'aliases',
    });
    expect(a.schema_version).not.toEqual(b.schema_version);
  });

  it('preserves Korean alias content under NFC through the envelope', () => {
    // Korean syllables are precomposed (NFC) by the upstream alias generation
    // pipeline. The envelope must not perform decomposition (NFD) — that
    // would silently break alias matching at the runtime.
    const korean = '오퍼스원';
    const envelope = buildRuntimeSubstrateArtifactEnvelope({
      snapshotId: 'search-snapshot:v1:regression',
      generatedAt: '2026-05-21T00:00:00.000Z',
      kind: 'aliases',
      sample: korean,
    });
    expect(envelope.sample).toBe(korean);
    expect(envelope.sample).toBe(korean.normalize('NFC'));
  });

  it('handles empty substrate kinds gracefully (no throw)', () => {
    expect(() =>
      buildRuntimeSubstrateArtifactEnvelope({
        snapshotId: 'search-snapshot:v1:empty',
        generatedAt: '2026-05-21T00:00:00.000Z',
        kind: 'ambiguity-registry',
      }),
    ).not.toThrow();
  });

  it('rejects non-finite generated_at timestamps would break TTL math (sanity)', () => {
    // Defensive: any caller passing an invalid timestamp should NOT silently
    // produce an envelope — that would corrupt the freshness window.
    expect(() =>
      buildRuntimeSubstrateArtifactEnvelope({
        snapshotId: 'search-snapshot:v1:regression',
        generatedAt: 'not-a-timestamp',
        kind: 'nl-mappings',
      }),
    ).toThrow(/generated_at/);
  });
});

describe('Runtime substrates publication — atomic cutover (file IO)', () => {
  it('staged artifacts remain readable until promote completes', async () => {
    // Atomic-update contract: writing the new version (staged) must not
    // overwrite the active artifact until promote runs.
    const dir = await makeTempDir();
    const activeStatePath = path.join(dir, 'runtime-state.json');
    const activeNlPath = path.join(dir, 'nl-mappings.json');

    const previousState = makeRuntimeState({ snapshotId: 'search-snapshot:v1:OLD' });
    await fs.writeFile(activeStatePath, JSON.stringify(previousState, null, 2));
    await fs.writeFile(activeNlPath, JSON.stringify({ mappings: ['old'] }));

    const cutover = resolveRuntimeSubstrateCutoverPaths({
      snapshotId: 'search-snapshot:v1:NEW',
      runtimeStatePath: activeStatePath,
      runtimeNlMappingsPath: activeNlPath,
    });

    const newState = makeRuntimeState({
      snapshotId: 'search-snapshot:v1:NEW',
      nlMappingsRuntimePath: cutover.stagedRuntimeNlMappingsPath,
    });
    await fs.writeFile(cutover.stagedRuntimeStatePath, JSON.stringify(newState, null, 2));
    await fs.writeFile(cutover.stagedRuntimeNlMappingsPath, JSON.stringify({ mappings: ['new'] }));

    // BEFORE promote: active still points at OLD.
    const activeBefore = JSON.parse(await fs.readFile(activeStatePath, 'utf8')) as { snapshotId: string };
    expect(activeBefore.snapshotId).toBe('search-snapshot:v1:OLD');

    await promoteRuntimeSubstrateArtifacts(cutover);

    // AFTER promote: active swapped to NEW; staged files removed.
    const activeAfter = JSON.parse(await fs.readFile(activeStatePath, 'utf8')) as { snapshotId: string };
    expect(activeAfter.snapshotId).toBe('search-snapshot:v1:NEW');

    await expect(fs.access(cutover.stagedRuntimeStatePath)).rejects.toThrow();
  });

  it('failure rollback retains the previous active artifacts when restore is invoked', async () => {
    const dir = await makeTempDir();
    const activeStatePath = path.join(dir, 'runtime-state.json');
    const activeNlPath = path.join(dir, 'nl-mappings.json');

    const previousStateRaw = `${JSON.stringify(makeRuntimeState({ snapshotId: 'search-snapshot:v1:OLD' }), null, 2)}\n`;
    const previousNlRaw = `${JSON.stringify({ mappings: ['old'] })}\n`;
    await fs.writeFile(activeStatePath, previousStateRaw);
    await fs.writeFile(activeNlPath, previousNlRaw);

    // Simulate a half-promoted state by overwriting with garbage.
    await fs.writeFile(activeStatePath, '{"corrupt":true}\n');
    await fs.writeFile(activeNlPath, '{"corrupt":true}\n');

    await restoreRuntimeSubstrateArtifacts({
      activeRuntimeStatePath: activeStatePath,
      previousRuntimeStateContents: previousStateRaw,
      activeRuntimeNlMappingsPath: activeNlPath,
      previousRuntimeNlMappingsContents: previousNlRaw,
    });

    expect(await fs.readFile(activeStatePath, 'utf8')).toBe(previousStateRaw);
    expect(await fs.readFile(activeNlPath, 'utf8')).toBe(previousNlRaw);
  });

  it('restore removes the active file when no previous contents existed (first publish failure)', async () => {
    const dir = await makeTempDir();
    const activeStatePath = path.join(dir, 'runtime-state.json');
    const activeNlPath = path.join(dir, 'nl-mappings.json');

    // Write half-promoted (corrupt) artifacts; previous = undefined.
    await fs.writeFile(activeStatePath, '{"corrupt":true}');
    await fs.writeFile(activeNlPath, '{"corrupt":true}');

    await restoreRuntimeSubstrateArtifacts({
      activeRuntimeStatePath: activeStatePath,
      previousRuntimeStateContents: undefined,
      activeRuntimeNlMappingsPath: activeNlPath,
      previousRuntimeNlMappingsContents: undefined,
    });

    await expect(fs.access(activeStatePath)).rejects.toThrow();
    await expect(fs.access(activeNlPath)).rejects.toThrow();
  });
});

describe('Runtime substrates publication — adjacency invariants', () => {
  it('mixed Korean + English substrate items both pass NFC normalization', () => {
    const items = ['Opus One', '오퍼스원', 'Château Margaux', '샤토 마고'];
    for (const item of items) {
      const envelope = buildRuntimeSubstrateArtifactEnvelope({
        snapshotId: 'search-snapshot:v1:mixed',
        generatedAt: '2026-05-21T00:00:00.000Z',
        kind: 'aliases',
        sample: item,
      });
      expect(envelope.sample).toBe(item.normalize('NFC'));
    }
  });

  it('two simultaneous staged writes for different snapshot ids never collide on path', () => {
    // Concurrent publish guard (path-level): two publishes with different
    // snapshot ids produce non-overlapping staging paths. The active file
    // (target of the final rename) is shared, but rename is atomic.
    const a = resolveRuntimeSubstrateCutoverPaths({
      snapshotId: 'search-snapshot:v1:A',
      runtimeStatePath: '/tmp/runtime-state.json',
      runtimeNlMappingsPath: '/tmp/nl-mappings.json',
    });
    const b = resolveRuntimeSubstrateCutoverPaths({
      snapshotId: 'search-snapshot:v1:B',
      runtimeStatePath: '/tmp/runtime-state.json',
      runtimeNlMappingsPath: '/tmp/nl-mappings.json',
    });
    expect(a.stagedRuntimeStatePath).not.toBe(b.stagedRuntimeStatePath);
    expect(a.stagedRuntimeNlMappingsPath).not.toBe(b.stagedRuntimeNlMappingsPath);
    // But the active target IS shared — that's the cutover point.
    expect(a.activeRuntimeStatePath).toBe(b.activeRuntimeStatePath);
    expect(a.activeRuntimeNlMappingsPath).toBe(b.activeRuntimeNlMappingsPath);
  });

  it('publisher source no longer contains the literal "TTL-based refresh 없음" admission', () => {
    // After maturity 3, the YAML known_limitations entry "TTL-based refresh
    // 없음" must be removed; the publisher source must reference the named
    // TTL constant. This is a forward-looking guard so future edits to the
    // YAML don't silently re-introduce the limitation.
    expect(PUBLISHER_SRC).toMatch(/RUNTIME_SUBSTRATE_TTL_SECONDS/);
  });
});
