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

/**
 * Describes the structural shape of an API response for diagnostics
 * without leaking actual field values (which may contain API keys, tokens, etc.).
 */
function describeResponseShape(data: unknown): string {
  if (data === null) return 'null';
  if (data === undefined) return 'undefined';
  if (typeof data !== 'object') return `type=${typeof data}`;
  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj).slice(0, 6);
  const dataField = obj['data'];
  if (!Array.isArray(dataField)) {
    return `object{keys=[${keys.join(',')}], data=${dataField === undefined ? 'missing' : typeof dataField}}`;
  }
  const first: unknown = dataField[0];
  const hasEmbedding = first !== null && typeof first === 'object' &&
    'embedding' in (first as Record<string, unknown>);
  return `object{data.length=${dataField.length}, first_has_embedding=${hasEmbedding}}`;
}

export function embeddingsFromOpenAiResponse(
  data: unknown,
): readonly (readonly number[])[] {
  if (!isEmbeddingApiResponse(data)) {
    throw new Error(
      `Embedding API: unexpected response shape — ${describeResponseShape(data)}`,
    );
  }
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  return sorted.map((item) => item.embedding as readonly number[]);
}
