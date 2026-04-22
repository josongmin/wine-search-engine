import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { parseEnv } from '../env.js';

const execFileAsync = promisify(execFile);

/**
 * Tests for env validation invariants. We use parseEnv with an explicit
 * env object to avoid touching process.env or .env files.
 */
describe('parseEnv invariants', () => {
  it('loadConfig keeps explicit process env above .env.local values', async () => {
    const workspaceRoot = process.cwd();
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-env-precedence-'));

    try {
      await writeFile(path.join(dir, '.env.local'), 'PORT=3000\n', 'utf8');
      const envModule = pathToFileURL(path.join(workspaceRoot, 'src/config/env.ts')).href;
      const tsxPreflight = path.join(workspaceRoot, 'node_modules/tsx/dist/preflight.cjs');
      const tsxLoader = pathToFileURL(path.join(workspaceRoot, 'node_modules/tsx/dist/loader.mjs')).href;
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          '--require',
          tsxPreflight,
          '--import',
          tsxLoader,
          '-e',
          `import { loadConfig } from ${JSON.stringify(envModule)}; console.log(loadConfig().port);`,
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            PORT: '4000',
          },
        },
      );

      expect(stdout.trim()).toBe('4000');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('AGENT_ENABLED=true without OPENAI_API_KEY throws actionable error', () => {
    expect(() => parseEnv({ AGENT_ENABLED: 'true' })).toThrowError(
      /AGENT_ENABLED=true requires OPENAI_API_KEY/,
    );
  });

  it('AGENT_ENABLED=true with OPENAI_API_KEY succeeds', () => {
    const config = parseEnv({ AGENT_ENABLED: 'true', OPENAI_API_KEY: 'sk-test' });
    expect(config.agent.enabled).toBe(true);
  });

  it('AGENT_ENABLED=true with OPENAI_API_KEYS succeeds', () => {
    const config = parseEnv({ AGENT_ENABLED: 'true', OPENAI_API_KEYS: 'sk-a,sk-b' });
    expect(config.agent.enabled).toBe(true);
    expect(config.openai.apiKey).toBe('sk-a');
    expect(config.openai.apiKeys).toEqual(['sk-a', 'sk-b']);
  });

  it('deduplicates OPENAI_API_KEY and OPENAI_API_KEYS in stable order', () => {
    const config = parseEnv({
      OPENAI_API_KEY: 'sk-a',
      OPENAI_API_KEYS: 'sk-a,\nsk-b, sk-b ',
    });
    expect(config.openai.apiKey).toBe('sk-a');
    expect(config.openai.apiKeys).toEqual(['sk-a', 'sk-b']);
  });

  it('AGENT_ENABLED unset → no validation error even without OPENAI_API_KEY', () => {
    const config = parseEnv({});
    expect(config.agent.enabled).toBe(false);
  });

  it('LLM_QUERY_INTERPRETER=true without OPENAI_API_KEY throws actionable error', () => {
    expect(() => parseEnv({ LLM_QUERY_INTERPRETER: 'true' })).toThrowError(
      /LLM_QUERY_INTERPRETER=true requires OPENAI_API_KEY/,
    );
  });

  it('LLM_QUERY_INTERPRETER=true with OPENAI_API_KEY succeeds', () => {
    const config = parseEnv({ LLM_QUERY_INTERPRETER: 'true', OPENAI_API_KEY: 'sk-test' });
    expect(config.openai.llmQueryInterpreter).toBe(true);
  });

  it('LLM_QUERY_INTERPRETER=true with OPENAI_API_KEYS succeeds', () => {
    const config = parseEnv({ LLM_QUERY_INTERPRETER: 'true', OPENAI_API_KEYS: 'sk-a\nsk-b' });
    expect(config.openai.llmQueryInterpreter).toBe(true);
    expect(config.openai.apiKeys).toEqual(['sk-a', 'sk-b']);
  });

  it('WATCHLIST_ENABLED=true without WEBHOOK_SECRET throws', () => {
    expect(() => parseEnv({ WATCHLIST_ENABLED: 'true' })).toThrowError(
      /WATCHLIST_ENABLED requires WEBHOOK_SECRET/,
    );
  });

  it('production without OPENAI_API_KEY throws by default (Layer 2 security invariant)', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', PG_PASSWORD: 'secret' })).toThrowError(
      /requires an openai API key \(Layer 2/,
    );
  });

  it('production with explicit OpenAI injection provider requires OPENAI_API_KEY', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        PG_PASSWORD: 'secret',
        LLM_INJECTION_PROVIDER: 'openai',
      }),
    ).toThrowError(
      /requires an openai API key \(Layer 2/,
    );
  });

  it('production without OPENAI_API_KEY but with KILL_SWITCH_INJECTION_JUDGE=true succeeds', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });
    expect(config.killSwitch.injectionJudge).toBe(true);
  });

  it('production with OPENAI_API_KEY succeeds by default', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(config.queryEntrySecurity.injectionProvider).toBe('openai');
    expect(config.openai.apiKey).toBe('sk-test');
  });

  it('production with explicit Anthropic injection provider and ANTHROPIC_API_KEY succeeds', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      LLM_INJECTION_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    expect(config.queryEntrySecurity.injectionProvider).toBe('anthropic');
    expect(config.anthropic.apiKey).toBe('sk-ant-test');
  });

  it('production with OpenAI injection provider and OPENAI_API_KEY succeeds', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      LLM_INJECTION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_CHAT_MODEL: 'gpt-5.4-mini',
    });
    expect(config.queryEntrySecurity.injectionProvider).toBe('openai');
    expect(config.openai.injectionModel).toBe('gpt-5.4-mini');
  });

  it('production with OpenAI injection provider and OPENAI_API_KEYS succeeds', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      LLM_INJECTION_PROVIDER: 'openai',
      OPENAI_API_KEYS: 'sk-a,sk-b',
      OPENAI_CHAT_MODEL: 'gpt-5.4-mini',
    });
    expect(config.queryEntrySecurity.injectionProvider).toBe('openai');
    expect(config.openai.apiKey).toBe('sk-a');
    expect(config.openai.apiKeys).toEqual(['sk-a', 'sk-b']);
  });

  it('non-production without OpenAI injection key does NOT throw', () => {
    expect(() => parseEnv({ NODE_ENV: 'test' })).not.toThrow();
    expect(() => parseEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  // CLAUDE.md Rule 22: AGENT_PER_STEP_TIMEOUT_MS must not exceed AGENT_TIMEOUT_MS
  it('AGENT_PER_STEP_TIMEOUT_MS > AGENT_TIMEOUT_MS throws (Rule 22 mutual consistency)', () => {
    expect(() =>
      parseEnv({ AGENT_TIMEOUT_MS: '5000', AGENT_PER_STEP_TIMEOUT_MS: '10000' }),
    ).toThrowError(/AGENT_PER_STEP_TIMEOUT_MS.*must not exceed AGENT_TIMEOUT_MS/);
  });

  it('AGENT_PER_STEP_TIMEOUT_MS === AGENT_TIMEOUT_MS is allowed (boundary)', () => {
    const config = parseEnv({ AGENT_TIMEOUT_MS: '10000', AGENT_PER_STEP_TIMEOUT_MS: '10000' });
    expect(config.agent.perStepTimeoutMs).toBe(10000);
    expect(config.agent.agentTimeoutMs).toBe(10000);
  });

  it('AGENT_PER_STEP_TIMEOUT_MS < AGENT_TIMEOUT_MS is allowed (normal case)', () => {
    const config = parseEnv({ AGENT_TIMEOUT_MS: '30000', AGENT_PER_STEP_TIMEOUT_MS: '10000' });
    expect(config.agent.perStepTimeoutMs).toBe(10000);
    expect(config.agent.agentTimeoutMs).toBe(30000);
  });

  it('uses DATABASE_URL as pg connection source when provided', () => {
    const config = parseEnv({
      DATABASE_URL: 'postgresql://postgres:secret@example.com:5432/postgres',
    });
    expect(config.pg.connectionString).toBe('postgresql://postgres:secret@example.com:5432/postgres');
  });

  it('parses PG_SSL explicitly', () => {
    const config = parseEnv({
      PG_SSL: 'true',
    });
    expect(config.pg.ssl).toBe(true);
  });
});
