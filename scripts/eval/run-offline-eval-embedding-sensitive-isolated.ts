#!/usr/bin/env tsx
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn, type ChildProcess } from 'node:child_process';

interface RuntimeSpec {
  readonly name: 'dense_on' | 'dense_off';
  readonly port: number;
  readonly apiUrl: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logPath: string;
}

interface IsolatedArgs {
  readonly denseOnPort?: number;
  readonly denseOffPort?: number;
  readonly startupTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly runnerTimeoutMs: number;
  readonly forwardedRunnerArgs: readonly string[];
}

const DEFAULT_STARTUP_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_RUNNER_TIMEOUT_MS = 8 * 60_000;
const LOG_DIR = '/tmp';
const LOG_TAIL_MAX_CHARS = 8_000;

function parseIntegerFlag(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer; received "${value}"`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): IsolatedArgs {
  let denseOnPort: number | undefined;
  let denseOffPort: number | undefined;
  let startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let runnerTimeoutMs = DEFAULT_RUNNER_TIMEOUT_MS;
  const forwardedRunnerArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dense-on-port') {
      denseOnPort = parseIntegerFlag(argv[++index], '--dense-on-port', denseOnPort);
      continue;
    }
    if (arg === '--dense-off-port') {
      denseOffPort = parseIntegerFlag(argv[++index], '--dense-off-port', denseOffPort);
      continue;
    }
    if (arg === '--startup-timeout-ms') {
      startupTimeoutMs = parseIntegerFlag(argv[++index], '--startup-timeout-ms', startupTimeoutMs);
      continue;
    }
    if (arg === '--poll-interval-ms') {
      pollIntervalMs = parseIntegerFlag(argv[++index], '--poll-interval-ms', pollIntervalMs);
      continue;
    }
    if (arg === '--runner-timeout-ms') {
      runnerTimeoutMs = parseIntegerFlag(argv[++index], '--runner-timeout-ms', runnerTimeoutMs);
      continue;
    }
    forwardedRunnerArgs.push(arg);
  }

  return {
    denseOnPort,
    denseOffPort,
    startupTimeoutMs,
    pollIntervalMs,
    runnerTimeoutMs,
    forwardedRunnerArgs,
  };
}

export function assertEmbeddingIsolatedPorts(args: {
  readonly denseOnPort: number;
  readonly denseOffPort: number;
}): void {
  if (args.denseOnPort === args.denseOffPort) {
    throw new Error(
      `embedding-sensitive isolated runtimes require distinct ports; both resolved to ${args.denseOnPort}`,
    );
  }
}

function buildLogPath(name: RuntimeSpec['name'], port: number): string {
  return path.join(LOG_DIR, `embedding-sensitive-${name}-${port}.log`);
}

export function buildEmbeddingIsolatedRuntimeSpecs(args: {
  readonly denseOnPort: number;
  readonly denseOffPort: number;
}): readonly RuntimeSpec[] {
  assertEmbeddingIsolatedPorts(args);
  return [
    {
      name: 'dense_on',
      port: args.denseOnPort,
      apiUrl: `http://127.0.0.1:${args.denseOnPort}`,
      env: {
        PORT: String(args.denseOnPort),
        KILL_SWITCH_INJECTION_JUDGE: 'true',
        WINE_SEARCH_MULTI_QUERY_ENABLED: 'false',
        SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME: 'false',
      },
      logPath: buildLogPath('dense_on', args.denseOnPort),
    },
    {
      name: 'dense_off',
      port: args.denseOffPort,
      apiUrl: `http://127.0.0.1:${args.denseOffPort}`,
      env: {
        PORT: String(args.denseOffPort),
        KILL_SWITCH_INJECTION_JUDGE: 'true',
        WINE_SEARCH_MULTI_QUERY_ENABLED: 'false',
        KILL_SWITCH_DENSE_RETRIEVAL: 'true',
        SEARCH_SNAPSHOT_REQUIRE_ACTIVE_LTR_FOR_RUNTIME: 'false',
      },
      logPath: buildLogPath('dense_off', args.denseOffPort),
    },
  ];
}

async function reserveEphemeralPort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('failed to resolve ephemeral port for isolated embedding benchmark runtime'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return port;
}

async function assertPortAvailable(port: number): Promise<void> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  }).finally(() => {
    server.close();
  });
}

export async function resolveIsolatedRuntimePorts(args: IsolatedArgs): Promise<{
  readonly denseOnPort: number;
  readonly denseOffPort: number;
}> {
  const denseOnPort = args.denseOnPort ?? await reserveEphemeralPort();
  let denseOffPort = args.denseOffPort;
  if (denseOffPort === undefined) {
    do {
      denseOffPort = await reserveEphemeralPort();
    } while (denseOffPort === denseOnPort);
  }
  assertEmbeddingIsolatedPorts({ denseOnPort, denseOffPort });
  await Promise.all([
    assertPortAvailable(denseOnPort),
    assertPortAvailable(denseOffPort),
  ]);
  return { denseOnPort, denseOffPort };
}

export function buildIsolatedEmbeddingRunnerArgs(args: {
  readonly forwardedRunnerArgs: readonly string[];
  readonly denseOnApiUrl: string;
  readonly denseOffApiUrl: string;
}): readonly string[] {
  const runnerArgs = [
    path.resolve(process.cwd(), 'scripts/eval/run-offline-eval-embedding-sensitive.ts'),
    '--compare-dense-off',
    '--api-url',
    args.denseOnApiUrl,
    '--dense-off-api-url',
    args.denseOffApiUrl,
    ...args.forwardedRunnerArgs,
  ];
  return runnerArgs;
}

