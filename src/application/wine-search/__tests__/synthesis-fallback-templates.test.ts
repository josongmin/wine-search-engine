/**
 * Regression tests for `synthesis-fallback-templates.ts` SSoT —
 * specifically the {@link buildResynthDirective} template and its bounding
 * constants. Previously this function lived inline in `synthesis-runner.ts`;
 * these tests pin behaviour at the SSoT module boundary so future drift is
 * caught here rather than only in the synthesis-runner integration tests.
 *
 * NOTE: exact wording (e.g. "Grounding check failed:", "GROUNDING_JSON") is
 * load-bearing — the directive is read by an LLM at re-synth time and the
 * keywords match the marker used by the structured grounding-preview parser.
 * Bumping {@link RESYNTH_DIRECTIVE_VERSION} signals a wording change.
 */

import { describe, expect, it } from 'vitest';
import {
  RESYNTH_DIRECTIVE_VERSION,
  RESYNTH_MAX_LISTED_CLAIMS,
  RESYNTH_MAX_LISTED_GRAPES,
  RESYNTH_MAX_LISTED_LABELS,
  RESYNTH_MAX_LISTED_REGIONS,
  buildResynthDirective,
} from '../synthesis-fallback-templates.js';
import type { GroundingFacts } from '../synthesis-grounding-verify.js';

function makeFacts(args: {
  readonly labels?: readonly string[];
  readonly regions?: readonly string[];
  readonly grapes?: readonly string[];
  readonly vintages?: readonly string[];
  readonly prices?: readonly string[];
}): GroundingFacts {
  const labels = new Set(args.labels ?? []);
  const regions = new Set(args.regions ?? []);
  const grapes = new Set(args.grapes ?? []);
  const vintages = new Set(args.vintages ?? []);
  const prices = new Set(args.prices ?? []);
  const hasAnyFact =
    labels.size + regions.size + grapes.size + vintages.size + prices.size > 0;
  return {
    labels,
    regions,
    grapes,
    vintages,
    prices,
    wines: [],
    hasAnyFact,
  };
}

