/**
 * RFC-021 T-PSA-04 audit remediation — runtime exhaustiveness guard for every
 * map keyed by the `QueryFamilyLabel` SSoT.
 *
 * Why this rail exists: adding `reference_similarity` to `QUERY_FAMILY_LABELS`
 * left `EXPLANATION_OBLIGATION_MAP: Record<QueryFamily, …>` missing a key — a
 * real `TS2741` — but the composite `tsc --build` reused a stale `.tsbuildinfo`
 * and reported GREEN on a warm cache. A cold CI / fresh checkout would have
 * failed the build, and at runtime the missing family silently fell back to the
 * `unknown` (most-conservative) obligation. A runtime assertion does not depend
 * on cache state and catches the whole class.
 *
 * Append-only (CLAUDE.md): never delete a regression test. When a new family
 * label is added, extend BOTH maps below — this rail will fail until you do.
 */

import { describe, it, expect } from 'vitest';
import { QUERY_FAMILY_LABELS } from '../../src/domain/query/model/query-observability-vocab.js';
import { hasExplicitExplanationObligation } from '../../src/domain/response/service/explanation-obligation.js';
import { resolveLiveQueryFamilyPolicy } from '../../src/domain/retrieval/service/live-retrieval-policy-registry.js';

describe('query-family-label exhaustiveness — every label is mapped everywhere', () => {
  it.each(QUERY_FAMILY_LABELS)(
    'EXPLANATION_OBLIGATION_MAP has an explicit entry for "%s" (not the unknown fallback)',
    (family) => {
      expect(hasExplicitExplanationObligation(family)).toBe(true);
    },
  );

  it.each(QUERY_FAMILY_LABELS)(
    'LIVE_QUERY_FAMILY_POLICY resolves a profile for "%s"',
    (family) => {
      const policy = resolveLiveQueryFamilyPolicy(family);
      expect(policy).toBeDefined();
      expect(policy.profileName).toBeTruthy();
    },
  );

  it('reference_similarity is a first-class family (regression anchor for the audit fix)', () => {
    expect(QUERY_FAMILY_LABELS).toContain('reference_similarity');
    expect(hasExplicitExplanationObligation('reference_similarity')).toBe(true);
    expect(resolveLiveQueryFamilyPolicy('reference_similarity').profileName).toBe('mixed_anchor');
  });
});
