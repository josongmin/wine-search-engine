import { describe, expect, it } from 'vitest';
import { CommandRegistry, createDefaultRegistry } from '../command-registry.js';
import type { CliCommand } from '../../../application/cli/command/cli-command.js';
import type { CommandContext } from '../../../application/cli/context/command-context.js';
import type { CommandResult } from '../../../application/cli/context/command-result.js';

function stubCommand(group: string, name: string): CliCommand {
  return {
    group,
    name,
    summary: `${group} ${name}`,
    parseArgs: () => ({}),
    run: (_ctx: CommandContext): Promise<CommandResult> => Promise.resolve({ data: null }),
  };
}

describe('CommandRegistry', () => {
  it('registers and resolves a command by group + name', () => {
    const registry = new CommandRegistry();
    const command = stubCommand('search', 'run');
    registry.register(command);
    expect(registry.resolve('search', 'run')).toBe(command);
  });

  it('returns undefined for an unregistered command', () => {
    const registry = new CommandRegistry();
    expect(registry.resolve('search', 'run')).toBeUndefined();
  });

  it('lists all registered commands', () => {
    const registry = new CommandRegistry();
    registry.register(stubCommand('a', 'one'));
    registry.register(stubCommand('b', 'two'));
    expect(registry.list()).toHaveLength(2);
  });

  it('default registry wires the hidden system ping self-test', () => {
    const registry = createDefaultRegistry();
    const ping = registry.resolve('system', 'ping');
    expect(ping).toBeDefined();
    expect(ping?.hidden).toBe(true);
  });
});
