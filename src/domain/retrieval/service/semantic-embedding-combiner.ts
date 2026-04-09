export function combineSemanticEmbeddings(
  embeddings: readonly (readonly number[])[],
): readonly number[] | undefined {
  const first = embeddings[0];
  if (first === undefined || first.length === 0) {
    return undefined;
  }
  if (embeddings.length === 1) {
    return first;
  }

  const combined = new Array<number>(first.length).fill(0);
  for (const embedding of embeddings) {
    if (embedding.length !== first.length) {
      continue;
    }
    for (let i = 0; i < embedding.length; i++) {
      combined[i] = (combined[i] ?? 0) + (embedding[i] ?? 0);
    }
  }

  const norm = Math.sqrt(combined.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    return first;
  }
  return combined.map((value) => value / norm);
}
