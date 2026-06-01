/**
 * [entity-lookup-v2] Regression locks for the 2026-06-02 adversarial audit
 * findings (workflow w06v3pg9i).
 *
 * Append-only — never delete.
 *
 * Locks:
 *  - HIGH: untrusted calibration must NOT certify a resolve from a raw score
 *    (no exact-identity evidence → abstain), even when the score self-normalizes
 *    to 1.0 (audit DoD-d).
 *  - MED: Korean grape regexes are boundary-wrapped — a token that merely
 *    CONTAINS a grape substring is not over-stripped (audit DoD-c).
 *  - MED: accented / hyphenated concept phrases match the accent+punctuation
 *    stripped view (audit DoD-b).
 *  - MED: request max_candidates caps the surfaced candidate list.
 */

import { describe, expect, it, vi } from 'vitest';
import { classifyConcept } from '../../src/domain/resolver/v2/concept-lexicon.js';
import { CalibratedAbstainDecider } from '../../src/domain/resolver/v2/calibrated-abstain-decider.js';
import { ConceptAdmissionGate } from '../../src/domain/resolver/v2/concept-admission-gate.js';
import { EntityLookupV2UseCase } from '../../src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { NormalizedQueryViews } from '../../src/domain/query/model/query-views.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type {
  EntityResolverPort,
  QueryPlannerPort,
} from '../../src/application/search/port/search-pipeline-deps.port.js';

function makeViews(query: string): NormalizedQueryViews {
  const lower = query.toLowerCase();
  // Strip Latin combining diacritics, then NFC-recompose so Hangul stays
  // composed (the production normalizer emits NFC) — mirrors stripAccents.
  const accentless = lower.normalize('NFD').replace(/[̀-ͯ]/gu, '').normalize('NFC');
  const punct = accentless.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  const vintageStripped = punct.replace(/\b(19|20)\d{2}\b/gu, '').replace(/\s+/gu, ' ').trim();
  return {
    raw: query, strict: lower, accentless, collapsedWhitespace: accentless,
    punctuationStripped: punct, compact: punct.replace(/[^\p{L}\p{N}]/gu, ''),
    vintageCanonicalized: punct, vintageStripped,
    semanticVariants: [punct], lookupVariants: [punct],
  };
}

// ── HIGH: untrusted raw-score must not wrong-resolve ──────────────────────────

describe('audit HIGH — untrusted calibration never resolves on a raw score', () => {
  const decider = new CalibratedAbstainDecider();
  function untrustedResolved(top1: number): EntityResolveResult {
    return {
      status: 'resolved',
      candidates: [{ entityId: createEntityId('x'), canonicalLabel: 'X', calibratedScore: top1, rank: 1, evidenceRefs: [] }],
      topEntity: { entityId: createEntityId('x'), canonicalLabel: 'X', calibratedScore: top1 },
      decisionTrace: {
        queryClass: 'short_entity', top1CalibratedScore: top1, top2CalibratedScore: undefined,
        calibratedGap: undefined, decisionConfidenceC: top1, calibrationTrusted: false,
        ambiguityDetected: false, ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 }, outcomeReasonCodes: [],
      },
      conformalSetSize: 1,
    };
  }

  it.each([1.0, 1.5, 0.999, 5.0])('abstains for a self-normalized raw top1=%s with no exact evidence', (top1) => {
    const d = decider.decide(untrustedResolved(top1), 'short_entity', false);
    expect(d.status).toBe('ambiguous');
    expect(d.reasonCode).toBe('uncalibrated_low_trust');
  });

  it('resolves under untrusted calibration only with explicit exact evidence', () => {
    const d = decider.decide(untrustedResolved(0.6), 'short_entity', true);
    expect(d.status).toBe('resolved');
  });
});

// ── MED: bounded Korean grape regexes ─────────────────────────────────────────

describe('audit MED — Korean grape regexes are boundary-wrapped (no over-strip)', () => {
  it('strips a standalone grape token but NOT a grape substring inside another token', () => {
    // '시라' = Syrah (standalone) → concept; '시라소니'(lynx) merely contains 시라 → NOT stripped.
    expect(classifyConcept(makeViews('시라')).isConceptOnly).toBe(true);
    const inside = classifyConcept(makeViews('시라소니'));
    expect(inside.isConceptOnly).toBe(false);
    expect(inside.residual).toContain('시라소니');
  });

  it('does not strip "merlot" out of the middle of a token', () => {
    const c = classifyConcept(makeViews('merlotation'));
    expect(c.isConceptOnly).toBe(false);
    expect(c.residual).toContain('merlotation');
  });
});

// ── MED: accented / hyphenated concept phrases match the stripped view ────────

describe('audit MED — accented/hyphenated concept vocab matches normalized view', () => {
  it('redirects an accented + hyphenated region concept', () => {
    const gate = new ConceptAdmissionGate();
    const v = gate.classify({ rawQuery: 'Châteauneuf-du-Pape', views: makeViews('Châteauneuf-du-Pape') });
    expect(v.decision).toBe('redirect_discovery');
  });
});

// ── MED: max_candidates caps the response candidate list ──────────────────────

describe('audit MED — max_candidates caps the surfaced candidate list', () => {
  it('returns at most max_candidates candidates', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => createEntityId(`e-${i}`));
    const resolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'ambiguous',
        candidates: ids.map((id, i) => ({ entityId: id, canonicalLabel: `E${i}`, calibratedScore: 0.6 - i * 0.05, rank: i + 1, evidenceRefs: [] })),
        topEntity: undefined,
        decisionTrace: {
          queryClass: 'known-item', top1CalibratedScore: 0.6, top2CalibratedScore: 0.55,
          calibratedGap: 0.05, decisionConfidenceC: 0.6, calibrationTrusted: true,
          ambiguityDetected: true, ambiguityTypes: ['multi_vintage'],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 }, outcomeReasonCodes: ['ambiguous'],
        },
        conformalSetSize: 6,
      }),
    };
    const doc = (id: ReturnType<typeof createEntityId>) => ({ entityId: id, entityType: 'wine' as const, canonicalLabel: 'E' });
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'opus one', normalizedQuery: 'opus one', intent: 'known_item', route: 'entity',
        retrievalMode: 'entity_lookup', queryClass: 'known-item',
        anchors: [{ surfaceForm: 'opus one', normalizedForm: 'opus one', candidateEntityIds: ids, lookupStrategies: ['fuzzy_char_ngram'], confidence: 0.6 }],
        constraints: { hard: [], soft: [], inferred: [] }, expansions: { lexical: [], semantic: [] },
        policy: {}, uncertainty: {}, normalizedQueryViews: makeViews('opus one'),
        plannerVersion: '1', policyRuleVersion: '1', thresholdProfileId: 'default',
      }),
    };
    const useCase = new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      queryPlanner,
      entityResolver: resolver,
      entityLookup: {
        getDocument: vi.fn().mockImplementation(async (id) => doc(id)),
        getDocuments: vi.fn(async (xs: readonly ReturnType<typeof createEntityId>[]) => new Map(xs.map((id) => [id, doc(id)]))),
      },
      querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
    });

    const out = await useCase.execute({ query: 'opus one', maxCandidates: 3, mode: 'default' });
    expect(out.candidates.length).toBe(3);
    // candidate_pool_size still reports the FULL pool (honest)
    expect(out.evidenceSummary.candidatePoolSize).toBe(6);
  });
});
