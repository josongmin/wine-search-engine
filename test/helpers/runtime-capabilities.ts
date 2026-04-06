import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function envOverride(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  return undefined;
}

async function probeLoopbackHttp(): Promise<boolean> {
  const override = envOverride('VITEST_ENABLE_LOOPBACK_HTTP');
  if (override !== undefined) {
    return override;
  }

  return await new Promise<boolean>((resolve) => {
    const server = createServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });

    const done = (value: boolean): void => {
      server.removeAllListeners();
      resolve(value);
    };

    server.once('error', () => done(false));
    server.listen(0, '127.0.0.1', () => {
      server.close((error) => done(error === undefined));
    });
  });
}

async function probeTsxSubprocess(): Promise<boolean> {
  const override = envOverride('VITEST_ENABLE_TSX_SUBPROCESS');
  if (override !== undefined) {
    return override;
  }

  try {
    const tsxCliPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../node_modules/tsx/dist/cli.mjs',
    );
    await execFileAsync(process.execPath, [tsxCliPath, '--version'], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    });
    return true;
  } catch {
    return false;
  }
}

export const CAN_BIND_LOOPBACK_HTTP = await probeLoopbackHttp();
export const CAN_RUN_TSX_SUBPROCESS = await probeTsxSubprocess();