function appendTail(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= LOG_TAIL_MAX_CHARS
    ? combined
    : combined.slice(combined.length - LOG_TAIL_MAX_CHARS);
}

interface SpawnedRuntime {
  readonly spec: RuntimeSpec;
  readonly child: ChildProcess;
  get tail(): string;
}

interface ReadyFailureState {
  port: number;
  reason: string;
}

function sleepMs(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    timer.unref?.();
  });
}

async function stopProcessWithTimeout(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }
  const pid = child.pid;
  if (pid === undefined) {
    return false;
  }
  try {
    if (process.platform === 'win32') {
      child.kill(signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    return false;
  }
  return await Promise.race<boolean>([
    new Promise<boolean>((resolve) => {
      child.once('exit', () => resolve(true));
      child.once('error', () => resolve(false));
    }),
    sleepMs(timeoutMs).then(() => false),
  ]);
}

function spawnRuntime(spec: RuntimeSpec): SpawnedRuntime {
  const logStream = fs.createWriteStream(spec.logPath, { flags: 'w' });
  let tail = '';
  const child = spawn(
    'pnpm',
    ['exec', 'tsx', '--env-file=.env', '--env-file=.env.local', 'src/main.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...spec.env,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    tail = appendTail(tail, text);
    logStream.write(text);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('close', () => {
    logStream.end();
  });
  return {
    spec,
    child,
    get tail() {
      return tail;
    },
  };
}

async function waitForReady(runtime: SpawnedRuntime, args: {
  readonly startupTimeoutMs: number;
  readonly pollIntervalMs: number;
}): Promise<void> {
  const deadline = Date.now() + args.startupTimeoutMs;
  let lastFailure: ReadyFailureState | undefined;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) {
      throw new Error(
        `isolated runtime ${runtime.spec.name} exited early with code ${runtime.child.exitCode}. ` +
        `log=${runtime.spec.logPath}\n${runtime.tail}`,
      );
    }
    try {
      const response = await fetch(`${runtime.spec.apiUrl}/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const payload = await response.json() as {
          readonly ready?: boolean;
          readonly checks?: Readonly<Record<
            string,
            {
              readonly status?: string;
              readonly required?: boolean;
              readonly reason?: string;
              readonly error_class?: string;
            }
          >>;
        };
        if (payload.ready === true) {
          return;
        }
        const requiredDownChecks = Object.entries(payload.checks ?? {})
          .filter(([, check]) => check.required === true && check.status === 'down')
          .map(([name, check]) => {
            const checkReason = check.reason ?? check.error_class;
            return checkReason === undefined ? `${name}:down` : `${name}:${checkReason}`;
          });
        lastFailure = {
          port: runtime.spec.port,
          reason:
            requiredDownChecks.length > 0
              ? requiredDownChecks.slice(0, 3).join('; ')
              : 'ready=false',
        };
        // fall through to retry within startup budget
      } else {
        lastFailure = {
          port: runtime.spec.port,
          reason: `ready-http-${response.status}`,
        };
      }
    } catch {
      // ignore transient startup errors and keep polling within budget
    }
    await sleep(args.pollIntervalMs);
  }

  const failureHint = lastFailure !== undefined ? ` (last_fail=${lastFailure.reason})` : '';
  throw new Error(
    `isolated runtime ${runtime.spec.name} did not reach /ready within ${args.startupTimeoutMs}ms. ` +
    `log=${runtime.spec.logPath}${failureHint}\n${runtime.tail}`,
  );
}

async function stopRuntime(runtime: SpawnedRuntime): Promise<void> {
  if (runtime.child.exitCode !== null) {
    return;
  }
  const softExit = await stopProcessWithTimeout(runtime.child, 'SIGTERM', 5_000);
  if (!softExit && runtime.child.exitCode === null) {
    const hardExit = await stopProcessWithTimeout(runtime.child, 'SIGKILL', 2_000);
    if (!hardExit) {
      console.warn(
        `failed to terminate isolated runtime child pid=${runtime.child.pid}; leaving process to OS cleanup`,
      );
    }
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtimePorts = await resolveIsolatedRuntimePorts(args);
  const runtimes = buildEmbeddingIsolatedRuntimeSpecs(runtimePorts).map(spawnRuntime);

  try {
    await Promise.all(runtimes.map((runtime) => waitForReady(runtime, args)));
    const runnerArgs = buildIsolatedEmbeddingRunnerArgs({
      forwardedRunnerArgs: args.forwardedRunnerArgs,
      denseOnApiUrl: runtimes[0]!.spec.apiUrl,
      denseOffApiUrl: runtimes[1]!.spec.apiUrl,
    });
    const child = spawn('pnpm', ['exec', 'tsx', ...runnerArgs], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        // Quality-only lane: isolate ranking/retrieval relevance from
        // backend load. Concurrency >1 in this runner turns Vespa timeout
        // noise into a throughput benchmark instead of an embedding-quality
        // benchmark.
        EVAL_SEARCH_CONCURRENCY: '1',
      },
    });
    const exitCode = await Promise.race<number>([
      new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) => resolve(code ?? 1));
      }),
      sleep(args.runnerTimeoutMs).then(() => {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
        }
        throw new Error(
          `embedding-sensitive isolated eval runner exceeded ${args.runnerTimeoutMs}ms and was terminated`,
        );
      }),
    ]);
    if (exitCode !== 0) {
      throw new Error(`embedding-sensitive isolated eval runner failed with exit code ${exitCode}`);
    }
  } finally {
    await Promise.all(runtimes.map((runtime) => stopRuntime(runtime)));
  }
}

void run();
