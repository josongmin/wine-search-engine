import { mkdtemp, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { buildDeclaredHttpRouteContractManifest } from '../http-route-contract-catalog.js';

const execFileAsync = promisify(execFile);

describe('HTTP contract manifest script', () => {
  it('exports the declared route manifest as JSON', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'http-contract-manifest-'));
    const outputPath = path.join(tempDir, 'manifest.json');

    await execFileAsync('npm', ['run', 'contracts:http', '--', outputPath], {
      cwd: '/Users/songmin/wine-search-engine',
    });

    const written = await readFile(outputPath, 'utf8');
    expect(JSON.parse(written)).toEqual(buildDeclaredHttpRouteContractManifest());
  });
});
