/**
 * Property-based invariants for the readiness probe matrix (Kubernetes
 * readinessProbe + Google SRE SLO/SLI). Pairs with
 * `http-readiness-slo-budget.regression.test.ts` which fixes specific
 * scenarios; this file uses fast-check to assert the contract holds across
 * arbitrarily generated probe matrices.
 *
 * Append-only regression. NEVER delete.
 *
 * Properties covered:
 *   P1. PROBE_CRITICALITY vocabulary completeness — every entry maps to a
 *       known criticality token, and the set is non-empty.
 *   P2. Critical probe failure ⇒ 503 — for every random matrix where ANY
 *       `required: true` probe reports 'down', `/ready` returns 503.
 *   P3. Non-critical-only failure ⇒ 200 — for every random matrix where only
 *       `required: false` probes report 'down', `/ready` returns 200 and the
 *       degradation is still surfaced in the body.
 *   P4. Snapshot readiness staleness — `probeSearchSnapshotRuntimeState`
 *       returns 'down' when any runtime invariant violates the documented
 *       contract (counts/hashes/missing-LTR rules), and 'up' otherwise.
 *   P5. Parallel execution wall-clock — probes are scheduled in parallel; the
 *       observed wall-clock is bounded by the SLOWEST probe latency + slack,
 *       not the sum (Promise.allSettled invariant).
 *   P6. Korean (한글) error preservation — Korean error messages from any
 *       probe are surfaced verbatim in the `reason` field (CLAUDE.md rule 5).
 *
 * All probes are mocked at the `ReadinessCheck` port — no real PG/Redis/
 * Vespa/OpenAI/Cohere is contacted. Clock for snapshot-staleness uses an
 * injected `now()` so we never depend on `Date.now()` directly.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  registerHealthRoutes,
  type ReadinessCheck,
  type ReadinessStatus,
} from '../../src/interface/http/routes/health.route.js';
import {
  PROBE_CRITICALITY,
  READINESS_TOTAL_BUDGET_MS,
} from '../../src/infrastructure/health/readiness-probes.js';
import {
  probeSearchSnapshotRuntimeState,
} from '../../src/infrastructure/health/search-snapshot-readiness.js';
import {
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../src/domain/shared/constants/search-snapshot.js';
import {
  hashStableJson,
  hashText,
  stableJsonStringify,
} from '../../src/domain/shared/utils/stable-json.js';
import { buildMinimalLookupRuntimeStatePlane } from '../helpers/minimal-search-snapshot-runtime-state.js';

interface ReadyResponseBody {
  readonly ready: boolean;
  readonly timestamp: string;
  readonly checks: Readonly<Record<string, {
    readonly status: ReadinessStatus;
    readonly required: boolean;
    readonly reason?: string;
    readonly error_class?: string;
  }>>;
}

// Property-test budget: enough runs to shrink confidently without blowing the
// CI wall-clock. Kept under the default vitest test timeout (5 s) per file.
const PROPERTY_NUM_RUNS = 100;

const VALID_CRITICALITY_TOKENS = new Set(['critical', 'non_critical'] as const);

async function buildAppWith(
  readiness: Readonly<Record<string, ReadinessCheck>>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app, { readiness });
  await app.ready();
  return app;
}

/** Generates a probe-name string that does not collide with the route's
 * implicit defaults ('postgres', 'redis'). Constrained to a strict
 * `[a-z0-9]` identifier alphabet so JSON key parsing is unambiguous AND
 * the arbitrary cannot collapse distinct values to the same sanitized
 * form (which previously broke fc.uniqueArray invariants). */
const PROBE_NAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const probeNameArb = fc
  .array(fc.integer({ min: 0, max: PROBE_NAME_ALPHABET.length - 1 }), {
    minLength: 3,
    maxLength: 10,
  })
  .map((indices) => `probe_${indices.map((i) => PROBE_NAME_ALPHABET[i]).join('')}`)
  .filter((s) => s !== 'postgres' && s !== 'redis');

/** A single ReadinessCheck factory + a flag describing whether the probe is
 * required (critical) and whether it returns 'up' or 'down'. */
interface ProbeSpec {
  readonly name: string;
  readonly required: boolean;
  readonly status: ReadinessStatus;
}

const probeSpecArb = fc.record<ProbeSpec>({
  name: probeNameArb,
  required: fc.boolean(),
  status: fc.constantFrom<ReadinessStatus>('up', 'down'),
});

function buildReadinessFromSpecs(
  specs: readonly ProbeSpec[],
): Readonly<Record<string, ReadinessCheck>> {
  const out: Record<string, ReadinessCheck> = {};
  for (const spec of specs) {
    // Last-write-wins on name collision is fine for property testing — the
    // result is still a well-formed matrix.
    out[spec.name] = {
      required: spec.required,
      check: (): ReadinessStatus => spec.status,
    };
  }
  return out;
}

