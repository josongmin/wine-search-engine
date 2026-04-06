import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MAX_QUERY_LENGTH } from '../../../../src/domain/shared/constants.js';
import { buildHttpRouteContractOpenApiBridge } from '../../../../src/interface/http/routes/http-route-contract-openapi.js';
import { CAN_RUN_TSX_SUBPROCESS } from '../../../helpers/runtime-capabilities.js';

const execFileAsync = promisify(execFile);

describe.skipIf(!CAN_RUN_TSX_SUBPROCESS)('HTTP contract OpenAPI bridge', () => {
  it('builds an OpenAPI-lite document from the declared route catalog', () => {
    const document = buildHttpRouteContractOpenApiBridge();

    expect(document.openapi).toBe('3.1.0');
    expect(document.paths['/v1/search']?.post).toEqual(expect.objectContaining({
      operationId: 'search.execute',
      tags: ['search'],
      'x-contract-has-body': true,
      'x-contract-has-params': false,
      'x-contract-success-status-codes': [200],
      'x-contract-error-status-codes': [400, 403, 429, 500],
    }));
    expect(document.paths['/v1/search']?.post?.requestBody?.content['application/json'].schema).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          query: expect.objectContaining({
            type: 'string',
            maxLength: MAX_QUERY_LENGTH,
          }),
        }),
      }),
    );
    expect(document.paths['/v1/watchlist/{id}']?.get).toEqual(expect.objectContaining({
      operationId: 'watchlist.get',
      'x-contract-has-body': false,
      'x-contract-has-params': true,
      parameters: expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          in: 'path',
          required: true,
          schema: expect.objectContaining({ type: 'string', format: 'uuid' }),
        }),
        expect.objectContaining({
          name: 'x-authenticated-subject',
          in: 'header',
          required: true,
        }),
      ]),
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
  });

  it('exports the OpenAPI-lite document as JSON', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'http-contract-openapi-'));
    const outputPath = path.join(tempDir, 'openapi-bridge.json');

    await execFileAsync('npm', ['run', 'contracts:http:openapi-bridge', '--', outputPath], {
      cwd: '/Users/songmin/wine-search-engine',
    });

    const written = await readFile(outputPath, 'utf8');
    expect(JSON.parse(written)).toEqual(buildHttpRouteContractOpenApiBridge());
  });
});
