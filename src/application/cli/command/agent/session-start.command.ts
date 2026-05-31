import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import {
  parseAgentSessionStartArgs,
  resolveAgentSessionStartInput,
  type AgentSessionStartArgs,
} from './agent-command-support.js';

export class AgentSessionStartCommand implements CliCommand<AgentSessionStartArgs> {
  readonly path = ['agent', 'session', 'start'] as const;
  readonly summary = 'Create a server-managed agent session.';

  parseArgs(rawArgs: readonly string[]): AgentSessionStartArgs {
    return parseAgentSessionStartArgs(rawArgs);
  }

  async run(ctx: CommandContext, args: AgentSessionStartArgs): Promise<CommandResult> {
    const input = await resolveAgentSessionStartInput(ctx, args);
    return {
      data: await ctx.facades.agent.startSession(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
