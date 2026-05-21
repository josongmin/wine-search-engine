import { describe, expect, it } from 'vitest';
import {
  MAX_ABBREVIATION_SURFACE_LENGTH,
  MAX_CANDIDATES_PER_ENTITY,
  parseLlmAbbreviationOutput,
} from '../abbreviation-llm-parser.js';

describe('parseLlmAbbreviationOutput — LLM output Zod parser', () => {
  it('accepts a well-formed batch response with one entity', () => {
    const raw = JSON.stringify({
      results: [
        {
          entityId: 'chateau-margaux-2015',
          abbreviations: [
            { surface: 'CM 15', confidence: 0.9 },
            { surface: "CM '15", confidence: 0.85 },
          ],
        },
      ],
    });
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.entityId).toBe('chateau-margaux-2015');
    expect(out.accepted[0]!.abbreviations.map((a) => a.surface)).toEqual(['CM 15', "CM '15"]);
    expect(out.rejected).toEqual([]);
  });

  it('tolerates LLM prose wrapper around the JSON object', () => {
    // LLMs often add "Here's the JSON:" prefix or trailing commentary.
    const raw = `Here's the abbreviation set you asked for:

{"results":[{"entityId":"opus-one-2018","abbreviations":[{"surface":"OO 18"}]}]}

Let me know if you need more variants!`;
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.abbreviations[0]!.surface).toBe('OO 18');
  });

  it('accepts numeric fields emitted as strings (CLAUDE.md LLM-output rule)', () => {
    // LLMs frequently emit "0.85" instead of 0.85 — the parser must
    // coerce via the TolerantNumberSchema.
    const raw = JSON.stringify({
      results: [
        {
          entityId: 'penfolds-grange-2017',
          abbreviations: [{ surface: 'PG 17', confidence: '0.85' }],
        },
      ],
    });
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.abbreviations[0]!.confidence).toBe(0.85);
  });

  it('does NOT use .strict() — accepts extra fields LLMs emit (reasoning, source, …)', () => {
    const raw = JSON.stringify({
      results: [
        {
          entityId: 'romanee-conti-2019',
          // LLM-added extra field — must NOT cause validation failure.
          source: 'wine-forum-corpus',
          confidenceMethod: 'self-eval',
          abbreviations: [
            {
              surface: 'DRC 19',
              confidence: 0.95,
              // LLMs often add an explanation field.
              explanation: "Sommelier shorthand for Domaine Romanée-Conti",
              proposed_by: 'tier-1',
            },
          ],
        },
      ],
      // Top-level extras must also be tolerated.
      metadata: { run_id: 'abc-123', sampled_at: '2026-05-01' },
    });
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.abbreviations[0]!.surface).toBe('DRC 19');
  });

  it('rejects surfaces containing emoji / out-of-vocabulary characters', () => {
    const raw = JSON.stringify({
      results: [
        {
          entityId: 'sassicaia-2018',
          abbreviations: [
            { surface: 'SS 18' },           // OK
            { surface: 'SS🍷18' },          // Emoji → reject
            { surface: 'SS 18' },     // Control char → reject
            { surface: 'SS$18' },           // Currency → reject
          ],
        },
      ],
    });
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.abbreviations.map((a) => a.surface)).toEqual(['SS 18']);
    expect(out.rejected.length).toBeGreaterThanOrEqual(3);
    for (const r of out.rejected) {
      expect(r.reason).toMatch(/canonical wine vocabulary/u);
    }
  });

  it('rejects surfaces shorter than the MIN_SURFACE_LENGTH floor', () => {
    const raw = JSON.stringify({
      results: [
        {
          entityId: 'cloudy-bay-2022',
          abbreviations: [
            { surface: 'C' },  // 1 char → reject at Zod min
          ],
        },
      ],
    });
    const out = parseLlmAbbreviationOutput(raw);
    // Zod-level validation fails the entire batch when a sub-schema
    // rejects — that's fine; we just check we don't accept the bad
    // surface.
    expect(
      out.accepted.flatMap((e) => e.abbreviations.map((a) => a.surface)),
    ).not.toContain('C');
  });

  it(`rejects surfaces longer than MAX_ABBREVIATION_SURFACE_LENGTH=${String(MAX_ABBREVIATION_SURFACE_LENGTH)}`, () => {
    const overlong = 'A'.repeat(MAX_ABBREVIATION_SURFACE_LENGTH + 5);
    const raw = JSON.stringify({
      results: [
        {
          entityId: 'sauternes-2015',
          abbreviations: [{ surface: overlong }],
        },
      ],
    });
    const out = parseLlmAbbreviationOutput(raw);
    expect(
      out.accepted.flatMap((e) => e.abbreviations.map((a) => a.surface)),
    ).not.toContain(overlong);
  });

  it('returns rejected entry for non-JSON LLM output (e.g. refusal)', () => {
    const raw = "I'm sorry, I cannot help with that request.";
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toMatch(/balanced JSON object/u);
  });

  it('returns rejected entry for malformed JSON inside a balanced brace block', () => {
    // Balanced outer braces but invalid JSON inside (unquoted key).
    const raw = '{ results: [{ surface: "AB" }] }';
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toEqual([]);
    expect(out.rejected[0]!.reason).toMatch(/(JSON\.parse|Zod)/u);
  });

  it('returns rejected entry when Zod top-level shape fails', () => {
    const raw = JSON.stringify({ wrong_root: [] });
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toEqual([]);
    expect(out.rejected[0]!.reason).toMatch(/Zod validation failed/u);
  });

  it('truncates entities that exceed MAX_CANDIDATES_PER_ENTITY via Zod array.max', () => {
    // Build 8 candidates → Zod .max(MAX_CANDIDATES_PER_ENTITY=5) rejects.
    const abbreviations = Array.from({ length: MAX_CANDIDATES_PER_ENTITY + 3 }, (_, i) => ({
      surface: `AB ${String(i).padStart(2, '0')}`,
    }));
    const raw = JSON.stringify({
      results: [{ entityId: 'x', abbreviations }],
    });
    const out = parseLlmAbbreviationOutput(raw);
    // Either Zod rejects the whole entity (current behavior) OR returns
    // the truncated set. Verify we never accept more than the cap.
    if (out.accepted.length > 0) {
      expect(out.accepted[0]!.abbreviations.length).toBeLessThanOrEqual(MAX_CANDIDATES_PER_ENTITY);
    }
  });

  it('tolerates the LLM emitting a confidence outside [0,1] but still records the surface', () => {
    // We don't enforce a numeric range in the Zod schema (LLMs sometimes
    // hallucinate values like 1.2). The downstream curation gate
    // clamps; the parser just preserves the raw value.
    const raw = JSON.stringify({
      results: [
        {
          entityId: 'masi-amarone',
          abbreviations: [{ surface: 'MA 18', confidence: '1.2' }],
        },
      ],
    });
    const out = parseLlmAbbreviationOutput(raw);
    expect(out.accepted).toHaveLength(1);
    expect(out.accepted[0]!.abbreviations[0]!.confidence).toBe(1.2);
  });
});
