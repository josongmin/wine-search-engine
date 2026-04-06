/**
 * Shared JSON parsing for OpenAI-compatible embedding API responses.
 */

interface EmbeddingObject {
  readonly object: string;
  readonly index: number;
  readonly embedding: number[];
}

interface EmbeddingApiResponse {
  readonly object: string;
  readonly data: readonly EmbeddingObject[];
  readonly model: string;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

function isEmbeddingObject(v: unknown): v is EmbeddingObject {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return isNumberArray(obj['embedding']) && typeof obj['index'] === 'number';
}

export function isEmbeddingApiResponse(v: unknown): v is EmbeddingApiResponse {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    Array.isArray(obj['data']) &&
    (obj['data'] as unknown[]).every(isEmbeddingObject)
  );
}

export function embeddingsFromOpenAiResponse(
  data: unknown,
): readonly (readonly number[])[] {
  if (!isEmbeddingApiResponse(data)) {
    throw new Error(
      `Embedding API: unexpected response shape — ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((item) => item.embedding as readonly number[]);
}
