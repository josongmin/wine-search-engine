/**
 * Stage timer — property-based regression suite.
 *
 * Locks the timing invariants for
 * `src/domain/shared/stage-timer.ts`:
 *
 *   - monotonic clock: `performance.now()` (industry standard) is monotone
 *     non-decreasing — successive ticks under an injected clock never go
 *     backwards. NOTE: this only verifies the property holds when the
 *     timer is fed a monotone clock; the production default is
 *     `performance.now()` which is monotone per HR-Time spec.
 *   - stage stack LIFO unwind: nested begin/end pairs (outer ⊃ inner)
 *     unwind in LIFO order; outer duration ≥ inner duration.
 *   - duration non-negative: every recorded stage end - start ≥ 0
 *     for a monotone clock.
 *   - deterministic snapshot: same begin/end sequence + same clock ticks
 *     ⇒ same snapshot.
 *   - empty stage: begin+end without nesting records a valid duration.
 *   - parallel async stages: two concurrent async stages do not corrupt
 *     each other's timestamps.
 *   - Korean stage name verbatim: NFC-preserved key in snapshot.
 *   - cooperative abort during a timed stage: stage still ends cleanly
 *     (the timer is decoupled from the abort signal — it only measures).
 *
 * Implementation note: the timer accepts an optional `now: () => number`
 * factory parameter so property tests can drive a deterministic clock.
 * Default remains `performance.now`.
 *
 * Append-only regression file — never delete. See CLAUDE.md "Test discipline".
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createStageTimer } from '../../src/domain/shared/stage-timer.js';
import { isAbortError } from '../../src/domain/shared/cooperative-abort.js';

const FC_RUNS = 100;

/**
 * Build a deterministic monotone clock from an array of non-decreasing
 * tick values. The clock returns ticks[0], ticks[1], … in call order.
 * After exhaustion, returns the last value (clock "stalls" — still
 * monotone, never decreasing).
 */
function makeScriptedClock(ticks: ReadonlyArray<number>): () => number {
  let i = 0;
  return () => {
    if (i < ticks.length) {
      const v = ticks[i]!;
      i += 1;
      return v;
    }
    return ticks.length > 0 ? ticks[ticks.length - 1]! : 0;
  };
}

