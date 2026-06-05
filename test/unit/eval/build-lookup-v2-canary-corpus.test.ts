import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLookupV2CanaryCorpus,
  buildLookupV2CanaryCorpusFromNdjson,
  getValueAtPath,
  parseLookupV2CanaryCorpusBuilderArgs,
} from '../../../scripts/eval/build-lookup-v2-canary-corpus.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lookup-v2-canary-build-'));
}

describe('parseLookupV2CanaryCorpusBuilderArgs', () => {
  it('requires explicit input and query field', () => {
    expect(() => parseLookupV2CanaryCorpusBuilderArgs(['--input', '/tmp/logs.ndjson'])).toThrow(
      /--query-field/,
    );
    expect(() => parseLookupV2CanaryCorpusBuilderArgs(['--query-field', 'payload.query'])).toThrow(
      /--input/,
    );
  });

  it('rejects partial explicit filters', () => {
    expect(() =>
      parseLookupV2CanaryCorpusBuilderArgs([
        '--input', '/tmp/logs.ndjson',
        '--query-field', 'payload.query',
        '--route-field', 'request.route',
      ]),
    ).toThrow(/Route filter requires both/);
  });
});

describe('getValueAtPath', () => {
  it('supports dotted object traversal and numeric array indexes', () => {
    expect(getValueAtPath({ a: { b: [{ c: 'value' }] } }, 'a.b.0.c')).toBe('value');
    expect(getValueAtPath({ a: { b: [{ c: 'value' }] } }, 'a.b.one.c')).toBeUndefined();
  });
});

describe('buildLookupV2CanaryCorpusFromNdjson', () => {
  it('extracts rows only from explicitly matched route and method surfaces', () => {
    const content = [
      JSON.stringify({
        request: {
          route: '/v2/entity-lookup',
          method: 'POST',
          body: { query: '샤또 마고' },
          meta: {
            qid: 'req-1',
            expected_status: 'resolved',
            accepted_statuses: ['resolved'],
            expected_entity_id: 'wine-margaux-2019',
          },
        },
      }),
      JSON.stringify({
        request: {
          route: '/v1/search/hybrid',
          method: 'POST',
          body: { query: 'skip me' },
          meta: { qid: 'req-2' },
        },
      }),
      JSON.stringify({
        request: {
          route: '/v2/entity-lookup',
          method: 'POST',
          body: { query: '오푸스원' },
        },
      }),
    ].join('\n');

    const result = buildLookupV2CanaryCorpusFromNdjson(content, {
      inputPath: '/tmp/input.ndjson',
      outputPath: '/tmp/output.jsonl',
      queryField: 'request.body.query',
      qidField: 'request.meta.qid',
      expectedStatusField: 'request.meta.expected_status',
      acceptedStatusesField: 'request.meta.accepted_statuses',
      expectedEntityIdField: 'request.meta.expected_entity_id',
      routeField: 'request.route',
      routeValue: '/v2/entity-lookup',
      methodField: 'request.method',
      methodValue: 'POST',
    });

    expect(result.scannedRowCount).toBe(3);
    expect(result.matchedRowCount).toBe(2);
    expect(result.selectedRows).toEqual([
      {
        qid: 'req-1',
        query: '샤또 마고',
        expected_status: 'resolved',
        accepted_statuses: ['resolved'],
        expected_entity_id: 'wine-margaux-2019',
      },
      {
        qid: 'row-2',
        query: '오푸스원',
      },
    ]);
  });

  it('fails closed when a selected row is missing the explicit query field', () => {
    const content = JSON.stringify({
      request: {
        route: '/v2/entity-lookup',
        method: 'POST',
        body: {},
      },
    });

    expect(() =>
      buildLookupV2CanaryCorpusFromNdjson(content, {
        inputPath: '/tmp/input.ndjson',
        outputPath: '/tmp/output.jsonl',
        queryField: 'request.body.query',
        routeField: 'request.route',
        routeValue: '/v2/entity-lookup',
        methodField: 'request.method',
        methodValue: 'POST',
      }),
    ).toThrow(/must be a non-empty string/);
  });

  it('fails closed when accepted statuses are malformed', () => {
    const content = JSON.stringify({
      payload: {
        query: '오푸스원',
        accepted_statuses: ['resolved', 'not_a_status'],
      },
    });

    expect(() =>
      buildLookupV2CanaryCorpusFromNdjson(content, {
        inputPath: '/tmp/input.ndjson',
        outputPath: '/tmp/output.jsonl',
        queryField: 'payload.query',
        acceptedStatusesField: 'payload.accepted_statuses',
      }),
    ).toThrow(/invalid lookup status/);
  });
});

describe('buildLookupV2CanaryCorpus', () => {
  it('writes explicit replay rows to JSONL output', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'traffic.ndjson');
    const outputPath = path.join(dir, 'lookup-v2-canary.jsonl');
    await fs.writeFile(
      inputPath,
      [
        JSON.stringify({
          request: {
            route: '/v2/entity-lookup',
            method: 'POST',
            body: { query: '바롤로' },
          },
        }),
        JSON.stringify({
          request: {
            route: '/v2/entity-lookup',
            method: 'POST',
            body: { query: '샤또 오 브리옹' },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await buildLookupV2CanaryCorpus({
      inputPath,
      outputPath,
      queryField: 'request.body.query',
      routeField: 'request.route',
      routeValue: '/v2/entity-lookup',
      methodField: 'request.method',
      methodValue: 'POST',
      limit: 1,
    });

    expect(result.scannedRowCount).toBe(1);
    expect(result.matchedRowCount).toBe(1);
    expect(result.rowCount).toBe(1);
    await expect(fs.readFile(outputPath, 'utf8')).resolves.toContain('"query":"바롤로"');
  });
});
