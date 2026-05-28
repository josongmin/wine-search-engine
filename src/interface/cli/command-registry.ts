import type { CliCommand } from '../../application/cli/command/cli-command.js';
import { PingCommand } from '../../application/cli/command/system/ping.command.js';
import { AuthStatusCommand } from '../../application/cli/command/auth/status.command.js';
import { AuthPathCommand } from '../../application/cli/command/auth/path.command.js';
import { AuthRefreshCommand } from '../../application/cli/command/auth/refresh.command.js';
import { AuthDoctorCommand } from '../../application/cli/command/auth/doctor.command.js';
import { AuthLoginCommand } from '../../application/cli/command/auth/login.command.js';
import { AuthWhoamiCommand } from '../../application/cli/command/auth/whoami.command.js';
import { SearchRunCommand } from '../../application/cli/command/search/run.command.js';
import { SearchHybridCommand } from '../../application/cli/command/search/hybrid.command.js';
import { EntityResolveCommand } from '../../application/cli/command/entity/resolve.command.js';
import { EntityAutocompleteCommand } from '../../application/cli/command/entity/autocomplete.command.js';
import { WineSearchRunCommand } from '../../application/cli/command/wine-search/run.command.js';
import { ApiCallCommand } from '../../application/cli/command/api/call.command.js';
import { ApiOpenApiCommand } from '../../application/cli/command/api/openapi.command.js';

/**
 * Resolves a leaf command from its `<group> <name>` path. Registration is the
 * single wiring point where later tickets attach their commands; the registry
 * itself holds no business logic.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CliCommand>();

  register(command: CliCommand): void {
    this.commands.set(CommandRegistry.key(command.group, command.name), command);
  }

  resolve(group: string, name: string): CliCommand | undefined {
    return this.commands.get(CommandRegistry.key(group, name));
  }

  list(): readonly CliCommand[] {
    return [...this.commands.values()];
  }

  private static key(group: string, name: string): string {
    return `${group} ${name}`;
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
  registry.register(new SearchRunCommand());
  registry.register(new SearchHybridCommand());
  registry.register(new EntityResolveCommand());
  registry.register(new EntityAutocompleteCommand());
  registry.register(new WineSearchRunCommand());
  registry.register(new ApiCallCommand());
  registry.register(new ApiOpenApiCommand());
  return registry;
}
