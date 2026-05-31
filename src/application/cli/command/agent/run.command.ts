import type { CliCommand } from '../cli-command.js';
import type { CommandContext } from '../../context/command-context.js';
import type { CommandResult } from '../../context/command-result.js';
import {
  parseAgentRunArgs,
  resolveAgentRunInput,
  type AgentRunArgs,
} from './agent-command-support.js';

export class AgentRunCommand implements CliCommand<AgentRunArgs> {
  readonly path = ['agent', 'run'] as const;
  readonly summary = 'Execute a single-shot agent run against local ports or remote /v1/agent.';

  parseArgs(rawArgs: readonly string[]): AgentRunArgs {
    return parseAgentRunArgs(rawArgs);
  }

  async run(ctx: CommandContext, args: AgentRunArgs): Promise<CommandResult> {
    const input = await resolveAgentRunInput(ctx, args);
    return {
      data: await ctx.facades.agent.run(input, {
        requestId: ctx.requestId,
        abortSignal: ctx.abortSignal,
      }),
    };
  }
}
