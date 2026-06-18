import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readScript(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

describe('smart lane noisy gate parity', () => {
  const checkSmartSource = readScript('scripts/test/check-smart.mjs');
  const prepushSmartSource = readScript('scripts/test/prepush-smart.mjs');

  it('keeps check-smart wiring HTTP-contract-sensitive changes to verify:http-contracts', () => {
    expect(checkSmartSource).toContain('const httpContractSourcePatterns = [');
    expect(checkSmartSource).toContain('const shouldRunHttpContractVerification = changedFiles.some');
    expect(checkSmartSource).toContain("npmRun('verify:http-contracts')");
    expect(checkSmartSource).toContain('/^src\\/application\\/search\\/entity-lookup-v2\\//');
  });

  it('keeps check-smart wiring noisy-sensitive changes to the noisy verification gate', () => {
    expect(checkSmartSource).toContain('const noisyGatePatterns = [');
    expect(checkSmartSource).toContain("/^scripts\\/test\\/check-smart\\.mjs$/");
    expect(checkSmartSource).toContain("/^scripts\\/test\\/prepush-smart\\.mjs$/");
    expect(checkSmartSource).toContain("/^scripts\\/eval\\/run-noisy-entity-eval\\.ts$/");
    expect(checkSmartSource).toContain("/^test\\/unit\\/eval\\/run-eval-and-train-ltr\\.test\\.ts$/");
    expect(checkSmartSource).toContain(
      'const shouldRunNoisyVerification = changedFiles.some((file) => matches(file, noisyGatePatterns));',
    );

    const noisyGateCalls = checkSmartSource.match(/npmRun\('test:verification:noisy'\);/g) ?? [];
    expect(noisyGateCalls).toHaveLength(3);
  });

  it('keeps check-smart from regressing to check:quick when noisy verification was already the only target', () => {
    expect(checkSmartSource).toContain(
      'No narrow test targets found beyond noisy verification; skipping check:quick fallback.',
    );
    expect(checkSmartSource).toContain('if (shouldRunNoisyVerification) {');
    expect(checkSmartSource).toContain('process.exit(0);');
  });

  it('keeps prepush-smart delegating branch-diff validation through check-smart before extra heavy lanes', () => {
    expect(prepushSmartSource).toContain("npmRun('check:smart', changedFiles);");
    expect(prepushSmartSource).toContain('HTTP-contract-sensitive changes detected; running verify:http-contracts.');
    expect(prepushSmartSource).toContain("npmRun('verify:http-contracts');");
    expect(prepushSmartSource).toContain("const script = files.some((file) => matches(file, heavyPatterns))");
    expect(prepushSmartSource).toContain("? 'git:prepush:heavy'");
    expect(prepushSmartSource).toContain(": 'git:prepush';");
    expect(prepushSmartSource).toContain('No upstream branch detected; choosing safe fallback.');
    expect(prepushSmartSource).toContain('changed files relative to ${upstream}; falling back to full git:prepush.');
  });
});
