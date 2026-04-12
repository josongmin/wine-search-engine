import dotenv from 'dotenv';
import { type z } from 'zod';

import { AgentEnvSchema } from './env-schemas/agent.schema.js';
import { AiEnvSchema } from './env-schemas/ai.schema.js';
import { CoreEnvSchema } from './env-schemas/core.schema.js';
import { DbEnvSchema } from './env-schemas/db.schema.js';
import { FeaturesEnvSchema } from './env-schemas/features.schema.js';
import { HttpEnvSchema } from './env-schemas/http.schema.js';
import { KillSwitchEnvSchema } from './env-schemas/kill-switch.schema.js';
import { RetrievalEnvSchema } from './env-schemas/retrieval.schema.js';
import { VespaEnvSchema } from './env-schemas/vespa.schema.js';

/** sysexits.h EX_CONFIG — invalid configuration at startup. */
const SYSEXITS_EX_CONFIG = 78;
/** Default Anthropic model when ANTHROPIC_INJECTION_MODEL is unset. */
const DEFAULT_ANTHROPIC_INJECTION_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Schema for all environment variables required by the Wine Intelligence Engine.
 * Composed from per-domain subschemas under `./env-schemas/`.
 */
const envSchema = CoreEnvSchema
  .merge(HttpEnvSchema)
  .merge(FeaturesEnvSchema)
  .merge(DbEnvSchema)
  .merge(VespaEnvSchema)
  .merge(RetrievalEnvSchema)
  .merge(AiEnvSchema)
  .merge(AgentEnvSchema)
  .merge(KillSwitchEnvSchema)
  .refine(
    (data) => {
      const hasCert = data.VESPA_CERT_PATH !== undefined;
      const hasKey = data.VESPA_KEY_PATH !== undefined;
      return hasCert === hasKey;
    },
    { message: 'VESPA_CERT_PATH and VESPA_KEY_PATH must both be set or both be unset for mTLS' },
  );

type EnvVars = z.infer<typeof envSchema>;

