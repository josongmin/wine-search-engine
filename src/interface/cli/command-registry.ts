import type { CliCommand } from '../../application/cli/command/cli-command.js';
import { PingCommand } from '../../application/cli/command/system/ping.command.js';
import { AuthStatusCommand } from '../../application/cli/command/auth/status.command.js';
import { AuthPathCommand } from '../../application/cli/command/auth/path.command.js';
import { AuthRefreshCommand } from '../../application/cli/command/auth/refresh.command.js';
import { AuthDoctorCommand } from '../../application/cli/command/auth/doctor.command.js';
import { AuthLoginCommand } from '../../application/cli/command/auth/login.command.js';
import { AuthWhoamiCommand } from '../../application/cli/command/auth/whoami.command.js';
import { SearchHybridCommand } from '../../application/cli/command/search/hybrid.command.js';
import { SearchSemanticCommand } from '../../application/cli/command/search/semantic.command.js';
import { SearchLexicalCommand } from '../../application/cli/command/search/lexical.command.js';
import { LookupWineCommand } from '../../application/cli/command/lookup/wine.command.js';
import { AgentRunCommand } from '../../application/cli/command/agent/run.command.js';
import { AgentSessionStartCommand } from '../../application/cli/command/agent/session-start.command.js';
import { AgentSessionTurnCommand } from '../../application/cli/command/agent/session-turn.command.js';

/**
 * Resolves a leaf command from its full token path. Registration is the
 * single wiring point where later tickets attach their commands; the registry
 * itself holds no business logic.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CliCommand>();

  register(command: CliCommand): void {
    this.commands.set(CommandRegistry.key(command.path), command);
  }

  resolve(path: readonly string[]): CliCommand | undefined {
    return this.commands.get(CommandRegistry.key(path));
  }

  list(): readonly CliCommand[] {
    return [...this.commands.values()];
  }

  private static key(path: readonly string[]): string {
    return path.join(' ');
  }
}

/**
 * Builds the registry with all production commands registered.
 */
export function createDefaultRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register(new PingCommand());
  registry.register(new AuthStatusCommand());
  registry.register(new AuthPathCommand());
  registry.register(new AuthRefreshCommand());
  registry.register(new AuthDoctorCommand());
  registry.register(new AuthLoginCommand());
  registry.register(new AuthWhoamiCommand());
  registry.register(new SearchHybridCommand());
  registry.register(new SearchSemanticCommand());
  registry.register(new SearchLexicalCommand());
  registry.register(new LookupWineCommand());
  registry.register(new AgentRunCommand());
  registry.register(new AgentSessionStartCommand());
  registry.register(new AgentSessionTurnCommand());
  return registry;
}
