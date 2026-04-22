import { describe, it, expect } from 'vitest';
import { parseEnv } from '../env.js';

/**
 * Tests for env validation invariants. We use parseEnv with an explicit
 * env object to avoid touching process.env or .env files.
 */
describe('parseEnv invariants', () => {
  it('AGENT_ENABLED=true without OPENAI_API_KEY throws actionable error', () => {
    expect(() => parseEnv({ AGENT_ENABLED: 'true' })).toThrowError(
      /AGENT_ENABLED=true requires OPENAI_API_KEY/,
    );
  });

  it('AGENT_ENABLED=true with OPENAI_API_KEY succeeds', () => {
    const config = parseEnv({ AGENT_ENABLED: 'true', OPENAI_API_KEY: 'sk-test' });
    expect(config.agent.enabled).toBe(true);
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

  it('WATCHLIST_ENABLED=true without WEBHOOK_SECRET throws', () => {
    expect(() => parseEnv({ WATCHLIST_ENABLED: 'true' })).toThrowError(
      /WATCHLIST_ENABLED requires WEBHOOK_SECRET/,
    );
  });

  it('production without ANTHROPIC_API_KEY throws (Layer 2 security invariant)', () => {
    expect(() => parseEnv({ NODE_ENV: 'production', PG_PASSWORD: 'secret' })).toThrowError(
      /requires a anthropic API key \(Layer 2/,
    );
  });

  it('production with OpenAI injection provider requires OPENAI_API_KEY', () => {
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        PG_PASSWORD: 'secret',
        LLM_INJECTION_PROVIDER: 'openai',
      }),
    ).toThrowError(
      /requires a openai API key \(Layer 2/,
    );
  });

  it('production without ANTHROPIC_API_KEY but with KILL_SWITCH_INJECTION_JUDGE=true succeeds', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      KILL_SWITCH_INJECTION_JUDGE: 'true',
    });
    expect(config.killSwitch.injectionJudge).toBe(true);
  });

  it('production with ANTHROPIC_API_KEY succeeds', () => {
    const config = parseEnv({
      NODE_ENV: 'production',
      PG_PASSWORD: 'secret',
      ANTHROPIC_API_KEY: 'sk-ant-test',
    });
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

  it('non-production without ANTHROPIC_API_KEY does NOT throw', () => {
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
