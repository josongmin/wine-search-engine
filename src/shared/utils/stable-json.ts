import { createHash } from 'node:crypto';

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, stableNormalize(entryValue)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

export function hashStableJson(value: unknown): string {
  return createHash('sha256')
    .update(stableJsonStringify(value), 'utf8')
    .digest('hex');
}

export function hashText(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
