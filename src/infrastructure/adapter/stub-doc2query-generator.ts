import type {
  Doc2QueryGeneratorPort,
  Doc2QueryInput,
} from '../../domain/retrieval/port/doc2query-generator.port.js';

/**
 * Stub Doc2Query generator — dev / test fallback when no LLM adapter
 * is configured. NOT a useful expansion — it just produces deterministic
 * placeholders from the structured wine input so dev wiring boots.
 */

const TOKEN_SPLIT_REGEX = /[^\p{L}\p{N}]+/u;
const STUB_WINDOW_TOKENS = 4;

export class StubDoc2QueryGenerator implements Doc2QueryGeneratorPort {
  readonly modelId = 'stub-doc2query-fallback';

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy port; stub has no I/O
  async generate(input: Doc2QueryInput): Promise<readonly string[]> {
    if (!Number.isFinite(input.numQueries) || input.numQueries <= 0) {
      return [];
    }
    if (!input.canonicalLabel || input.canonicalLabel.trim().length === 0) {
      return [];
    }

    // Compose a stub "doc text" from the available structured fields so
    // the behaviour is stable regardless of which fields happened to be
    // populated upstream.
    const parts = [
      input.canonicalLabel,
      input.producer,
      input.region,
      input.grapePrimary ?? '',
      ...input.grapes,
      ...input.flavorProfiles,
      ...input.koreanAliases,
    ].filter((s) => s && s.length > 0);

    const tokens = parts
      .join(' ')
      .split(TOKEN_SPLIT_REGEX)
      .filter((t) => t.length > 0);
    if (tokens.length === 0) return [];

    const out: string[] = [];
    for (let i = 0; i < input.numQueries; i += 1) {
      const start = (i * STUB_WINDOW_TOKENS) % tokens.length;
      const window = tokens.slice(start, start + STUB_WINDOW_TOKENS);
      if (window.length === 0) {
        out.push(tokens.slice(0, STUB_WINDOW_TOKENS).join(' '));
      } else {
        out.push(window.join(' '));
      }
    }
    return out;
  }
}
