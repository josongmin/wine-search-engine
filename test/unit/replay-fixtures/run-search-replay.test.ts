import { describe, it, expect } from 'vitest';
import {
  buildSearchFixturePayload,
  classifySearchFixtureMode,
  isExecutableSearchReplayFixture,
  isFullRuntimeSearchReplayFixture,
  isInMemoryRuntimeSearchReplayFixture,
  isSelfContainedSearchReplayFixture,
  loadSearchReplayFixtures,
  requiresRuntimeCapabilitySearchReplayFixture,
} from '../../replay-fixtures/search/run-search-fixture.js';
import {
  decodeAuthorityTraceRefDetailed,
  decodeSnapshotIdDetailed,
} from '../../../src/domain/decision/service/id-schema-decoder.js';

describe('search replay fixtures', () => {
  const fixtures = loadSearchReplayFixtures();

  it('has at least one JSON fixture', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('keeps at least one executable fixture for HTTP harnesses', () => {
    expect(fixtures.some(({ fixture }) => isExecutableSearchReplayFixture(fixture))).toBe(true);
  });

  it('keeps at least one executable canonical search fixture for the self-contained HTTP lane', () => {
    expect(
      fixtures.some(({ fixture }) =>
        isExecutableSearchReplayFixture(fixture)
        && classifySearchFixtureMode(fixture) === 'search'),
    ).toBe(true);
  });

  it('keeps at least one runtime-required fixture for capability-routed lanes', () => {
    expect(fixtures.some(({ fixture }) => requiresRuntimeCapabilitySearchReplayFixture(fixture))).toBe(true);
  });

  for (const { file, fixture } of fixtures) {
    it(`fixture ${file} has v2 fixture contract`, () => {
      expect(typeof fixture.name).toBe('string');
      expect(fixture.endpoint).toBe('/v1/search');
      expect(fixture.request).toBeDefined();
      if ('error_code' in fixture.expected) {
        expect(typeof fixture.expected.error_code).toBe('string');
      } else if (fixture.response_family === 'comparison') {
        expect(fixture.expected.comparison_intent).toBeDefined();
        expect(fixture.expected.overall_status).toBeDefined();
      } else {
        expect(fixture.expected.execution_mode).toBeDefined();
        expect(Array.isArray(fixture.expected.degradation_reasons)).toBe(true);
      }
    });

    it(`fixture ${file} keeps self-contained classification consistent`, () => {
      const capabilityCount = fixture.requires_runtime_capability?.length ?? 0;
      expect(isSelfContainedSearchReplayFixture(fixture)).toBe(capabilityCount === 0);
    });

    it(`fixture ${file} keeps runtime mode classification consistent`, () => {
      if (fixture.execution_lane === 'runtime_required') {
        expect(fixture.metadata?.runtime_mode).toBeDefined();
        expect(
          isInMemoryRuntimeSearchReplayFixture(fixture) || isFullRuntimeSearchReplayFixture(fixture),
        ).toBe(true);
      } else {
        expect(isInMemoryRuntimeSearchReplayFixture(fixture)).toBe(false);
        expect(isFullRuntimeSearchReplayFixture(fixture)).toBe(false);
      }
    });

    it(`fixture ${file} can be routed by helper mode without ad-hoc logic`, () => {
      expect(classifySearchFixtureMode(fixture)).toBe('search');
    });
  }

  it('returns the canonical /v1/search payload without replay-only overlays', () => {
    const payload = buildSearchFixturePayload({
      name: 'search-only',
      endpoint: '/v1/search',
      execution_lane: 'self_contained',
      request: {
        query: 'Opus One 2018',
      },
      expected: {
        execution_mode: 'authoritative',
        degradation_reasons: [],
      },
    });

    expect('query' in payload).toBe(true);
    expect(payload).not.toHaveProperty('decision_snapshot');
  });

  it('returns structured invalid-id results for decoder runtime usage', () => {
    expect(decodeAuthorityTraceRefDetailed('broken')).toEqual({
      ok: false,
      error: {
        kind: 'authority_trace_ref',
        rawValue: 'broken',
        reason: 'invalid_authority_trace_ref',
      },
    });
    expect(decodeSnapshotIdDetailed('broken')).toEqual({
      ok: false,
      error: {
        kind: 'snapshot_id',
        rawValue: 'broken',
        reason: 'invalid_snapshot_id',
      },
    });
  });
});