describe('synthesis-fallback-templates / buildResynthDirective', () => {
  it('formats ungrounded claims as a comma-joined list inside the directive', () => {
    const facts = makeFacts({ labels: ['Wine A'] });
    const directive = buildResynthDirective(['Wine B', 'Wine C'], facts);
    expect(directive).toContain('ungrounded: Wine B, Wine C');
  });

  it('includes the load-bearing "Grounding check failed:" preamble', () => {
    const facts = makeFacts({ labels: ['Wine A'] });
    const directive = buildResynthDirective(['Wine B'], facts);
    expect(directive.startsWith('Grounding check failed:')).toBe(true);
  });

  it('includes the GROUNDING_JSON keyword so the model knows the canonical marker', () => {
    const facts = makeFacts({ labels: ['Wine A'] });
    const directive = buildResynthDirective(['Wine B'], facts);
    expect(directive).toContain('GROUNDING_JSON');
  });

  it('enumerates grounded labels (A3 additive directive) when present', () => {
    const facts = makeFacts({ labels: ['Wine A'] });
    const directive = buildResynthDirective(['Wine B'], facts);
    expect(directive).toContain('Wine A');
    expect(directive).toMatch(/wines actually present in the grounding/i);
  });

  it('falls back to a structured-fields-only clause when no grounded labels exist', () => {
    const facts = makeFacts({}); // hasAnyFact === false
    const directive = buildResynthDirective(['Wine B'], facts);
    // No "actually present" clause; uses the conservative "Use only the
    // structured fields" wording instead.
    expect(directive).not.toMatch(/wines actually present in the grounding/i);
    expect(directive).toContain('Use only the structured fields');
  });

  it('truncates ungrounded claims to RESYNTH_MAX_LISTED_CLAIMS surfaces', () => {
    const overflow = Array.from(
      { length: RESYNTH_MAX_LISTED_CLAIMS + 3 },
      (_, i) => `Claim${i + 1}`,
    );
    const facts = makeFacts({ labels: ['Wine A'] });
    const directive = buildResynthDirective(overflow, facts);
    // The first MAX_LISTED claims appear...
    for (let i = 0; i < RESYNTH_MAX_LISTED_CLAIMS; i++) {
      expect(directive).toContain(`Claim${i + 1}`);
    }
    // ...but the first overflow item does NOT.
    expect(directive).not.toContain(`Claim${RESYNTH_MAX_LISTED_CLAIMS + 1}`);
  });

  it('truncates grounded labels to RESYNTH_MAX_LISTED_LABELS surfaces', () => {
    const labels = Array.from(
      { length: RESYNTH_MAX_LISTED_LABELS + 3 },
      (_, i) => `Wine${i + 1}`,
    );
    const facts = makeFacts({ labels });
    const directive = buildResynthDirective(['BogusWine'], facts);
    for (let i = 0; i < RESYNTH_MAX_LISTED_LABELS; i++) {
      expect(directive).toContain(`Wine${i + 1}`);
    }
    expect(directive).not.toContain(`Wine${RESYNTH_MAX_LISTED_LABELS + 1}`);
  });

  it('samples regions and grapes into the "Grounded fields you may draw on" clause', () => {
    const facts = makeFacts({
      labels: ['Wine A'],
      regions: ['Bordeaux'],
      grapes: ['Merlot'],
    });
    const directive = buildResynthDirective(['Wine B'], facts);
    expect(directive).toContain('Grounded fields you may draw on include');
    expect(directive).toContain('regions: Bordeaux');
    expect(directive).toContain('grapes: Merlot');
  });

  it('truncates sampled regions to RESYNTH_MAX_LISTED_REGIONS', () => {
    const regions = Array.from(
      { length: RESYNTH_MAX_LISTED_REGIONS + 2 },
      (_, i) => `Region${i + 1}`,
    );
    const facts = makeFacts({ labels: ['Wine A'], regions });
    const directive = buildResynthDirective(['Wine B'], facts);
    for (let i = 0; i < RESYNTH_MAX_LISTED_REGIONS; i++) {
      expect(directive).toContain(`Region${i + 1}`);
    }
    expect(directive).not.toContain(`Region${RESYNTH_MAX_LISTED_REGIONS + 1}`);
  });

  it('truncates sampled grapes to RESYNTH_MAX_LISTED_GRAPES', () => {
    const grapes = Array.from(
      { length: RESYNTH_MAX_LISTED_GRAPES + 2 },
      (_, i) => `Grape${i + 1}`,
    );
    const facts = makeFacts({ labels: ['Wine A'], grapes });
    const directive = buildResynthDirective(['Wine B'], facts);
    for (let i = 0; i < RESYNTH_MAX_LISTED_GRAPES; i++) {
      expect(directive).toContain(`Grape${i + 1}`);
    }
    expect(directive).not.toContain(`Grape${RESYNTH_MAX_LISTED_GRAPES + 1}`);
  });

  it('omits the field-sample clause entirely when neither regions nor grapes are grounded', () => {
    const facts = makeFacts({ labels: ['Wine A'] });
    const directive = buildResynthDirective(['Wine B'], facts);
    expect(directive).not.toContain('Grounded fields you may draw on include');
  });
});

describe('synthesis-fallback-templates / version + bounding constants', () => {
  it('exposes a version literal for the re-synth directive template', () => {
    // Pinning the literal here means a wording change must be paired with a
    // version bump (the change will fail this test and force the author to
    // touch the constant deliberately).
    expect(RESYNTH_DIRECTIVE_VERSION).toBe('v1');
  });

  it('bounding constants are positive integers (sanity)', () => {
    for (const v of [
      RESYNTH_MAX_LISTED_CLAIMS,
      RESYNTH_MAX_LISTED_LABELS,
      RESYNTH_MAX_LISTED_REGIONS,
      RESYNTH_MAX_LISTED_GRAPES,
    ]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
