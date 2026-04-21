import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSilentSkipCounter,
  incrementLtrInferenceComponentScoreAbsent,
  globalSilentSkipCounter,
  type SilentSkipKind,
} from '../silent-skip-counters.js';

describe('silent-skip-counters', () => {
  beforeEach(() => {
    globalSilentSkipCounter.reset();
  });

  it('increments the requested kind and leaves others at zero', () => {
    const counter = createSilentSkipCounter();
    counter.increment('embedding_dim_mismatch', { expected: 768, got: 384 });
    counter.increment('embedding_dim_mismatch');
    counter.increment('cache_write_failure');

    const snap = counter.snapshot();
    expect(snap.embedding_dim_mismatch).toBe(2);
    expect(snap.cache_write_failure).toBe(1);
    expect(snap.embedding_empty_vector).toBe(0);
    expect(snap.cache_read_failure).toBe(0);
    expect(snap.unknown_channel_fallback).toBe(0);
    expect(snap.json_parse_failure).toBe(0);
  });

  it('snapshot returns a frozen copy that does not reflect later increments', () => {
    const counter = createSilentSkipCounter();
    counter.increment('unknown_channel_fallback');
    const snap = counter.snapshot();
    expect(Object.isFrozen(snap)).toBe(true);

    counter.increment('unknown_channel_fallback');
    // Old snapshot must stay stable.
    expect(snap.unknown_channel_fallback).toBe(1);
    expect(counter.snapshot().unknown_channel_fallback).toBe(2);
  });

  it('reset clears all counts back to zero', () => {
    const counter = createSilentSkipCounter();
    counter.increment('json_parse_failure');
    counter.increment('cache_read_failure');
    counter.reset();

    const snap = counter.snapshot();
    expect(snap.json_parse_failure).toBe(0);
    expect(snap.cache_read_failure).toBe(0);
  });

  it('increment throws on an unknown kind (runtime guard for JS callers)', () => {
    const counter = createSilentSkipCounter();
    // Force an invalid value past the type system to exercise the runtime guard.
    const bogus = 'not_a_real_kind' as unknown as SilentSkipKind;
    expect(() => counter.increment(bogus)).toThrow(/Unknown SilentSkipKind/);
  });

  it('globalSilentSkipCounter is a shared singleton across imports', () => {
    globalSilentSkipCounter.increment('embedding_empty_vector');
    expect(globalSilentSkipCounter.snapshot().embedding_empty_vector).toBe(1);
  });

  it('tracks blocker zero-candidate events for release gates', () => {
    globalSilentSkipCounter.increment('blocker_zero_candidates');
    expect(globalSilentSkipCounter.snapshot().blocker_zero_candidates).toBe(1);
  });

  it('tracks LTR inference component-score absences with explicit taxonomy', () => {
    incrementLtrInferenceComponentScoreAbsent('semantic');
    incrementLtrInferenceComponentScoreAbsent('multilingualScore');

    const snap = globalSilentSkipCounter.snapshot();
    expect(snap.ltr_inference_component_score_absent_semantic).toBe(1);
    expect(snap.ltr_inference_component_score_absent_multilingual_score).toBe(1);
    expect(snap.ltr_inference_component_score_absent_popularity).toBe(0);
    expect(snap.ltr_inference_component_score_absent_attribute_alignment).toBe(0);
    expect(snap.ltr_inference_component_score_absent_preference_alignment).toBe(0);
  });
});
