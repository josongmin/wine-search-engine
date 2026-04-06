import type { Config } from './env.js';

export type KillSwitchEffect =
  | 'boot_fail'
  | 'request_fail'
  | 'degraded_only'
  | 'advisory_only';

export interface KillSwitchPolicyRow {
  key: string;
  effect: KillSwitchEffect;
  reason: string;
}

/**
 * Declarative policy for kill switches and related env flags.
 * When wiring changes, update this table and versioned audit docs.
 */
export const KILL_SWITCH_POLICY: readonly KillSwitchPolicyRow[] = [
  {
    key: 'KILL_SWITCH_LEARNING',
    effect: 'degraded_only',
    reason: 'learned ranking/matching disabled',
  },
  {
    key: 'KILL_SWITCH_INJECTION_JUDGE',
    effect: 'request_fail',
    reason: 'security path disabled when injection judge is unavailable',
  },
  {
    key: 'ALLOW_HEURISTIC_DRINKING_WINDOW',
    effect: 'degraded_only',
    reason: 'drinking window may fall back to heuristic only',
  },
];

function resolveRowActive(row: KillSwitchPolicyRow, config: Config): boolean | undefined {
  switch (row.key) {
    case 'KILL_SWITCH_LEARNING':
      return config.killSwitch.learning;
    case 'KILL_SWITCH_INJECTION_JUDGE':
      return config.killSwitch.injectionJudge;
    case 'ALLOW_HEURISTIC_DRINKING_WINDOW':
      return config.drinkingWindow.allowHeuristicInProduction;
    default:
      return undefined;
  }
}

/**
 * Logs each kill-switch row with its configured value and declared effect (startup SSOT).
 */
export function logKillSwitchPolicyAtStartup(config: Config, log: { info: (o: object) => void }): void {
  for (const row of KILL_SWITCH_POLICY) {
    const active = resolveRowActive(row, config);
    log.info({
      kill_switch_key: row.key,
      effect: row.effect,
      policy_reason: row.reason,
      active,
    });
  }
}
