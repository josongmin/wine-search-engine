/**
 * Verifies that ANTHROPIC_API_KEY (from .env) wires LLMInjectionJudge at container bootstrap.
 * Does not print secrets.
 *
 * Usage:
 *   npx tsx scripts/verify-anthropic-wiring.ts
 *   npx tsx scripts/verify-anthropic-wiring.ts --live   # one real API call (costs $)
 */

import process from 'node:process';
import { loadConfig } from '../src/config/env.js';
import { buildRuntimeSupportServices } from '../src/config/container-runtime-support.js';

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const config = loadConfig();
  const hasKey = config.anthropic.apiKey !== undefined && config.anthropic.apiKey.length > 0;
  const kill = config.killSwitch.injectionJudge;

  const services = await buildRuntimeSupportServices(config, {});
  const wired = services.injectionJudge !== undefined;

  const lines = [
    '[verify-anthropic-wiring]',
    `  ANTHROPIC_API_KEY set: ${hasKey}`,
    `  ANTHROPIC_INJECTION_MODEL: ${config.anthropic.injectionModel}`,
    `  KILL_SWITCH_INJECTION_JUDGE: ${kill}`,
    `  LLMInjectionJudge wired: ${wired}`,
  ];

  if (hasKey && !kill && !wired) {
    lines.push('  ERROR: Key present and kill switch off, but injection judge missing — check config.');
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  if (wired && services.injectionJudge) {
    lines.push('  OK — Layer 2 LLM injection judge will be used (subject to Redis/cache as configured).');
    if (live) {
      const q = 'Pinot Noir under $40';
      const t0 = Date.now();
      const isInjection = await services.injectionJudge.judge(q);
      lines.push(
        `  --live: judge(safe query) => is_injection=${String(isInjection)} (${Date.now() - t0}ms)`,
      );
    }
  } else if (kill) {
    lines.push('  INFO — Injection judge disabled by kill switch (expected).');
  } else if (!hasKey) {
    lines.push('  INFO — No API key; injection judge not wired (expected).');
  }

  if (live && !wired) {
    lines.push('  --live: skipped (judge not wired)');
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
});
