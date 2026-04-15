/**
 * Shared JSON parsing for OpenAI-compatible embedding API responses.
 */

/** Keys listed when describing response shape for logs (avoid huge key lists). */
const OPENAI_JSON_DIAGNOSTIC_KEY_PREVIEW_COUNT = 6;

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
  // Number.isFinite required: NaN and Infinity pass `typeof x === 'number'` but
  // cause invalid tensor values in Vespa if they reach the embedding payload.
  return Array.isArray(v) && v.every((x) => Number.isFinite(x));
}

function isEmbeddingObject(v: unknown): v is EmbeddingObject {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return isNumberArray(obj['embedding']) && typeof obj['index'] === 'number';
}

function isEmbeddingApiResponse(v: unknown): v is EmbeddingApiResponse {
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
  const keys = Object.keys(obj).slice(0, OPENAI_JSON_DIAGNOSTIC_KEY_PREVIEW_COUNT);
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
  expectedCount?: number,
): readonly (readonly number[])[] {
  if (!isEmbeddingApiResponse(data)) {
    throw new Error(
      `Embedding API: unexpected response shape — ${describeResponseShape(data)}`,
    );
  }
  // Validate count BEFORE sorting so partial responses don't silently mis-align
  // input texts to vectors. Some LiteLLM/Azure proxies drop or re-number items.
  if (expectedCount !== undefined && data.data.length !== expectedCount) {
    throw new Error(
      `Embedding API: expected ${String(expectedCount)} embeddings, got ${String(data.data.length)}`,
    );
  }
  // Sort by index defensively (most providers return in input order, but some don't).
  const sorted = [...data.data].sort((a, b) => a.index - b.index);
  // Validate indices are contiguous 0..N-1; otherwise text→vector alignment is wrong.
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.index !== i) {
      throw new Error(
        `Embedding API: non-contiguous indices (expected ${String(i)}, got ${String(sorted[i]!.index)})`,
      );
    }
  }
  return sorted.map((item) => item.embedding as readonly number[]);
}
