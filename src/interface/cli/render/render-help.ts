import type { CommandRegistry } from '../command-registry.js';
import type { CliIo } from '../io.js';

/**
 * Wave-1 help text generated from the registry so the command list cannot
 * drift from what is actually registered. T-CLI-05 owns the final help
 * contract (examples, target/profile docs) and its drift gate.
 */
export function renderHelp(registry: CommandRegistry, io: CliIo): void {
  const visible = registry
    .list()
    .filter((command) => command.hidden !== true)
    .sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')));

  const lines: string[] = [
    'wine — wine search engine CLI',
    '',
    'Usage:',
    '  wine <command path...> [options]',
    '',
    'Commands:',
  ];

  if (visible.length === 0) {
    lines.push('  (none registered yet)');
  } else {
    for (const command of visible) {
      lines.push(`  ${command.path.join(' ')}  —  ${command.summary}`);
    }
  }

  lines.push(
    '',
    'Global options:',
    '  --target local|remote   execution target (default: local)',
    '  --profile <name>        named profile',
    '  --base-url <url>        remote base URL',
    '  --auth-mode <mode>      codex|bearer|none',
    '  --bearer-token <token>  remote bearer token (or WINE_CLI_BEARER_TOKEN)',
    '  --json                  shorthand for --output json',
    '  --output <format>       human|json|table|yaml|raw (default: human)',
    '  --request-id <id>       explicit request id',
    '  --timeout-ms <n>        per-request timeout in ms',
    '  --verbose               verbose logging',
    '  --debug                 debug logging',
    '  -h, --help              show this help',
    '',
    'Examples:',
    '  wine auth doctor --json',
    '  wine search hybrid --q "barolo" --target remote --json',
    '  wine lookup wine --q "opus one 2018" --target local --json',
    '  wine agent run --q "스테이크랑 마실 와인 추천해줘" --json',
    '  wine agent session turn --session-id sess_123 --q "비슷한 스타일로 더 추천해줘" --json',
  );

  io.write(`${lines.join('\n')}\n`);
}