function buildConfig(parsed: EnvVars) {
  const watchlistEnabled = parsed.WATCHLIST_ENABLED ?? parsed.WEBHOOK_SECRET !== undefined;

  if (watchlistEnabled && parsed.WEBHOOK_SECRET === undefined) {
    throw new Error('WATCHLIST_ENABLED requires WEBHOOK_SECRET to be set');
  }

  if (parsed.AGENT_ENABLED && parsed.OPENAI_API_KEY === undefined) {
    throw new Error(
      'AGENT_ENABLED=true requires OPENAI_API_KEY to be set. ' +
        'Set OPENAI_API_KEY or unset AGENT_ENABLED — silently disabling the agent route (POST /v1/agent/*) is not allowed.',
    );
  }

  if (parsed.LLM_QUERY_INTERPRETER && parsed.OPENAI_API_KEY === undefined) {
    throw new Error(
      'LLM_QUERY_INTERPRETER=true requires OPENAI_API_KEY to be set. ' +
        'Set OPENAI_API_KEY or unset LLM_QUERY_INTERPRETER — silently falling back to the rule-only NLMapper is not allowed.',
    );
  }

  // CLAUDE.md Rule 22: mutually consistent limits.
  // A per-step timeout larger than the total budget means every step would be
  // aborted before it could complete — the agent can never make progress.
  if (parsed.AGENT_PER_STEP_TIMEOUT_MS > parsed.AGENT_TIMEOUT_MS) {
    throw new Error(
      `AGENT_PER_STEP_TIMEOUT_MS (${parsed.AGENT_PER_STEP_TIMEOUT_MS}) must not exceed AGENT_TIMEOUT_MS (${parsed.AGENT_TIMEOUT_MS})`,
    );
  }

  // Production security invariant: Layer 2 prompt-injection defense (LLMInjectionJudge)
  // requires ANTHROPIC_API_KEY. Without the key the judge is silently undefined and
  // every query bypasses Layer 2 — INJECTION_JUDGE_FAIL_OPEN=false has NO effect on
  // judge *absence*, only on judge errors. The only legal opt-out is the explicit
  // KILL_SWITCH_INJECTION_JUDGE.
  if (
    parsed.NODE_ENV === 'production'
    && parsed.ANTHROPIC_API_KEY === undefined
    && !parsed.KILL_SWITCH_INJECTION_JUDGE
  ) {
    throw new Error(
      'Production startup requires ANTHROPIC_API_KEY (Layer 2 prompt-injection defense). ' +
        'To intentionally disable Layer 2, set KILL_SWITCH_INJECTION_JUDGE=true with explicit approval. ' +
        'Silently disabling Layer 2 by omitting the API key is not allowed.',
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,

    /** HTTP rate limiting (Fastify @fastify/rate-limit). */
    httpRateLimit: {
      max: parsed.HTTP_RATE_LIMIT_MAX,
    },

    /** HTTP server tuning (Fastify instance options). */
    http: {
      trustProxy: parsed.HTTP_TRUST_PROXY,
      bodyLimitBytes: parsed.HTTP_BODY_LIMIT_BYTES,
      securityHeaders: parsed.HTTP_SECURITY_HEADERS,
      debugSecret: parsed.HTTP_DEBUG_SECRET,
    },

    /** CORS allowed origins. Empty string means allow all in dev, none in production. */
    corsAllowedOrigins: parsed.CORS_ALLOWED_ORIGINS,

    /** Optional startup evaluation. */
    eval: {
      runAtStartup: parsed.EVAL_RUN_AT_STARTUP,
    },

    /** PostgreSQL connection settings. */
    pg: {
      connectionString: parsed.DATABASE_URL,
      host: parsed.PG_HOST,
      port: parsed.PG_PORT,
      database: parsed.PG_DATABASE,
      user: parsed.PG_USER,
      password: parsed.PG_PASSWORD,
      ssl: parsed.PG_SSL,
      sslRejectUnauthorized: parsed.PG_SSL_REJECT_UNAUTHORIZED,
      poolMax: parsed.PG_POOL_MAX,
      idleTimeoutMillis: parsed.PG_POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: parsed.PG_POOL_CONNECTION_TIMEOUT_MS,
    },

    /** Redis connection settings. */
    redis: {
      url: parsed.REDIS_URL,
    },

    /** Vespa search backend settings. */
    vespa: {
      url: parsed.VESPA_URL,
      certPath: parsed.VESPA_CERT_PATH,
      keyPath: parsed.VESPA_KEY_PATH,
      contentCluster: parsed.VESPA_CONTENT_CLUSTER,
      timeouts: {
        searchRequestMs: parsed.VESPA_SEARCH_REQUEST_TIMEOUT_MS,
        documentMutationMs: parsed.VESPA_DOCUMENT_MUTATION_TIMEOUT_MS,
        documentGetDeleteMs: parsed.VESPA_DOCUMENT_GET_DELETE_TIMEOUT_MS,
      },
    },

    /** Embedding settings (OpenAI API — no separate embedding service). */
    embedding: {
      model: parsed.EMBEDDING_MODEL,
      dimension: parsed.EMBEDDING_DIMENSION,
      httpTimeoutMs: parsed.EMBEDDING_HTTP_TIMEOUT_MS,
    },

    /** Reranker settings (Cohere-backed). */
    reranker: {
      blendScale: parsed.RERANK_BLEND_SCALE,
      httpTimeoutMs: parsed.RERANKER_HTTP_TIMEOUT_MS,
    },

    /** Cohere managed reranker settings (optional). */
    cohere: {
      apiKey: parsed.COHERE_API_KEY,
      rerankModel: parsed.COHERE_RERANK_MODEL,
      baseUrl: parsed.COHERE_BASE_URL,
    },

    /** Learned matcher service settings (optional). */
    learnedMatcher: {
      url: parsed.LEARNED_MATCHER_SERVICE_URL,
      httpTimeoutMs: parsed.LEARNED_MATCHER_HTTP_TIMEOUT_MS,
    },

    /** OpenAI API settings (optional chat + optional embeddings override). */
    openai: {
      apiKey: parsed.OPENAI_API_KEY,
      baseUrl: parsed.OPENAI_BASE_URL,
      chatModel: parsed.OPENAI_CHAT_MODEL,
      doc2queryModel: parsed.OPENAI_DOC2QUERY_MODEL,
      embeddingModel: parsed.OPENAI_EMBEDDING_MODEL,
      httpTimeoutMs: parsed.OPENAI_HTTP_TIMEOUT_MS,
      llmQueryInterpreter: parsed.LLM_QUERY_INTERPRETER,
      llmQueryInterpreterTimeoutMs: parsed.LLM_QUERY_INTERPRETER_TIMEOUT_MS,
    },

    /** Anthropic API settings (optional, for LLM-based security features). */
    anthropic: {
      apiKey: parsed.ANTHROPIC_API_KEY,
      injectionModel:
        parsed.ANTHROPIC_INJECTION_MODEL ?? DEFAULT_ANTHROPIC_INJECTION_MODEL,
    },

    /** Query-entry security behavior (Layer 1 + Layer 2 prompt-injection defense). */
    queryEntrySecurity: {
      judgeFailureMode: parsed.INJECTION_JUDGE_FAIL_OPEN ? 'fail_open' : 'fail_closed',
    },

    /** Watchlist webhook settings (Epic 17.1). */
    watchlist: {
      enabled: watchlistEnabled,
      webhookSecret: parsed.WEBHOOK_SECRET,
    },

    /** Confidence refusal settings (Epic 17.3: Hallucination Verify). */
    confidenceRefusal: {
      threshold: parsed.CONFIDENCE_REFUSAL_THRESHOLD,
    },

    /** Drinking-window runtime policy. */
    drinkingWindow: {
      allowHeuristicInProduction: parsed.ALLOW_HEURISTIC_DRINKING_WINDOW,
      modelDir: parsed.DRINKING_WINDOW_MODEL_DIR,
    },

    /** Agent configuration. */
    agent: {
      enabled: parsed.AGENT_ENABLED,
      maxSteps: parsed.AGENT_MAX_STEPS,
      agentTimeoutMs: parsed.AGENT_TIMEOUT_MS,
      perStepTimeoutMs: parsed.AGENT_PER_STEP_TIMEOUT_MS,
    },

    /**
     * Web / tooling: benchmark scenario catalog (GET /v1/agent/benchmark-scenarios).
     * Production default off unless ENABLE_AGENT_BENCHMARK_UI=true.
     */
    enableAgentBenchmarkUi:
      parsed.ENABLE_AGENT_BENCHMARK_UI === 'true'
        ? true
        : parsed.ENABLE_AGENT_BENCHMARK_UI === 'false'
          ? false
          : parsed.NODE_ENV !== 'production',

    /** Kill switches for feature flags / circuit breakers. */
    killSwitch: {
      aliasOverlay: parsed.KILL_SWITCH_ALIAS_OVERLAY,
      learning: parsed.KILL_SWITCH_LEARNING,
      denseRetrieval: parsed.KILL_SWITCH_DENSE_RETRIEVAL,
      injectionJudge: parsed.KILL_SWITCH_INJECTION_JUDGE,
      queryCache: parsed.KILL_SWITCH_QUERY_CACHE,
    },
  } as const;
}

export type Config = ReturnType<typeof buildConfig>;

export function parseEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return buildConfig(envSchema.parse(env));
}

