import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

describe('replay fixture CI lane parity', () => {
  const workflow = readWorkspaceFile('.github/workflows/replay-fixtures.yml');
  const bootstrapSmoke = readWorkspaceFile('scripts/bootstrap-smoke.sh');
  const wave4Board = readWorkspaceFile('docs/bugbash/apr-6-hardening-wave4.md');
  const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
    readonly scripts: Record<string, string>;
  };

  it('keeps the always-on self-contained replay lane aligned across workflow, scripts, and package scripts', () => {
    expect(packageJson.scripts['test:e2e:replay:fixtures:self-contained']).toBe(
      'vitest run --config config/vitest/e2e.replay.config.ts',
    );
    expect(workflow).toContain('self-contained-replay:');
    expect(workflow).toContain('run: npm run test:e2e:replay:fixtures:self-contained');
    expect(workflow).toContain('Always-on lane: \\`npm run test:e2e:replay:fixtures:self-contained\\`');
    expect(workflow).toContain("Selection rule: fixtures with \\`execution_lane='self_contained'\\`");
    expect(workflow).toContain(
      'Invariant: self-contained fixtures must not declare \\`requires_runtime_capability\\`',
    );
    expect(bootstrapSmoke).toContain('npm run test:e2e:replay:fixtures:self-contained');
    expect(bootstrapSmoke).toContain("execution_lane='self_contained'");
    expect(bootstrapSmoke).toContain('self-contained fixtures must not declare requires_runtime_capability');
    expect(wave4Board).toContain(
      '| Replay fixture executable subset | 완료 | `endpoint` discriminator 기준으로 self-contained `/v1/search` + `/v1/search/replay` fixture 모두 HTTP 실행 가능 |',
    );
  });

  it('keeps the runtime-required in-memory lane executable and aligned across workflow, scripts, and package scripts', () => {
    expect(packageJson.scripts['test:e2e:replay:fixtures:runtime-required']).toBe(
      'vitest run test/e2e/search-replay-runtime-required-fixtures.test.ts --config config/vitest/e2e.replay.config.ts',
    );
    expect(workflow).toContain('runtime-required-replay-inmemory:');
    expect(workflow).toContain('run: npm run test:e2e:replay:fixtures:runtime-required');
    expect(workflow).toContain('Always-on lane: \\`npm run test:e2e:replay:fixtures:runtime-required\\`');
    expect(workflow).toContain(
      "Scope: executes fixtures with \\`execution_lane='runtime_required'\\` and \\`metadata.runtime_mode='inmemory'\\` against capability-aware in-memory runtime wiring",
    );
    expect(workflow).toContain(
      'Invariant: runtime-required fixtures must declare at least one \\`requires_runtime_capability\\` tag',
    );
    expect(bootstrapSmoke).toContain('runtime-required fixtures execute in the dedicated capability-aware lane');
    expect(bootstrapSmoke).toContain('npm run test:e2e:replay:fixtures:runtime-required');
    expect(wave4Board).toContain(
      '| Full replay HTTP/runtime matrix | 완료 | `execution_lane` 기준 self-contained + runtime-required replay fixture를 capability-aware in-memory HTTP lane에서 실행하고 CI에 고정 |',
    );
  });

  it('keeps the full-runtime replay lane aligned across workflow and package scripts without polluting bootstrap smoke', () => {
    expect(packageJson.scripts['test:e2e:replay:fixtures:full-runtime']).toBe(
      'bash scripts/run-vespa-test-lane.sh npx vitest run test/e2e/vespa/search-replay-full-runtime-fixtures.test.ts --config config/vitest/e2e.vespa.config.ts',
    );
    expect(packageJson.scripts['test:e2e:replay:fixtures:full-runtime:debug']).toBe(
      'bash scripts/run-vespa-test-lane.sh npx vitest run test/e2e/vespa/search-replay-full-runtime-fixtures.test.ts --config config/vitest/e2e.vespa.config.ts --reporter=verbose',
    );
    expect(workflow).toContain('runtime-required-replay-full-runtime:');
    expect(workflow).toContain('run: npm run test:e2e:replay:fixtures:full-runtime');
    expect(workflow).toContain('Always-on lane: \\`npm run test:e2e:replay:fixtures:full-runtime\\`');
    expect(workflow).toContain('Scope: executes fixtures with \\`metadata.runtime_mode=\'full_runtime\'\\`');
    expect(workflow).toContain('Docker stack: \\`docker-compose.test.yml\\` via \\`bash scripts/run-vespa-test-lane.sh\\`');
    expect(workflow).toContain('uses: actions/upload-artifact@v4');
    expect(workflow).toContain('REPLAY_FULL_RUNTIME_REPORT_PATH: /tmp/replay-fixtures-artifacts/full-runtime-report.json');
    expect(workflow).toContain('name: replay-full-runtime-report');
    expect(workflow).toContain('Append full-runtime fixture report to summary');
    expect(workflow).toContain('### Full-Runtime Fixture Results');
    expect(bootstrapSmoke).not.toContain('npm run test:e2e:replay:fixtures:full-runtime');
  });
});
