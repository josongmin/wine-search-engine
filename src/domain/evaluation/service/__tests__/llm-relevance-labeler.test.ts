import { describe, it, expect } from 'vitest';
import { parseLabelingResponse, FALLBACK_GRADE, FALLBACK_CONFIDENCE } from '../llm-relevance-labeler.js';

describe('parseLabelingResponse', () => {
  it('parses valid JSON response with grade, confidence, rationale', () => {
    const result = parseLabelingResponse('{"grade": 3, "confidence": 0.95, "rationale": "exact wine name match"}');
    expect(result.grade).toBe(3);
    expect(result.confidence).toBe(0.95);
    expect(result.rationale).toBe('exact wine name match');
  });

  it('extracts JSON from markdown code block', () => {
    const raw = '```json\n{"grade": 2, "confidence": 0.7, "rationale": "good match"}\n```';
    const result = parseLabelingResponse(raw);
    expect(result.grade).toBe(2);
    expect(result.confidence).toBe(0.7);
  });

  it('falls back to conservative grade on malformed JSON', () => {
    const result = parseLabelingResponse('not json at all');
    expect(result.grade).toBe(FALLBACK_GRADE);
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
    expect(result.rationale).toBe('parse_fallback');
  });

  it('falls back when grade is out of 0-3 range (Zod max(3))', () => {
    const result = parseLabelingResponse('{"grade": 5, "confidence": 0.8, "rationale": "x"}');
    expect(result.grade).toBe(FALLBACK_GRADE);
  });

  it('falls back when confidence is out of 0-1 range', () => {
    const result = parseLabelingResponse('{"grade": 2, "confidence": 1.5, "rationale": "x"}');
    expect(result.confidence).toBe(FALLBACK_CONFIDENCE);
  });

  it('accepts string-typed numeric fields (LLM coercion)', () => {
    const result = parseLabelingResponse('{"grade": "3", "confidence": "0.95", "rationale": "x"}');
    expect(result.grade).toBe(3);
    expect(result.confidence).toBe(0.95);
  });

  it('accepts empty rationale (default to "")', () => {
    const result = parseLabelingResponse('{"grade": 2, "confidence": 0.5}');
    expect(result.rationale).toBe('');
  });

  it('extracts JSON from response with preamble text', () => {
    const raw = 'Here is my assessment: {"grade": 1, "confidence": 0.4, "rationale": "marginal"}';
    const result = parseLabelingResponse(raw);
    expect(result.grade).toBe(1);
    expect(result.rationale).toBe('marginal');
  });
});
