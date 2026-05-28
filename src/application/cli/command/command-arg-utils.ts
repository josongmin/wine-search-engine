import { resolve } from 'node:path';
import type { CommandContext } from '../context/command-context.js';
import { CliError } from './cli-error.js';

export function expectFlagValue(
  rawArgs: readonly string[],
  index: number,
  flag: string,
): string {
  const value = rawArgs[index + 1];
  if (value === undefined) {
    throw CliError.usage(`Missing value for ${flag}`);
  }
  return value;
}

export function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw CliError.usage(`Invalid ${flag} "${value}" (expected a positive integer)`);
  }
  return parsed;
}

export function parseHeaderAssignment(value: string, flag: string): { name: string; value: string } {
  const index = value.indexOf('=');
  if (index <= 0 || index === value.length - 1) {
    throw CliError.usage(`Invalid ${flag} "${value}" (expected name=value)`);
  }
  return {
    name: value.slice(0, index).trim(),
    value: value.slice(index + 1).trim(),
  };
}

export async function resolveBodySpec(
  ctx: CommandContext,
  bodySpec: string | undefined,
): Promise<string | undefined> {
  if (bodySpec === undefined) {
    return undefined;
  }
  if (!bodySpec.startsWith('@')) {
    return bodySpec;
  }
  const relativePath = bodySpec.slice(1).trim();
  if (relativePath.length === 0) {
    throw CliError.usage('Invalid --body "@": expected @<path>');
  }
  const path = resolve(ctx.cwd, relativePath);
  try {
    return await ctx.readTextFile(path);
  } catch (error) {
    throw CliError.usage(`Failed to read body file ${path}`, { cause: error });
  }
}

export async function resolveJsonOverlay<T extends object>(
  ctx: CommandContext,
  bodySpec: string | undefined,
): Promise<Partial<T>> {
  const text = await resolveBodySpec(ctx, bodySpec);
  if (text === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw CliError.usage('Invalid JSON in --body payload', { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw CliError.usage('--body JSON must be an object');
  }
  return parsed as Partial<T>;
}