describe('stage-timer — property-based invariants', () => {
  it('property: clock injection — successive ticks are non-decreasing (monotonicity)', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.float({ min: 0, max: 1e9, noNaN: true }), {
            minLength: 2,
            maxLength: 64,
          })
          .map((arr) => [...arr].sort((a, b) => a - b)),
        (sortedTicks) => {
          const clock = makeScriptedClock(sortedTicks);
          let prev = -Infinity;
          for (let i = 0; i < sortedTicks.length; i += 1) {
            const v = clock();
            expect(v).toBeGreaterThanOrEqual(prev);
            prev = v;
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('property: duration non-negative for every recorded stage', () => {
    fc.assert(
      fc.property(
        fc
          .array(
            fc.tuple(
              fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.length > 0),
              fc.nat({ max: 1000 }),
              fc.nat({ max: 1000 }),
            ),
            { minLength: 1, maxLength: 16 },
          ),
        (events) => {
          // Build a monotone tick stream: start_i = cumulative, end_i = start_i + dur_i
          const ticks: number[] = [];
          let t = 0;
          for (const [, gap, dur] of events) {
            t += gap;
            ticks.push(t); // start
            t += dur;
            ticks.push(t); // end
          }
          const timer = createStageTimer({ now: makeScriptedClock(ticks) });
          // Use unique stage names so multiple-start-overwrite semantics
          // do not perturb this property.
          events.forEach(([name, , dur], i) => {
            const key = `${name}#${i}`;
            timer.start(key);
            const elapsed = timer.end(key);
            expect(elapsed).toBeGreaterThanOrEqual(0);
            expect(elapsed).toBe(dur);
          });
          const snap = timer.snapshot();
          for (const v of Object.values(snap)) {
            expect(v).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('property: nested stage duration ≤ outer stage duration (stack LIFO)', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: 100 }), // outer start
        fc.nat({ max: 100 }), // inner offset within outer
        fc.nat({ max: 100 }), // inner duration
        fc.nat({ max: 100 }), // outer remainder after inner ends
        (outerStartGap, innerOffset, innerDur, outerTail) => {
          const tOuterStart = outerStartGap;
          const tInnerStart = tOuterStart + innerOffset;
          const tInnerEnd = tInnerStart + innerDur;
          const tOuterEnd = tInnerEnd + outerTail;
          const ticks = [tOuterStart, tInnerStart, tInnerEnd, tOuterEnd];
          const timer = createStageTimer({ now: makeScriptedClock(ticks) });
          timer.start('outer');
          timer.start('inner');
          const inner = timer.end('inner');
          const outer = timer.end('outer');
          expect(inner).toBeGreaterThanOrEqual(0);
          expect(outer).toBeGreaterThanOrEqual(0);
          expect(inner).toBeLessThanOrEqual(outer);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('property: deterministic snapshot — same events + same clock ⇒ same output', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.string({ minLength: 1, maxLength: 8 }),
            fc.nat({ max: 50 }),
            fc.nat({ max: 50 }),
          ),
          { minLength: 1, maxLength: 12 },
        ),
        (events) => {
          const runOnce = (): Readonly<Record<string, number>> => {
            const ticks: number[] = [];
            let t = 0;
            for (const [, gap, dur] of events) {
              t += gap;
              ticks.push(t);
              t += dur;
              ticks.push(t);
            }
            const timer = createStageTimer({ now: makeScriptedClock(ticks) });
            events.forEach(([name, , ], i) => {
              const key = `${name}#${i}`;
              timer.start(key);
              timer.end(key);
            });
            return timer.snapshot();
          };
          expect(runOnce()).toEqual(runOnce());
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  it('empty stage: begin+end without nesting records a valid duration', () => {
    const timer = createStageTimer({ now: makeScriptedClock([5, 12]) });
    timer.start('solo');
    const elapsed = timer.end('solo');
    expect(elapsed).toBe(7);
    expect(timer.snapshot()).toEqual({ solo: 7 });
  });

  it('parallel async stages do not interleave timestamps', async () => {
    // Two parallel async stages with disjoint clock ticks. The scripted
    // clock advances on each call; we assert the two stages report the
    // exact ticks they were assigned, with no cross-contamination.
    const ticks = [
      100, // alpha start
      200, // beta start
      350, // alpha end → 250
      500, // beta end → 300
    ];
    const timer = createStageTimer({ now: makeScriptedClock(ticks) });

    const runAlpha = async (): Promise<number> => {
      timer.start('alpha');
      await Promise.resolve();
      // Yield so beta can interleave its start
      await Promise.resolve();
      return timer.end('alpha');
    };
    const runBeta = async (): Promise<number> => {
      // Wait one microtask so alpha.start lands first
      await Promise.resolve();
      timer.start('beta');
      await Promise.resolve();
      return timer.end('beta');
    };

    const [alphaMs, betaMs] = await Promise.all([runAlpha(), runBeta()]);
    expect(alphaMs).toBe(250);
    expect(betaMs).toBe(300);
    const snap = timer.snapshot();
    expect(snap['alpha']).toBe(250);
    expect(snap['beta']).toBe(300);
  });

  it('Korean stage name is preserved verbatim in the snapshot', () => {
    const koreanName = '검색-단계';
    const timer = createStageTimer({ now: makeScriptedClock([0, 42]) });
    timer.start(koreanName);
    const elapsed = timer.end(koreanName);
    expect(elapsed).toBe(42);
    const snap = timer.snapshot();
    expect(Object.keys(snap)).toContain(koreanName);
    expect(snap[koreanName]).toBe(42);
    // NFC verbatim: ensure character codepoints round-trip unchanged.
    const recoveredKey = Object.keys(snap).find((k) => k === koreanName);
    expect(recoveredKey).toBe(koreanName);
    expect(Array.from(recoveredKey ?? '')).toEqual(Array.from(koreanName));
  });

  it('cooperative abort during a timed stage: stage still ends correctly', () => {
    // The StageTimer is decoupled from the abort signal — it only
    // measures. Aborting mid-stage MUST NOT corrupt the recorded
    // duration; the caller decides whether to call `end()`.
    const controller = new AbortController();
    const timer = createStageTimer({ now: makeScriptedClock([1000, 1075]) });
    timer.start('aborted-stage');
    controller.abort(new DOMException('test-cancel', 'AbortError'));
    expect(controller.signal.aborted).toBe(true);
    expect(isAbortError(controller.signal.reason)).toBe(true);
    // end() is still safe to call and reports the correct duration.
    const elapsed = timer.end('aborted-stage');
    expect(elapsed).toBe(75);
    expect(timer.snapshot()['aborted-stage']).toBe(75);
    expect(timer.isRunning('aborted-stage')).toBe(false);
  });

  it('multi-start: last start wins (documented LIFO semantics)', () => {
    // Documented contract: "Multi-start of the same stage is allowed but
    // the LAST start wins". Lock this so future refactors can't silently
    // change the semantics.
    const timer = createStageTimer({ now: makeScriptedClock([10, 50, 90]) });
    timer.start('llm'); // discarded
    timer.start('llm'); // wins (t=50)
    expect(timer.end('llm')).toBe(40); // 90 - 50
  });
});
