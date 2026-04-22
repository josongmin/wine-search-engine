/**
 * Verifies that OpenAI credentials wire the production agent benchmark security
 * path at container bootstrap.
 * Does not print secrets.
 *
 * Usage:
 *   pnpm exec tsx scripts/verify-openai-injection-wiring.ts
 *   pnpm exec tsx scripts/verify-openai-injection-wiring.ts --live   # one real API call (costs $)
 */

import process from 'node:process';
import { loadConfig } from '../src/config/env.js';
import { buildRuntimeSupportServices } from '../src/config/container-runtime-support.js';
import { AGENT_FIXTURE_ANSWER_QUALITY_DEFAULT_JUDGE_MODEL } from './eval/agent-fixture-judge-config.js';

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const config = loadConfig();
  const keyCount = config.openai.apiKeys.length;
  const kill = config.killSwitch.injectionJudge;
  const provider = config.queryEntrySecurity.injectionProvider;

  const services = await buildRuntimeSupportServices(config, {});
  const wired = services.injectionJudge !== undefined;

  const lines = [
    '[verify-openai-injection-wiring]',
    `  LLM_INJECTION_PROVIDER: ${provider}`,
    `  OPENAI key count: ${keyCount}`,
    `  OPENAI_INJECTION_MODEL: ${config.openai.injectionModel}`,
    `  agent fixture judge default: ${AGENT_FIXTURE_ANSWER_QUALITY_DEFAULT_JUDGE_MODEL}`,
    `  KILL_SWITCH_INJECTION_JUDGE: ${kill}`,
    `  LLMInjectionJudge wired: ${wired}`,
  ];

  if (provider !== 'openai') {
    lines.push('  ERROR: LLM_INJECTION_PROVIDER must be openai for the production agent benchmark lane.');
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  if (keyCount > 0 && !kill && !wired) {
    lines.push('  ERROR: OpenAI key present and kill switch off, but injection judge missing — check config.');
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  if (AGENT_FIXTURE_ANSWER_QUALITY_DEFAULT_JUDGE_MODEL.startsWith('claude-')) {
    lines.push('  ERROR: agent fixture answer-quality judge default must be OpenAI, not Claude/Anthropic.');
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }

  if (wired && services.injectionJudge) {
    lines.push('  OK — OpenAI Layer 2 LLM injection judge will be used (subject to Redis/cache as configured).');
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
  } else if (keyCount === 0) {
    lines.push('  INFO — No OpenAI key; injection judge not wired (expected outside production/agent runs).');
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