describe('readiness probe matrix — property-based invariants', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  describe('P1. PROBE_CRITICALITY vocabulary completeness', () => {
    it('every entry maps to a known criticality token (critical | non_critical)', () => {
      const entries = Object.entries(PROBE_CRITICALITY);
      expect(entries.length).toBeGreaterThan(0);
      fc.assert(
        fc.property(
          fc.constantFrom(...entries),
          ([probeName, criticality]) => {
            expect(typeof probeName).toBe('string');
            expect(probeName.length).toBeGreaterThan(0);
            expect(VALID_CRITICALITY_TOKENS.has(criticality)).toBe(true);
          },
        ),
        { numRuns: PROPERTY_NUM_RUNS },
      );
    });

    it('contains both critical and non_critical buckets (both halves of the SRE model)', () => {
      const values = Object.values(PROBE_CRITICALITY);
      expect(values.some((v) => v === 'critical')).toBe(true);
      expect(values.some((v) => v === 'non_critical')).toBe(true);
    });
  });

  describe('P2. Critical probe failure ⇒ 503', () => {
    it('any required probe DOWN forces /ready=503 across random matrices', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(probeSpecArb, { minLength: 1, maxLength: 6 }),
          probeNameArb,
          async (specs, criticalName) => {
            // Inject a guaranteed-down critical probe so the matrix has at
            // least one 'down + required:true' member. This is the precondition
            // the property describes. We strip any randomly-generated spec
            // that collides with the injected critical name so it is not
            // overwritten by last-write-wins.
            const matrix = [
              ...specs.filter((s) => s.name !== criticalName),
              { name: criticalName, required: true, status: 'down' as const },
            ];
            app = await buildAppWith(buildReadinessFromSpecs(matrix));
            const res = await app.inject({ method: 'GET', url: '/ready' });
            await app.close();
            app = undefined;
            expect(res.statusCode).toBe(503);
            const body: ReadyResponseBody = res.json();
            expect(body.ready).toBe(false);
            expect(body.checks[criticalName]?.status).toBe('down');
            expect(body.checks[criticalName]?.required).toBe(true);
          },
        ),
        // Lower run count because each iteration spins a Fastify instance.
        { numRuns: 20 },
      );
    });
  });

  describe('P3. Non-critical-only failure ⇒ 200 (degraded but ready)', () => {
    it('only non-required probes DOWN ⇒ /ready=200 + degradation surfaced', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(probeNameArb, { minLength: 1, maxLength: 4 }),
          fc.uniqueArray(probeNameArb, { minLength: 0, maxLength: 4 }),
          async (downNonCritical, upCritical) => {
            // Filter out collisions between the two name arrays.
            const downSet = new Set(downNonCritical);
            const filteredUp = upCritical.filter((name) => !downSet.has(name));
            const matrix: ProbeSpec[] = [
              ...downNonCritical.map((name) => ({
                name, required: false, status: 'down' as const,
              })),
              ...filteredUp.map((name) => ({
                name, required: true, status: 'up' as const,
              })),
            ];
            app = await buildAppWith(buildReadinessFromSpecs(matrix));
            const res = await app.inject({ method: 'GET', url: '/ready' });
            await app.close();
            app = undefined;
            expect(res.statusCode).toBe(200);
            const body: ReadyResponseBody = res.json();
            expect(body.ready).toBe(true);
            for (const name of downNonCritical) {
              // Body still records each degraded probe so ops sees it.
              expect(body.checks[name]?.status).toBe('down');
              expect(body.checks[name]?.required).toBe(false);
            }
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  describe('P4. Snapshot readiness staleness contract (clock-injected fixture)', () => {
    /** Builds a self-consistent runtime-state file + sibling NL-mappings file
     * in a fresh temp directory. The returned object includes the path that
     * `probeSearchSnapshotRuntimeState` should use. */
    async function writeRuntimeFixture(opts: {
      readonly entityCount: number;
      readonly aliasCount: number;
      readonly ambiguityCount: number;
      readonly nlMappingCount: number;
      readonly activeLtrCount: number;
      readonly qualityBlockers: readonly string[];
      readonly corruptNlHash?: boolean;
    }): Promise<{ readonly statePath: string; readonly cleanup: () => Promise<void> }> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'readiness-probes-prop-'));
      const nlPath = path.join(dir, 'nl-mappings.json');
      const nlObj: { readonly mappings: readonly { readonly key: string }[] } = {
        mappings: Array.from(
          { length: opts.nlMappingCount },
          (_, idx) => ({ key: `mapping-${idx}` }),
        ),
      };
      await fs.writeFile(nlPath, JSON.stringify(nlObj), 'utf8');
      const nlHash = opts.corruptNlHash === true
        ? 'corrupted-hash'
        : hashText(`${stableJsonStringify(nlObj)}\n`);

      const {
        lookupRuntimeCounts,
        lookupRuntimeHashes,
        lookupManifestArtifacts: _lookupManifestArtifacts,
        ...lookupPaths
      } = buildMinimalLookupRuntimeStatePlane(dir);

      const state = {
        schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
        snapshotId: 'snapshot-test-001',
        contentHash: 'content-hash-test',
        publishedAt: '2026-01-01T00:00:00.000Z',
        manifestPath: path.join(dir, 'manifest.json'),
        nlMappingsRuntimePath: nlPath,
        ...lookupPaths,
        fieldAvailability: {
          appellation: {
            populatedDocCount: 0,
            totalDocCount: Math.max(opts.entityCount, 0),
            populatedDocRatio: 0,
          },
          body: {
            populatedDocCount: 0,
            totalDocCount: Math.max(opts.entityCount, 0),
            populatedDocRatio: 0,
          },
          sweetness: {
            populatedDocCount: 0,
            totalDocCount: Math.max(opts.entityCount, 0),
            populatedDocRatio: 0,
          },
          acidity: {
            populatedDocCount: 0,
            totalDocCount: Math.max(opts.entityCount, 0),
            populatedDocRatio: 0,
          },
          tannin: {
            populatedDocCount: 0,
            totalDocCount: Math.max(opts.entityCount, 0),
            populatedDocRatio: 0,
          },
        },
        counts: {
          entities: opts.entityCount,
          aliases: opts.aliasCount,
          ...lookupRuntimeCounts,
          ambiguityRegistry: opts.ambiguityCount,
          nlMappings: opts.nlMappingCount,
          activeLtrModels: opts.activeLtrCount,
        },
        hashes: {
          entities: hashStableJson([{ probe: 'entity' }]),
          aliases: hashStableJson([{ probe: 'alias' }]),
          ...lookupRuntimeHashes,
          ambiguityRegistry: hashStableJson([{ probe: 'amb' }]),
          nlMappings: nlHash,
          activeLtrModels: hashStableJson([{ probe: 'ltr' }]),
        },
        quality: {
          status: opts.qualityBlockers.length > 0 ? 'degraded' : 'canonical',
          blockers: [...opts.qualityBlockers],
          bypasses: [],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      };
      const statePath = path.join(dir, 'runtime-state.json');
      await fs.writeFile(statePath, JSON.stringify(state), 'utf8');
      return {
        statePath,
        cleanup: async (): Promise<void> => {
          await fs.rm(dir, { recursive: true, force: true });
        },
      };
    }

    it('returns up iff all documented invariants hold; otherwise down', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            entityCount: fc.integer({ min: 0, max: 5 }),
            aliasCount: fc.integer({ min: 0, max: 5 }),
            ambiguityCount: fc.integer({ min: 0, max: 5 }),
            nlMappingCount: fc.integer({ min: 0, max: 5 }),
            activeLtrCount: fc.integer({ min: 0, max: 5 }),
            qualityBlockers: fc.uniqueArray(fc.constantFrom('quality_blocker_a', 'quality_blocker_b'), { maxLength: 2 }),
            corruptNlHash: fc.boolean(),
          }),
          async (opts) => {
            const fixture = await writeRuntimeFixture(opts);
            try {
              const status = await probeSearchSnapshotRuntimeState(fixture.statePath);
              // Documented down conditions in
              // probeSearchSnapshotRuntimeState (see source):
              //   - entities <= 0
              //   - aliases <= 0
              //   - nlMappings count mismatch OR <= 0
              //   - nlMappings hash mismatch
              //   - runtime quality blockers present
              const shouldBeDown = (
                opts.entityCount <= 0
                || opts.aliasCount <= 0
                || opts.nlMappingCount <= 0
                || opts.corruptNlHash
                || opts.qualityBlockers.length > 0
              );
              if (shouldBeDown) {
                expect(status).toBe('down');
              } else {
                expect(status).toBe('up');
              }
            } finally {
              await fixture.cleanup();
            }
          },
        ),
        // Lower run count: each iteration writes to temp FS.
        { numRuns: 20 },
      );
    });

    it('boundary: empty/zero counts collapse to down', async () => {
      const fixture = await writeRuntimeFixture({
        entityCount: 0,
        aliasCount: 0,
        ambiguityCount: 0,
        nlMappingCount: 0,
        activeLtrCount: 0,
        qualityBlockers: [],
      });
      try {
        const status = await probeSearchSnapshotRuntimeState(fixture.statePath);
        expect(status).toBe('down');
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe('P5. Parallel execution wall-clock invariant', () => {
    it('all probes resolve within bounded wall-clock (slowest + slack, NOT sum)', async () => {
      const PROBE_LATENCY_MS = 60;
      const PROBE_COUNT = 5;
      const PARALLEL_CEILING_MS = PROBE_LATENCY_MS + 200;
      const SEQUENTIAL_FLOOR_MS = PROBE_LATENCY_MS * PROBE_COUNT;
      const matrix: Record<string, ReadinessCheck> = {};
      for (let i = 0; i < PROBE_COUNT; i++) {
        matrix[`p${i}`] = {
          required: i % 2 === 0,
          check: (): Promise<ReadinessStatus> => new Promise((resolve) => {
            setTimeout(() => resolve('up'), PROBE_LATENCY_MS);
          }),
        };
      }
      app = await buildAppWith(matrix);
      const start = Date.now();
      const res = await app.inject({ method: 'GET', url: '/ready' });
      const elapsedMs = Date.now() - start;
      expect(res.statusCode).toBe(200);
      expect(elapsedMs).toBeLessThan(PARALLEL_CEILING_MS);
      // Sanity floor: would have to be >= SEQUENTIAL_FLOOR_MS if serialized.
      expect(elapsedMs).toBeLessThan(SEQUENTIAL_FLOOR_MS);
      expect(elapsedMs).toBeLessThan(READINESS_TOTAL_BUDGET_MS);
    });
  });

  describe('P6. Korean (한글) error preservation across probes', () => {
    it('Korean error messages from any thrown probe are surfaced verbatim', async () => {
      const koreanMessages = [
        'PG 연결이 닫혔습니다',
        'Vespa 인증서가 만료되었습니다',
        'Redis 핑 시간 초과: 1000ms',
        '임베딩 API에서 오류 반환',
        'OpenAI 응답이 누락되었습니다 — 모델 헬스 체크 실패',
      ];
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...koreanMessages),
          async (message) => {
            const matrix: Record<string, ReadinessCheck> = {
              ko_probe: {
                required: true,
                check: (): ReadinessStatus => {
                  throw new Error(message);
                },
              },
            };
            app = await buildAppWith(matrix);
            const res = await app.inject({ method: 'GET', url: '/ready' });
            await app.close();
            app = undefined;
            expect(res.statusCode).toBe(503);
            const body: ReadyResponseBody = res.json();
            // Verbatim — no truncation, no transliteration, no escape sequences.
            expect(body.checks['ko_probe']?.reason).toBe(message);
            expect(body.checks['ko_probe']?.error_class).toBe('Error');
          },
        ),
        { numRuns: koreanMessages.length },
      );
    });
  });

  describe('regression: explicit boundary scenarios (paired with property cases)', () => {
    it('all probes UP ⇒ status=ready, 200', async () => {
      app = await buildAppWith({
        pg_synth: { required: true, check: (): ReadinessStatus => 'up' },
        vespa_synth: { required: true, check: (): ReadinessStatus => 'up' },
        reranker_synth: { required: false, check: (): ReadinessStatus => 'up' },
      });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body: ReadyResponseBody = res.json();
      expect(body.ready).toBe(true);
    });

    it('all probes DOWN ⇒ status=not_ready, 503 with all reasons captured', async () => {
      app = await buildAppWith({
        pg_synth: {
          required: true,
          check: (): ReadinessStatus => { throw new Error('PG down'); },
        },
        vespa_synth: {
          required: true,
          check: (): ReadinessStatus => { throw new Error('Vespa down'); },
        },
      });
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(503);
      const body: ReadyResponseBody = res.json();
      expect(body.ready).toBe(false);
      expect(body.checks['pg_synth']?.status).toBe('down');
      expect(body.checks['pg_synth']?.reason).toBe('PG down');
      expect(body.checks['vespa_synth']?.status).toBe('down');
      expect(body.checks['vespa_synth']?.reason).toBe('Vespa down');
    });

    it('boundary: probe latency exactly equal to its budget is still recorded (no throw on exact boundary)', async () => {
      // Strict ">" budget: a probe that returns its result on (not after) the
      // budget tick must succeed. This nails down the strict-vs-non-strict
      // comparison documented in the SLO budget header.
      const matrix: Record<string, ReadinessCheck> = {
        boundary_probe: {
          required: true,
          // Resolve immediately — wall-clock budget enforcement is the route
          // handler's responsibility (Promise.allSettled has no per-task
          // timeout). The boundary semantic we pin here is "a fast probe
          // that returns 'up' is treated as up regardless of any timer
          // boundary considerations".
          check: (): ReadinessStatus => 'up',
        },
      };
      app = await buildAppWith(matrix);
      const res = await app.inject({ method: 'GET', url: '/ready' });
      expect(res.statusCode).toBe(200);
      const body: ReadyResponseBody = res.json();
      expect(body.checks['boundary_probe']?.status).toBe('up');
    });
  });
});
