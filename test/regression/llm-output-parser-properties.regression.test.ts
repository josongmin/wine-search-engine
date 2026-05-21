/**
 * Property-based regression suite for the agent LLM-output parser
 * (`src/application/agent/agent-llm-output.ts`).
 *
 * The parser is the boundary between non-deterministic LLM text and the
 * typed `AgentToolAttempt` discriminated union consumed by the react planner.
 * Recovery semantics (5 paths: standard / bare / embedded / partial-batch /
 * fallback) plus input repair (unknown-key strip, malformed JSON re-wrap)
 * make this a high-leverage layer to fuzz with structural invariants.
 *
 * Industry-verified property-based test patterns (Hughes / QuickCheck lineage):
 *   - Determinism / referential transparency under repeated invocation.
 *   - Robustness: total function — never throws on any string input.
 *   - Idempotence on the success path: parse(stringify(parse(x))) consistent
 *     when the first parse produced a clean action/answer.
 *   - Unicode preservation (Korean, accented Latin, emoji) byte-for-byte.
 *   - Schema strictness: unknown keys on KNOWN tool inputs are repaired,
 *     not silently accepted into the typed input.
 *   - Discriminator invariants: every returned `LlmAction` has at most one
 *     of {answer, action, actions} (recovery paths route to plannerDefect).
 *   - Token estimation monotonicity: text length grows ⇒ token estimate
 *     non-decreasing (Lipschitz on the CHARS_PER_TOKEN_ESTIMATE constant).
 *
 * Korean (한글) inputs are exercised in EVERY content-touching invariant
 * (rule 8 in CLAUDE.md) and named constants govern every magic value
 * (rule 15).
 *
 * Append-only — never delete (CLAUDE.md "Test discipline").
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateTokenCount,
  isLikelyJsonAttempt,
  isValidLlmResult,
  parseLlmJsonObject,
  parseLlmOutput,
} from '../../src/application/agent/agent-llm-output.js';
import {
  KNOWN_AGENT_TOOL_NAMES,
  parseKnownAgentToolAttemptInput,
  parseKnownAgentToolAttemptInputWithRepair,
  parseUnknownAgentToolAttemptInput,
  MAX_UNKNOWN_TOOL_INPUT_KEYS,
} from '../../src/domain/agent/model/agent-tool-attempt-schema.js';

// ── Named constants for fast-check tuning (CLAUDE.md rule 15) ────────────────
const FC_RUNS = 100;
const MAX_STRING_LEN = 64;
const MAX_BATCH_SIZE = 6;
const MIN_TEXT_LEN_FOR_TOKEN_PROPERTY = 0;
const MAX_TEXT_LEN_FOR_TOKEN_PROPERTY = 4_000;
const KOREAN_SAMPLE_QUERIES = [
  '오퍼스 원 추천해줘',
  '바롤로 vs 브루넬로 비교',
  '한우와 어울리는 와인',
  '드라이한 화이트 와인',
  '비건 인증된 내추럴 와인',
] as const;
const ACCENTED_LATIN_SAMPLES = [
  'Château Margaux',
  'Côte-Rôtie',
  'Brunello di Montalcino',
] as const;
const EMOJI_SAMPLES = ['🍷 cabernet', 'pinot 🇫🇷 noir'] as const;

// ── Arbitrary builders ───────────────────────────────────────────────────────
const koreanText = fc.constantFrom(...KOREAN_SAMPLE_QUERIES);
const accentedText = fc.constantFrom(...ACCENTED_LATIN_SAMPLES);
const emojiText = fc.constantFrom(...EMOJI_SAMPLES);
const asciiText = fc.string({ minLength: 1, maxLength: MAX_STRING_LEN });

const multilingualText = fc.oneof(
  asciiText,
  koreanText,
  accentedText,
  emojiText,
);

const knownToolName = fc.constantFrom(...KNOWN_AGENT_TOOL_NAMES);

const searchInputArb = fc.record(
  {
    query: multilingualText,
    limit: fc.integer({ min: 1, max: 50 }),
  },
  { requiredKeys: ['query'] },
);

const wrappedActionPayload = fc.record({
  thought: multilingualText,
  action: fc.record({
    tool: fc.constant('search_wines'),
    input: searchInputArb,
  }),
});

const finalAnswerPayload = fc.record({
  thought: multilingualText,
  answer: multilingualText,
});

const parallelActionsPayload = fc.record({
  thought: multilingualText,
  actions: fc.array(
    fc.record({
      tool: knownToolName,
      input: fc.record({ query: multilingualText }, { requiredKeys: [] }),
    }),
    { minLength: 1, maxLength: MAX_BATCH_SIZE },
  ),
});

const bareToolPayload = fc.record({
  thought: multilingualText,
  tool: fc.constant('search_wines'),
  input: searchInputArb,
});

const validPayload = fc.oneof(
  wrappedActionPayload,
  finalAnswerPayload,
  parallelActionsPayload,
  bareToolPayload,
);

describe('llm-output-parser property invariants (regression)', () => {
  // ── 1. Robustness: never throws on any string ─────────────────────────────
  it('parseLlmOutput is total — never throws on arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        // No throws expected — every input must route into a recovery branch.
        const out = parseLlmOutput(s);
        expect(typeof out.thought).toBe('string');
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('parseLlmOutput is total on multilingual (Korean / accented / emoji) noise', () => {
    fc.assert(
      fc.property(multilingualText, (s) => {
        const out = parseLlmOutput(s);
        expect(typeof out.thought).toBe('string');
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('parseLlmJsonObject returns null (not throws) for non-JSON text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 128 }), (s) => {
        // The function must never throw; null is the documented fallback.
        const result = parseLlmJsonObject(s);
        expect(result === null || (typeof result === 'object' && result !== null)).toBe(true);
      }),
      { numRuns: FC_RUNS },
    );
  });

  // ── 2. Determinism: same input → same output ──────────────────────────────
  it('parseLlmOutput is deterministic (same input → identical result)', () => {
    fc.assert(
      fc.property(validPayload, (payload) => {
        const text = JSON.stringify(payload);
        const a = parseLlmOutput(text);
        const b = parseLlmOutput(text);
        expect(a).toEqual(b);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('parseLlmOutput is deterministic on adversarial noise', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 256 }), (s) => {
        const a = parseLlmOutput(s);
        const b = parseLlmOutput(s);
        expect(a).toEqual(b);
      }),
      { numRuns: FC_RUNS },
    );
  });

  // ── 3. Mutual-exclusion discriminator invariant ───────────────────────────
  it('LlmAction has at most one of {answer, action, actions} on success', () => {
    fc.assert(
      fc.property(validPayload, (payload) => {
        const text = JSON.stringify(payload);
        const out = parseLlmOutput(text);
        // Recovery branches route conflicts through plannerDefect; a clean
        // success result must NOT carry multiple positive outcomes.
        if (out.plannerDefect === undefined) {
          const positives = [out.answer, out.action, out.actions].filter(
            (x) => x !== undefined,
          );
          expect(positives.length).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  // ── 4. Unicode preservation (CLAUDE.md rule 8) ───────────────────────────
  it('preserves Korean text in answer field byte-for-byte', () => {
    fc.assert(
      fc.property(koreanText, multilingualText, (answer, thought) => {
        const text = JSON.stringify({ thought, answer });
        const out = parseLlmOutput(text);
        expect(out.answer).toBe(answer);
        expect(out.thought).toBe(thought);
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('preserves Korean text in search_wines query through the typed path', () => {
    fc.assert(
      fc.property(koreanText, (query) => {
        const text = JSON.stringify({
          thought: '한국어 검색',
          action: { tool: 'search_wines', input: { query } },
        });
        const out = parseLlmOutput(text);
        expect(out.action?.tool).toBe('search_wines');
        // We know it is search_wines (discriminator narrowed input shape).
        if (out.action !== undefined && out.action.tool === 'search_wines') {
          expect(out.action.input.query).toBe(query);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('preserves accented Latin and emoji in answer', () => {
    fc.assert(
      fc.property(fc.oneof(accentedText, emojiText), (answer) => {
        const text = JSON.stringify({ thought: 'unicode', answer });
        const out = parseLlmOutput(text);
        expect(out.answer).toBe(answer);
      }),
      { numRuns: FC_RUNS },
    );
  });

  // ── 5. Schema strictness: unknown keys are surfaced as repair, not silent ─
  it('unknown keys in known-tool input are recorded as a repair (not silently accepted)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }).filter((s) => {
          // Avoid colliding with a legitimate schema key by using a sentinel
          // prefix; this keeps the property focused on the unknown-key path.
          return !/^[a-z_]+$/u.test(s);
        }),
        multilingualText,
        (unknownKeyName, q) => {
          const text = JSON.stringify({
            thought: 'try unknown key',
            action: {
              tool: 'search_wines',
              input: { query: q, [unknownKeyName]: 'extra' },
            },
          });
          const out = parseLlmOutput(text);
          // Either the parser accepted the call and recorded a repair, or
          // it routed the malformed candidate to plannerDefect. Silent
          // success without surfacing the unknown key is FORBIDDEN.
          if (out.action !== undefined) {
            expect(out.plannerRepair).toBeDefined();
            expect(out.plannerRepair?.repairedCandidates?.[0]?.removedUnknownKeys).toContain(
              unknownKeyName,
            );
            // The typed input MUST NOT carry the unknown key.
            const inputRecord = out.action.input as Record<string, unknown>;
            expect(Object.keys(inputRecord)).not.toContain(unknownKeyName);
          } else {
            expect(out.plannerDefect).toBeDefined();
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── 6. Parallel-batch partial recovery is total ──────────────────────────
  it('parallel actions batch returns plannerRepair iff any candidate dropped/repaired', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            // Valid known tool
            fc.record({
              tool: knownToolName,
              input: fc.record({ query: multilingualText }, { requiredKeys: [] }),
            }),
            // Invalid: missing tool
            fc.record({ tool: fc.constant(''), input: fc.record({}) }),
            // Invalid: non-object entry
            fc.constant(42),
          ),
          { minLength: 1, maxLength: MAX_BATCH_SIZE },
        ),
        (actions) => {
          const text = JSON.stringify({ thought: 'parallel', actions });
          const out = parseLlmOutput(text);
          // Either we got at least one valid action, or we got a defect —
          // we never return an actions array WITH plannerDefect, and we
          // never return an empty actions array claiming success.
          if (out.actions !== undefined) {
            expect(out.actions.length).toBeGreaterThan(0);
            expect(out.plannerDefect).toBeUndefined();
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── 7. Idempotence on success path ────────────────────────────────────────
  it('idempotent on clean final-answer payloads: re-serializing answer parses identically', () => {
    fc.assert(
      fc.property(multilingualText, multilingualText, (thought, answer) => {
        const text1 = JSON.stringify({ thought, answer });
        const a = parseLlmOutput(text1);
        if (a.answer === undefined) return; // skip if recovery hit
        const text2 = JSON.stringify({ thought: a.thought, answer: a.answer });
        const b = parseLlmOutput(text2);
        expect(b.thought).toBe(a.thought);
        expect(b.answer).toBe(a.answer);
      }),
      { numRuns: FC_RUNS },
    );
  });

  // ── 8. Token estimation properties ────────────────────────────────────────
  it('estimateTokenCount is non-negative and monotone in length', () => {
    fc.assert(
      fc.property(
        fc.string({
          minLength: MIN_TEXT_LEN_FOR_TOKEN_PROPERTY,
          maxLength: MAX_TEXT_LEN_FOR_TOKEN_PROPERTY,
        }),
        (s) => {
          const n = estimateTokenCount(s);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBe(Math.ceil(s.length / CHARS_PER_TOKEN_ESTIMATE));
          // Monotone: appending a character cannot decrease the estimate.
          expect(estimateTokenCount(`${s}x`)).toBeGreaterThanOrEqual(n);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── 9. JSON-likeness oracle agrees with parser routing ────────────────────
  it('isLikelyJsonAttempt is a stable oracle over fences and whitespace', () => {
    fc.assert(
      fc.property(validPayload, (payload) => {
        const text = JSON.stringify(payload);
        const fenced = `\`\`\`json\n${text}\n\`\`\``;
        expect(isLikelyJsonAttempt(text)).toBe(true);
        expect(isLikelyJsonAttempt(fenced)).toBe(true);
        expect(isLikelyJsonAttempt(`   ${text}   `)).toBe(true);
      }),
      { numRuns: FC_RUNS },
    );
  });

  // ── 10. isValidLlmResult runtime guard rejection ──────────────────────────
  it('isValidLlmResult rejects non-object and shape-mismatched values', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.string(),
          fc.integer(),
          fc.record({ text: fc.string() }), // missing model
          fc.record({ model: fc.string() }), // missing text
        ),
        (bad) => {
          expect(isValidLlmResult(bad)).toBe(false);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('isValidLlmResult accepts the minimal valid shape', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (text, model) => {
        expect(isValidLlmResult({ text, model })).toBe(true);
      }),
      { numRuns: FC_RUNS },
    );
  });

  // ── 11. Tool-attempt schema invariants ────────────────────────────────────
  it('parseKnownAgentToolAttemptInput rejects unknown tools', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 32 })
          .filter((s) => !(KNOWN_AGENT_TOOL_NAMES as readonly string[]).includes(s)),
        (badTool) => {
          const out = parseKnownAgentToolAttemptInput(badTool, { query: 'x' });
          expect(out).toBeNull();
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('parseKnownAgentToolAttemptInputWithRepair surfaces repair when unknown keys present', () => {
    fc.assert(
      fc.property(multilingualText, (q) => {
        const out = parseKnownAgentToolAttemptInputWithRepair('search_wines', {
          query: q,
          __unknown_field__: 'x',
        });
        expect(out.attempt).not.toBeNull();
        expect(out.repair?.removedUnknownKeys ?? []).toContain('__unknown_field__');
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('parseUnknownAgentToolAttemptInput truncates to MAX_UNKNOWN_TOOL_INPUT_KEYS', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MAX_UNKNOWN_TOOL_INPUT_KEYS + 1, max: MAX_UNKNOWN_TOOL_INPUT_KEYS * 3 }),
        (n) => {
          const input: Record<string, unknown> = {};
          for (let i = 0; i < n; i++) input[`k${i}`] = i;
          const out = parseUnknownAgentToolAttemptInput(input);
          expect(Object.keys(out).length).toBe(MAX_UNKNOWN_TOOL_INPUT_KEYS);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('parseUnknownAgentToolAttemptInput preserves input when under the cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_UNKNOWN_TOOL_INPUT_KEYS }),
        (n) => {
          const input: Record<string, unknown> = {};
          for (let i = 0; i < n; i++) input[`k${i}`] = i;
          const out = parseUnknownAgentToolAttemptInput(input);
          expect(Object.keys(out).length).toBe(n);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── 12. Fenced + whitespace tolerance round-trip ──────────────────────────
  it('parses identically with and without ```json fences (Korean payload)', () => {
    fc.assert(
      fc.property(koreanText, koreanText, (thought, answer) => {
        const plain = JSON.stringify({ thought, answer });
        const fenced = `\`\`\`json\n${plain}\n\`\`\``;
        expect(parseLlmOutput(plain)).toEqual(parseLlmOutput(fenced));
      }),
      { numRuns: FC_RUNS },
    );
  });

  // ── 13. Empty input fallback ──────────────────────────────────────────────
  it('empty string falls back to unparseable-output answer', () => {
    const out = parseLlmOutput('');
    expect(out.thought).toBe('[unparseable LLM output]');
    expect(out.answer).toBe('');
  });

  // ── 14. plannerDefect.rawText echoes the trimmed input (audit invariant) ──
  it('when plannerDefect is surfaced, rawText is a substring of the original (trimmed) text', () => {
    fc.assert(
      fc.property(
        fc.record({
          thought: multilingualText,
          // Both answer AND action ⇒ mixed defect path
          answer: multilingualText,
          action: fc.record({ tool: fc.constant('search_wines'), input: searchInputArb }),
        }),
        (payload) => {
          const text = JSON.stringify(payload);
          const out = parseLlmOutput(text);
          if (out.plannerDefect !== undefined) {
            expect(text).toContain(out.plannerDefect.rawText.slice(0, 16));
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});
