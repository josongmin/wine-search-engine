import { FixtureLoader } from '../../src/infrastructure/fixture/fixture-loader.js';

export const OFFLINE_EVAL_GATE_CORPUS = 'corpora/offline-eval/golden-queries-gate.jsonl';
export const OFFLINE_EVAL_SILVER_CORPUS = 'corpora/offline-eval/golden-queries-silver.jsonl';
export const OFFLINE_EVAL_VAL_CORPUS = 'corpora/offline-eval/golden-queries-val.jsonl';

export const RELEVANCE_LABELING_INPUT_CORPUS = 'corpora/relevance/scenarios-labeling-input.jsonl';
export const RELEVANCE_SILVER_STUB_CORPUS = 'corpora/relevance/scenarios-silver-stub.ndjson';
export const RELEVANCE_GOLD_CORPUS = 'corpora/relevance/scenarios-gold.ndjson';
export const RELEVANCE_AUDIT_CORPUS = 'corpora/relevance/scenarios-audit.ndjson';
export const RELEVANCE_REJECTED_CORPUS = 'corpora/relevance/scenarios-rejected.ndjson';

export function resolveFixtureCorpusPath(corpusRelPath: string): string | null {
  const loader = new FixtureLoader();
  if (!loader.isAvailable()) return null;
  return loader.corpusPath(corpusRelPath);
}

export function requireFixtureCorpusPath(corpusRelPath: string, purpose: string): string {
  const resolved = resolveFixtureCorpusPath(corpusRelPath);
  if (resolved !== null) return resolved;
  throw new Error(
    `${purpose}: external fixture corpus is required but fixture repo is unavailable (${corpusRelPath})`,
  );
}
