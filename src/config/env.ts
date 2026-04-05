import { z } from 'zod';
import 'dotenv/config';

/**
 * Schema for all environment variables required by the Wine Intelligence Engine.
 * Uses Zod for runtime validation and type inference.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // PostgreSQL
  PG_HOST: z.string().min(1).default('localhost'),
  PG_PORT: z.coerce.number().int().positive().default(5432),
  PG_DATABASE: z.string().min(1).default('wine_engine'),
  PG_USER: z.string().min(1).default('wine'),
  PG_PASSWORD: z.string().min(1),

  // Redis
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Vespa
  VESPA_URL: z.string().url().default('http://localhost:8080'),
  VESPA_CONTENT_CLUSTER: z.string().min(1).default('wine_content'),

  // Embedding Service
  EMBEDDING_SERVICE_URL: z.string().url().default('http://localhost:8081'),
  EMBEDDING_MODEL: z.string().min(1).default('bge-m3'),

  // Reranker Service
  RERANKER_SERVICE_URL: z.string().url().default('http://localhost:8082'),

  // Learned Matcher Service (optional — omit to disable RFC-006 §5.2 ML blend)
  LEARNED_MATCHER_SERVICE_URL: z.string().url().optional(),

  // Kill Switches
  KILL_SWITCH_ALIAS_OVERLAY: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  KILL_SWITCH_LEARNING: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
  KILL_SWITCH_DENSE_RETRIEVAL: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
});

type EnvVars = z.infer<typeof envSchema>;

/**
 * Parsed and validated environment variables.
 * Throws a descriptive error at startup if any required variable is missing or malformed.
 */
const parsed: EnvVars = envSchema.parse(process.env);

/**
 * Application configuration object with typed, nested sections.
 */
export const config = {
  nodeEnv: parsed.NODE_ENV,
  port: parsed.PORT,
  logLevel: parsed.LOG_LEVEL,

  /** PostgreSQL connection settings. */
  pg: {
    host: parsed.PG_HOST,
    port: parsed.PG_PORT,
    database: parsed.PG_DATABASE,
    user: parsed.PG_USER,
    password: parsed.PG_PASSWORD,
  },

  /** Redis connection settings. */
  redis: {
    url: parsed.REDIS_URL,
  },

  /** Vespa search backend settings. */
  vespa: {
    url: parsed.VESPA_URL,
    contentCluster: parsed.VESPA_CONTENT_CLUSTER,
  },

  /** Embedding service settings. */
  embedding: {
    url: parsed.EMBEDDING_SERVICE_URL,
    model: parsed.EMBEDDING_MODEL,
  },

  /** Reranker service settings. */
  reranker: {
    url: parsed.RERANKER_SERVICE_URL,
  },

  /** Learned matcher service settings (optional). */
  learnedMatcher: {
    url: parsed.LEARNED_MATCHER_SERVICE_URL,
  },

  /** Kill switches for feature flags / circuit breakers. */
  killSwitch: {
    aliasOverlay: parsed.KILL_SWITCH_ALIAS_OVERLAY,
    learning: parsed.KILL_SWITCH_LEARNING,
    denseRetrieval: parsed.KILL_SWITCH_DENSE_RETRIEVAL,
  },
} as const;

export type Config = typeof config;
