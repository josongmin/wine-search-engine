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
  }, 15_000);

  it('AGENT_ENABLED=true without OPENAI_API_KEY throws actionable error', () => {
    expect(() => parseEnv({ AGENT_ENABLED: 'true' })).toThrowError(
      /AGENT_ENABLED=true requires OPENAI_API_KEY, OPENAI_API_KEYS, or a Codex ChatGPT login token/,
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

  it('AGENT_ENABLED=true with explicit Codex auth path succeeds', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-env-codex-agent-'));
    const authPath = path.join(dir, 'auth.json');
    try {
      await writeFile(authPath, JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          account_id: 'acct-1',
        },
      }), 'utf8');
      const config = parseEnv({ AGENT_ENABLED: 'true', CODEX_AUTH_JSON_PATH: authPath });
      expect(config.agent.enabled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // T-ELV2-07: operator curation write credential must be a SEPARATE secret from
  // the read/inspect debug key, and obey the same ≥16-char floor.
  it('HTTP_OPS_WRITE_SECRET equal to HTTP_DEBUG_SECRET is rejected at startup', () => {
    const shared = 'shared-secret-32-characters-long!';
    expect(() =>
      parseEnv({ HTTP_DEBUG_SECRET: shared, HTTP_OPS_WRITE_SECRET: shared }),
    ).toThrowError(/HTTP_OPS_WRITE_SECRET must differ from HTTP_DEBUG_SECRET/);
  });

  it('distinct ops-write and debug secrets parse and expose opsWriteSecret', () => {
    const config = parseEnv({
      HTTP_DEBUG_SECRET: 'debug-secret-16+',
      HTTP_OPS_WRITE_SECRET: 'ops-write-secret-distinct',
    });
    expect(config.http.debugSecret).toBe('debug-secret-16+');
    expect(config.http.opsWriteSecret).toBe('ops-write-secret-distinct');
  });

  it('HTTP_OPS_WRITE_SECRET honors the 16-char floor (just inside / just outside)', () => {
    // 16 chars — exactly at the bound — accepted.
    expect(parseEnv({ HTTP_OPS_WRITE_SECRET: 'x'.repeat(16) }).http.opsWriteSecret).toBe(
      'x'.repeat(16),
    );
    // 15 chars — one below — rejected by the schema min().
    expect(() => parseEnv({ HTTP_OPS_WRITE_SECRET: 'x'.repeat(15) })).toThrow();
  });

  it('omitting HTTP_OPS_WRITE_SECRET leaves the write plane locked (undefined)', () => {
    expect(parseEnv({}).http.opsWriteSecret).toBeUndefined();
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

  describe('confidence-refusal threshold (Epic 17.3)', () => {
    it('defaults to AURC-calibrated 0.45 when CONFIDENCE_REFUSAL_THRESHOLD is unset (hallucination guard ON by default)', () => {
      const config = parseEnv({});
      expect(config.confidenceRefusal.threshold).toBe(0.45);
    });

    it('honours an explicit override in [0, 1]', () => {
      const config = parseEnv({ CONFIDENCE_REFUSAL_THRESHOLD: '0.6' });
      expect(config.confidenceRefusal.threshold).toBeCloseTo(0.6);
    });

    it('allows threshold=0 as the effective-disable signal (any positive C admits, NaN still refused downstream)', () => {
      const config = parseEnv({ CONFIDENCE_REFUSAL_THRESHOLD: '0' });
      expect(config.confidenceRefusal.threshold).toBe(0);
    });

    it('rejects out-of-range thresholds (> 1)', () => {
      expect(() => parseEnv({ CONFIDENCE_REFUSAL_THRESHOLD: '1.5' })).toThrow();
    });

    it('rejects negative thresholds', () => {
      expect(() => parseEnv({ CONFIDENCE_REFUSAL_THRESHOLD: '-0.1' })).toThrow();
    });
  });

  it('LLM_QUERY_INTERPRETER=true without OPENAI_API_KEY throws actionable error', () => {
    expect(() => parseEnv({ LLM_QUERY_INTERPRETER: 'true' })).toThrowError(
      /LLM_QUERY_INTERPRETER=true requires OPENAI_API_KEY, OPENAI_API_KEYS, or a Codex ChatGPT login token/,
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

  it('LLM_QUERY_INTERPRETER=true with explicit Codex auth path succeeds', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-env-codex-interpreter-'));
    const authPath = path.join(dir, 'auth.json');
    try {
      await writeFile(authPath, JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          account_id: 'acct-1',
        },
      }), 'utf8');
      const config = parseEnv({ LLM_QUERY_INTERPRETER: 'true', CODEX_AUTH_JSON_PATH: authPath });
      expect(config.openai.llmQueryInterpreter).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores legacy EMBEDDING_MODEL and uses OPENAI_EMBEDDING_MODEL as the only query embedding model authority', () => {
    const config = parseEnv({
      EMBEDDING_MODEL: 'bge-m3',
      OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
    });

    expect(config.openai.embeddingModel).toBe('text-embedding-3-large');
    expect(config.embedding.dimension).toBe(1024);
    expect('model' in config.embedding).toBe(false);
  });

  it('defaults SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME to true', () => {
    const config = parseEnv({});
    expect(config.searchSnapshot.requireActiveLtrForRuntime).toBe(true);
  });

  it('honors SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME=false', () => {
    const config = parseEnv({ SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME: 'false' });
    expect(config.searchSnapshot.requireActiveLtrForRuntime).toBe(false);
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
