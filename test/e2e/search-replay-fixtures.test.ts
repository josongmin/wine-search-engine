import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import {
  isExecutableSearchReplayFixture,
  isSelfContainedSearchReplayFixture,
  loadSearchReplayFixtures,
  runSearchFixture,
} from '../replay-fixtures/search/run-search-fixture.js';

describe('search replay fixtures — executable HTTP subset', () => {
  const allReplayFixtures = loadSearchReplayFixtures();
  const allReplaySuccessFixtures = allReplayFixtures.filter(({ fixture }) =>
    fixture.replay_request !== undefined && !('error_code' in fixture.expected));
  const executableFixtures = allReplayFixtures.filter(({ fixture }) =>
    isExecutableSearchReplayFixture(fixture));
  const runtimeRequiredFixtures = allReplayFixtures.filter(({ fixture }) =>
    !isSelfContainedSearchReplayFixture(fixture));
  const executableReplayFixtures = executableFixtures.filter(({ fixture }) =>
    fixture.replay_request !== undefined);
  const comparisonFixtures = executableFixtures.filter(({ fixture }) => fixture.response_family === 'comparison');
  const traceGoldenFixtures = executableFixtures.filter(({ fixture }) =>
    fixture.response_family !== 'comparison' && 'golden_trace' in fixture.expected && fixture.expected.golden_trace !== undefined);

  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });

  it('keeps runtime-required fixtures out of the self-contained HTTP lane', () => {
    expect(runtimeRequiredFixtures.length).toBeGreaterThan(0);
    expect(executableFixtures.every(({ fixture }) => isSelfContainedSearchReplayFixture(fixture))).toBe(true);
  });

  it('keeps at least one self-contained replay fixture in the executable HTTP lane', () => {
    expect(executableReplayFixtures.length).toBeGreaterThan(0);
    expect(executableReplayFixtures.every(({ fixture }) => fixture.replay_request !== undefined)).toBe(true);
  });

  it('keeps at least one comparison replay fixture in the executable HTTP lane', () => {
    expect(comparisonFixtures.length).toBeGreaterThan(0);
  });

  it('keeps at least one trace-golden search fixture in the executable replay lane', () => {
    expect(traceGoldenFixtures.length).toBeGreaterThan(0);
  });

  it('keeps at least one successful replay fixture across the full replay suite', () => {
    expect(allReplaySuccessFixtures.length).toBeGreaterThan(0);
  });

  for (const { file, fixture } of executableFixtures) {
    it(`executes fixture ${file}`, async () => {
      const { response: body, assertionSummary, mode } = await runSearchFixture(fixture, { app: server.app });
      expect(mode).toBe(fixture.request !== undefined ? 'search' : 'replay');
      expect(assertionSummary.endpoint).toBe(
        fixture.request !== undefined ? '/v1/search' : '/v1/search/replay',
      );
      expect(assertionSummary.skipped).toBe(false);
      expect(assertionSummary.responseFamily).toBe(fixture.response_family ?? 'search');
      if ('error_code' in fixture.expected) {
        expect(assertionSummary.errorCode).toBe(fixture.expected.error_code);
        expect(assertionSummary.assertedFields).toEqual(['error.code']);
        expect(assertionSummary.decodedIds).toEqual({});
        return;
      }
      expect(body).toBeDefined();
      if (fixture.response_family === 'comparison') {
        expect(assertionSummary.assertedFields).toEqual([
          'comparison_intent',
          'overall_status',
          'authority_trace_ref',
          'runtime_correlation_ref',
          'entity_top_result_ids',
        ]);
        expect(assertionSummary.driftClassification.resultFields).toEqual([
          'comparison_intent',
          'overall_status',
        ]);
        expect(assertionSummary.driftClassification.traceFields).toEqual([
          'authority_trace_ref',
          'runtime_correlation_ref',
        ]);
        expect(assertionSummary.degradationReasons).toBeUndefined();
        expect(assertionSummary.executionMode).toBeUndefined();
        expect(assertionSummary.decodedIds.authorityTraceRef?.ok).toBe(true);
        return;
      }
      const expectedTrace = 'golden_trace' in fixture.expected ? fixture.expected.golden_trace : undefined;
      expect(body?.meta.execution_mode).toBe(fixture.expected.execution_mode);
      expect(assertionSummary.assertedFields).toEqual(expectedTrace !== undefined
        ? [
            'execution_mode',
            'degradation_reasons',
            'authority_trace_ref',
            'runtime_correlation_ref',
            'decision_snapshot.snapshot_id',
            'determinism_fingerprint',
            'execution_trace',
            'resolver_provenance_trace',
          ]
        : [
            'execution_mode',
            'degradation_reasons',
            'authority_trace_ref',
            'runtime_correlation_ref',
            'decision_snapshot.snapshot_id',
            'determinism_fingerprint',
          ]);
      // T-E10-01: drift classification separates result vs trace assertions
      expect(assertionSummary.driftClassification.resultFields).toEqual([
        'execution_mode',
        'degradation_reasons',
      ]);
      expect(assertionSummary.driftClassification.traceFields).toEqual(expectedTrace !== undefined
        ? [
            'authority_trace_ref',
            'runtime_correlation_ref',
            'decision_snapshot.snapshot_id',
            'determinism_fingerprint',
            'execution_trace',
            'resolver_provenance_trace',
          ]
        : [
            'authority_trace_ref',
            'runtime_correlation_ref',
            'decision_snapshot.snapshot_id',
            'determinism_fingerprint',
          ]);
      expect(assertionSummary.executionMode).toBe(fixture.expected.execution_mode);
      expect(assertionSummary.degradationReasons).toEqual(fixture.expected.degradation_reasons);
      expect(assertionSummary.decodedIds.authorityTraceRef?.ok).toBe(true);
      expect(assertionSummary.decodedIds.snapshotId?.ok).toBe(true);
      if (expectedTrace !== undefined) {
        expect(assertionSummary.degradationReasons).toEqual(fixture.expected.degradation_reasons);
      }
    });
  }
});
