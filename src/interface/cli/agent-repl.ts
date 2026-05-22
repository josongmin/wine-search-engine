/**
 * Wine agent — interactive multi-turn CLI entrypoint.
 *
 * This is the ONLY file in `interface/cli/` allowed to touch the composition
 * root and infrastructure. It mirrors `main.ts`'s bootstrap (config → PG pool →
 * Redis → DI container) but, instead of starting the HTTP server, pulls the
 * already-wired `agentOrchestrator` out of the container and drives it from a
 * readline REPL ({@link runReplLoop}). The orchestrator stays stateless; the
 * REPL session owns multi-turn context.
 *
 * Run:  pnpm run agent:cli [-- --max-steps 7 --verbose]
 * Needs the same env as the server (.env / .env.local): AGENT_ENABLED=true,
 * OPENAI_API_KEY, DATABASE_URL, Vespa creds, etc.
 */
import { loadConfig } from '../../config/env.js';
import { createContainer } from '../../config/container.js';
import {
  createManagedRuntimeHandles,
  type RuntimeHandles,
} from '../../config/runtime-handles.js';
import { expectsRedisAtStartup, isWatchlistEnabled } from '../../config/watchlist.js';
import { createPgPool, shouldUsePgPool } from '../../infrastructure/db/pg-pool.js';
import { connectRedisClient } from '../../infrastructure/db/redis-client.js';
import { RedisWatchlistPublisher } from '../../infrastructure/watchlist/redis-watchlist-publisher.js';
import { RedisWatchlistSubscriber } from '../../infrastructure/watchlist/redis-watchlist-subscriber.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { runReplLoop, type ReplOptions } from './repl-loop.js';
import { color } from './render/colors.js';

interface CliArgs {
  readonly maxSteps?: number;
  readonly verbose: boolean;
  readonly help: boolean;
}

const USAGE = `wine agent CLI

  pnpm run agent:cli [-- <옵션>]

옵션:
  --max-steps <N>   에이전트 최대 tool-call 단계 수 (오케스트레이터 기본값 사용 시 생략)
  --verbose, -v     매 답변 아래 ReAct 단계 추적 표시 (/trace 로도 토글 가능)
  --help, -h        이 도움말`;

function parseArgs(argv: readonly string[]): CliArgs {
  let maxSteps: number | undefined;
  let verbose = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue; // conventional end-of-options marker (pnpm/tsx pass it through)
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--max-steps') {
      const raw = argv[i + 1];
      const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--max-steps 에는 양의 정수가 필요합니다 (받은 값: ${raw ?? '<none>'})`);
      }
      maxSteps = parsed;
      i += 1;
    } else {
      throw new Error(`알 수 없는 옵션: ${arg ?? ''}`);
    }
  }
  return { ...(maxSteps !== undefined ? { maxSteps } : {}), verbose, help };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return;
  }

  const config = loadConfig();

  if (!config.agent.enabled) {
    throw new Error(
      'AGENT_ENABLED 가 꺼져 있습니다. 에이전트 CLI 를 쓰려면 .env.local 에 AGENT_ENABLED=true 와 OPENAI 자격증명을 설정하세요.',
    );
  }

  const pool = shouldUsePgPool(config.pg) ? createPgPool(config.pg) : undefined;
  let redisClient: RuntimeHandles['redisClient'] | null = null;
  if (expectsRedisAtStartup(config)) {
    try {
      redisClient = await connectRedisClient(config.redis);
    } catch (err) {
      if (isWatchlistEnabled(config)) {
        throw new Error(
          `Watchlist delivery requires Redis at startup: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      bootstrapLogger.warn(
        { err },
        '[agent-cli] Redis unavailable during startup; continuing without Redis-backed features',
      );
    }
  }

  const runtimeHandles: RuntimeHandles = {
    ...(pool ? { pool } : {}),
    ...(redisClient ? { redisClient } : {}),
    createWatchlistPublisher: () =>
      new RedisWatchlistPublisher({
        ...(redisClient ? { client: redisClient } : { redisConfig: config.redis }),
      }),
    createWatchlistSubscriber: () => new RedisWatchlistSubscriber(config.redis),
  };
  const managedRuntime = createManagedRuntimeHandles(runtimeHandles);
  const container = await createContainer(config, managedRuntime);

  if (container.agentOrchestrator === undefined) {
    await managedRuntime.close();
    throw new Error(
      'agentOrchestrator 가 생성되지 않았습니다 — OPENAI_API_KEY/OPENAI_API_KEYS 와 chatLlm 와이어링을 확인하세요.',
    );
  }

  const options: ReplOptions = {
    ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
    trace: args.verbose,
  };

  try {
    await runReplLoop({ runner: container.agentOrchestrator, options });
  } finally {
    await managedRuntime.close();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(color.red(`fatal: ${msg}`) + '\n');
  bootstrapLogger.fatal({ err }, 'agent-cli fatal error');
  process.exit(1);
});