export function loadConfig(options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly loadDotenv?: boolean;
}): Config {
  if (options?.loadDotenv ?? true) {
    dotenv.config({ path: '.env.local', override: false });
    dotenv.config({ override: false });
  }

  return parseEnv(options?.env ?? process.env);
}

/**
 * Parsed and validated environment variables.
 *
 * Evaluated at module-load time so downstream modules can do
 * `import { config } from './env.js'` without an explicit boot step. The
 * trade-off is that any validation failure (Zod or invariant throw) happens
 * before main()'s try/catch can format it nicely — see the operator-friendly
 * fail-fast block below for the workaround.
 */
export const config: Config = (() => {
  try {
    return loadConfig();
  } catch (err) {
    // Eagerly format the error and exit cleanly. Without this block, the
    // module-load-time throw escapes through `uncaughtException` and the
    // operator sees a raw Pino-formatted Zod stack trace instead of the
    // actionable string crafted in buildConfig().
    //
    // Bypass via `WINE_ENGINE_SKIP_CONFIG_FAIL_FAST=1` for test harnesses
    // that intentionally exercise the throwing path.
    if (process.env.WINE_ENGINE_SKIP_CONFIG_FAIL_FAST === '1') {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\n[wine-search-engine] FATAL: configuration invalid\n  ${message}\n\n`);
    // Exit code 78 = EX_CONFIG (sysexits.h) — the configuration is wrong.
    process.exit(SYSEXITS_EX_CONFIG);
  }
})();
