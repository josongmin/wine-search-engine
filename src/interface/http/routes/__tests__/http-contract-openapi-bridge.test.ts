import { mkdtemp, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildHttpRouteContractOpenApiBridge } from '../http-route-contract-openapi.js';
import { CAN_RUN_TSX_SUBPROCESS } from '../../../../../test/helpers/runtime-capabilities.js';

const execFileAsync = promisify(execFile);

describe.skipIf(!CAN_RUN_TSX_SUBPROCESS)('HTTP contract OpenAPI bridge', () => {
  it('builds an OpenAPI-lite document from the declared route catalog', () => {
    const document = buildHttpRouteContractOpenApiBridge();

    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/v1/search']?.post).toEqual(expect.objectContaining({
      operationId: 'search.execute',
      tags: ['search'],
      'x-search-capabilities': [
        'security',
        'decomposition',
        'planner',
        'SAT',
        'cache',
        'route_resolution',
        'ranked_post_route',
      ],
      'x-contract-has-body': true,
      'x-contract-has-params': false,
      'x-contract-success-status-codes': [200],
      'x-contract-error-status-codes': [400, 403, 408, 429, 500, 503],
    }));
    expect(document.paths['/v1/search']?.post?.requestBody?.content['application/json'].schema).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          query: expect.objectContaining({
            type: 'string',
          }),
          options: expect.objectContaining({
            type: 'object',
          }),
        }),
      }),
    );
    expect(document.paths['/v1/watchlist/{id}']?.get).toEqual(expect.objectContaining({
      operationId: 'watchlist.get',
      'x-contract-has-body': false,
      'x-contract-has-params': true,
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'x-authenticated-subject',
          in: 'header',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
      ],
    }));
    expect(document.paths['/v1/watchlist']?.get).toEqual(expect.objectContaining({
      operationId: 'watchlist.list',
      parameters: [
        {
          name: 'x-authenticated-subject',
          in: 'header',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
      ],
    }));
    expect(document.paths['/v1/search/hybrid']?.post).toEqual(expect.objectContaining({
      operationId: 'search.hybrid',
      'x-search-capabilities': [
        'security',
        'decomposition',
        'planner',
        'SAT',
        'cache',
        'forced_hybrid_retrieval',
        'ranked_post_route',
      ],
    }));
    expect(document.paths['/v1/search/interpret']?.post).toEqual(expect.objectContaining({
      operationId: 'search.interpret',
      'x-search-capabilities': ['security', 'planner_only'],
    }));
    expect(document.paths['/v1/entity/resolve']?.post).toEqual(expect.objectContaining({
      operationId: 'entity.resolve',
      'x-search-capabilities': ['security', 'planner', 'SAT', 'resolver_only'],
    }));
    expect(document.paths['/v1/entity/autocomplete']?.post).toEqual(expect.objectContaining({
      operationId: 'entity.autocomplete',
      'x-search-capabilities': ['security', 'planner', 'SAT', 'resolver_only'],
    }));
    expect(document.paths['/v1/watchlist']?.post?.responses['201']).toEqual(expect.objectContaining({
      content: {
        'application/json': {
          schema: expect.objectContaining({
            type: 'object',
          }),
        },
      },
    }));
    expect(document.paths['/v1/batch-search']?.post).toEqual(expect.objectContaining({
      operationId: 'search.batch',
      'x-contract-has-body': true,
      'x-contract-has-params': false,
      'x-contract-success-status-codes': [200],
      'x-contract-error-status-codes': [400, 429, 500, 503],
    }));
    expect(document.paths['/v1/batch-search']?.post?.responses['200']).toEqual(expect.objectContaining({
      content: {
        'application/json': {
          schema: expect.objectContaining({
            type: 'object',
            properties: expect.objectContaining({
              batch_status: expect.objectContaining({
                type: 'string',
                enum: ['succeeded', 'partial_failure', 'failed'],
              }),
              has_failures: expect.objectContaining({
                type: 'boolean',
              }),
            }),
          }),
        },
      },
    }));
  });

  it(
    'exports the OpenAPI-lite document as JSON',
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'http-contract-openapi-'));
      const outputPath = path.join(tempDir, 'openapi-bridge.json');

      await execFileAsync('npm', ['run', 'contracts:http:openapi-bridge', '--', outputPath], {
        cwd: process.cwd(),
      });

      const written = await readFile(outputPath, 'utf8');
      expect(JSON.parse(written)).toEqual(buildHttpRouteContractOpenApiBridge());
    },
    60_000,
  );
});
