import { describe, expect, it } from 'vitest';
import { closeTestServer, createTestServer, type TestServer } from './helpers/test-server.js';
import {
  isExecutableSearchReplayFixture,
  isSelfContainedSearchReplayFixture,
  loadSearchReplayFixtures,
  runSearchFixture,
} from '../replay-fixtures/search/run-search-fixture.js';

describe('search replay fixtures — executable HTTP subset', () => {
  const executableFixtures = loadSearchReplayFixtures().filter(({ fixture }) =>
    isExecutableSearchReplayFixture(fixture));
  const runtimeRequiredFixtures = loadSearchReplayFixtures().filter(({ fixture }) =>
    !isSelfContainedSearchReplayFixture(fixture));
  const executableReplayFixtures = executableFixtures.filter(({ fixture }) =>
    fixture.replay_request !== undefined);

  it('keeps runtime-required fixtures out of the self-contained HTTP lane', () => {
    expect(runtimeRequiredFixtures.length).toBeGreaterThan(0);
    expect(executableFixtures.every(({ fixture }) => isSelfContainedSearchReplayFixture(fixture))).toBe(true);
  });

  it('keeps at least one self-contained replay fixture in the executable HTTP lane', () => {
    expect(executableReplayFixtures.length).toBeGreaterThan(0);
    expect(executableReplayFixtures.every(({ fixture }) => fixture.replay_request !== undefined)).toBe(true);
  });

  for (const { file, fixture } of executableFixtures) {
    it(`executes fixture ${file}`, async () => {
      const server: TestServer = await createTestServer();
      try {
        const { response: body, assertionSummary, mode } = await runSearchFixture(fixture, { app: server.app });
        expect(mode).toBe(fixture.request !== undefined ? 'search' : 'replay');
        expect(assertionSummary.endpoint).toBe(
          fixture.request !== undefined ? '/v1/search' : '/v1/search/replay',
        );
        expect(assertionSummary.skipped).toBe(false);
        if ('error_code' in fixture.expected) {
          expect(assertionSummary.errorCode).toBe(fixture.expected.error_code);
          expect(assertionSummary.assertedFields).toEqual(['error.code']);
          expect(assertionSummary.decodedIds).toEqual({});
          return;
        }
        expect(body).toBeDefined();
        expect(body?.meta.execution_mode).toBe(fixture.expected.execution_mode);
        expect(assertionSummary.assertedFields).toEqual([
          'execution_mode',
          'degradation_reasons',
          'authority_trace_ref',
          'runtime_correlation_ref',
          'decision_snapshot.snapshot_id',
        ]);
        expect(assertionSummary.executionMode).toBe(fixture.expected.execution_mode);
        expect(assertionSummary.degradationReasons).toEqual(fixture.expected.degradation_reasons);
        expect(assertionSummary.decodedIds.authorityTraceRef?.ok).toBe(true);
        expect(assertionSummary.decodedIds.snapshotId?.ok).toBe(true);
      } finally {
        await closeTestServer(server);
      }
    });
  }
});
