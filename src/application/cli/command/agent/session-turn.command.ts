import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import {
  parseAgentSessionTurnArgs,
  resolveAgentSessionTurnInput,
  type AgentSessionTurnArgs,
} from './agent-command-support.js';

export class AgentSessionTurnCommand implements CliCommand<AgentSessionTurnArgs> {
  readonly path = ['agent', 'session', 'turn'] as const;
  readonly summary = 'Append a turn to a server-managed agent session.';

  parseArgs(rawArgs: readonly string[]): AgentSessionTurnArgs {
    return parseAgentSessionTurnArgs(rawArgs);
  }

  async run(ctx: CommandContext, args: AgentSessionTurnArgs): Promise<CommandResult> {
    const input = await resolveAgentSessionTurnInput(ctx, args);
    return {
      data: await ctx.facades.agent.turnSession(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
