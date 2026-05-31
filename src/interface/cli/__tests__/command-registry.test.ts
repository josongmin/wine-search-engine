import { describe, expect, it } from 'vitest';
import { CommandRegistry, createDefaultRegistry } from '../command-registry.js';
import type { CliCommand } from '../../../application/cli/command/cli-command.js';
import type { CommandContext } from '../../../application/cli/context/command-context.js';
import type { CommandResult } from '../../../application/cli/context/command-result.js';

function stubCommand(...path: [string, string, ...string[]]): CliCommand {
  return {
    path,
    summary: path.join(' '),
    parseArgs: () => ({}),
    run: (_ctx: CommandContext): Promise<CommandResult> => Promise.resolve({ data: null }),
  };
}

describe('CommandRegistry', () => {
  it('registers and resolves a command by full path', () => {
    const registry = new CommandRegistry();
    const command = stubCommand('search', 'hybrid');
    registry.register(command);
    expect(registry.resolve(['search', 'hybrid'])).toBe(command);
  });

  it('returns undefined for an unregistered command', () => {
    const registry = new CommandRegistry();
    expect(registry.resolve(['search', 'hybrid'])).toBeUndefined();
  });

  it('lists all registered commands', () => {
    const registry = new CommandRegistry();
    registry.register(stubCommand('a', 'one'));
    registry.register(stubCommand('b', 'two'));
    expect(registry.list()).toHaveLength(2);
  });

  it('default registry wires the hidden system ping self-test', () => {
    const registry = createDefaultRegistry();
    const ping = registry.resolve(['system', 'ping']);
    expect(ping).toBeDefined();
    expect(ping?.hidden).toBe(true);
  });
});
