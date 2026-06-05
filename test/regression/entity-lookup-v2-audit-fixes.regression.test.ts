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
import { anchorsHaveExactIdentityEvidence, buildChannelHitsForEntity } from '../../src/domain/resolver/v2/channel-provenance.js';
import { ConceptAdmissionGate } from '../../src/domain/resolver/v2/concept-admission-gate.js';
import { EntityLookupV2UseCase } from '../../src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { NormalizedQueryViews } from '../../src/domain/query/model/query-views.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type {
  EntityResolverPort,
} from '../../src/application/search/port/search-pipeline-deps.port.js';
import type { LookupPlannerPort } from '../../src/application/search/entity-lookup-v2/lookup-planner.port.js';

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
    const d = decider.decide(untrustedResolved(top1), 'short_entity', 'recall_only');
    expect(d.status).toBe('ambiguous');
    expect(d.reasonCode).toBe('uncalibrated_low_trust');
  });

  it('resolves under untrusted calibration only with explicit exact evidence', () => {
    const d = decider.decide(untrustedResolved(0.6), 'short_entity', 'identity_grade');
    expect(d.status).toBe('resolved');
  });
});

describe('audit HIGH — trusted calibration still requires identity-grade evidence', () => {
  function trustedUseCase(strategy: string): EntityLookupV2UseCase {
    const eid = createEntityId('vinas-mora');
    const resolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [{ entityId: eid, canonicalLabel: '2022 Vinas Mora kaamen III', calibratedScore: 1.0, rank: 1, evidenceRefs: [] }],
        topEntity: { entityId: eid, canonicalLabel: '2022 Vinas Mora kaamen III', calibratedScore: 1.0 },
        decisionTrace: {
          queryClass: 'short_entity', top1CalibratedScore: 1.0, top2CalibratedScore: 0.25,
          calibratedGap: 0.75, decisionConfidenceC: 1.0, calibrationTrusted: true,
          ambiguityDetected: false, ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 }, outcomeReasonCodes: ['CONFIDENCE_ABOVE_THRESHOLD'],
        },
        conformalSetSize: 1,
      }),
    };
    const doc = { entityId: eid, entityType: 'wine' as const, canonicalLabel: '2022 Vinas Mora kaamen III' };
    const lookupPlanner: LookupPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'vina espectro', normalizedQuery: 'vina espectro', intent: 'known_item', route: 'entity',
        retrievalMode: 'entity_lookup', queryClass: 'short_entity',
        anchors: [{ surfaceForm: 'vina espectro', normalizedForm: 'vina espectro', candidateEntityIds: [eid], lookupStrategies: [strategy], confidence: 1.0 }],
        constraints: { hard: [], soft: [], inferred: [] }, expansions: { lexical: [], semantic: [] },
        policy: {}, uncertainty: {}, normalizedQueryViews: makeViews('vina espectro'),
        plannerVersion: '1', policyRuleVersion: '1', thresholdProfileId: 'default',
      } as never),
    };
    return new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      lookupPlanner,
      entityResolver: resolver,
      entityLookup: {
        getDocument: vi.fn().mockResolvedValue(doc),
        getDocuments: vi.fn().mockResolvedValue(new Map([[eid, doc]])),
      },
      querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
    });
  }

  it('FAILS closed when trusted top candidate is supported only by fuzzy recall', async () => {
    const out = await trustedUseCase('fuzzy_char_ngram').execute({ query: 'vina espectro', maxCandidates: 5, mode: 'default' });
    expect(out.status).toBe('failed');
    expect(out.evidenceSummary.decisionReasonCode).toBe('recall_only_no_match');
  });

  it('RESOLVES when trusted top candidate carries identity-grade evidence', async () => {
    const out = await trustedUseCase('compact_exact').execute({ query: 'vina espectro', maxCandidates: 5, mode: 'default' });
    expect(out.status).toBe('resolved');
  });
});

// ── MED: bounded Korean grape regexes ─────────────────────────────────────────

describe('audit MED/R2 — script-aware concept boundaries', () => {
  it('does not strip a LATIN grape out of the middle of a token (merlot ⊄ merlotation)', () => {
    const c = classifyConcept(makeViews('merlotation'));
    expect(c.isConceptOnly).toBe(false);
    expect(c.residual).toContain('merlotation');
  });

  it('treats a standalone Korean grape as concept but still admits a producer token that contains it', () => {
    // '시라'(Syrah) standalone → concept; '시라소니' agglutinates 시라 — it gets
    // stripped (Korean has no inter-morpheme space) but the residual '소니'
    // remains, so the query still ADMITS (no false redirect_discovery).
    expect(classifyConcept(makeViews('시라')).isConceptOnly).toBe(true);
    const inside = classifyConcept(makeViews('시라소니'));
    expect(inside.isConceptOnly).toBe(false);
    expect(inside.residual).toContain('소니');
  });

  it('R2: detects AGGLUTINATED Korean concept compounds (까쇼와인, 레드와인) — DoD §3 restored', () => {
    expect(classifyConcept(makeViews('까쇼와인')).isConceptOnly).toBe(true);
    expect(classifyConcept(makeViews('레드와인')).isConceptOnly).toBe(true);
    const gate = new ConceptAdmissionGate();
    expect(gate.classify({ rawQuery: '까쇼와인', views: makeViews('까쇼와인') }).decision).toBe('redirect_discovery');
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
    const lookupPlanner: LookupPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'opus one', normalizedQuery: 'opus one', intent: 'known_item', route: 'entity',
        retrievalMode: 'entity_lookup', queryClass: 'known-item',
        anchors: [{ surfaceForm: 'opus one', normalizedForm: 'opus one', candidateEntityIds: ids, lookupStrategies: ['exact'], confidence: 0.97 }],
        constraints: { hard: [], soft: [], inferred: [] }, expansions: { lexical: [], semantic: [] },
        policy: {}, uncertainty: {}, normalizedQueryViews: makeViews('opus one'),
        plannerVersion: '1', policyRuleVersion: '1', thresholdProfileId: 'default',
      } as never),
    };
    const useCase = new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      lookupPlanner,
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
    // R2: the display cap must NOT starve clarification — built from the full set.
    expect(out.clarificationOptions.length).toBe(6);
  });
});

// ── R2 HIGH: untrusted resolve requires STRICT exact-identity strategy ────────

describe('audit R2 HIGH — untrusted resolve is not forgeable by a recall strategy', () => {
  function untrustedUseCase(strategy: string): EntityLookupV2UseCase {
    const eid = createEntityId('chateau-margaux');
    const resolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [{ entityId: eid, canonicalLabel: 'Chateau Margaux', calibratedScore: 1.0, rank: 1, evidenceRefs: [] }],
        topEntity: { entityId: eid, canonicalLabel: 'Chateau Margaux', calibratedScore: 1.0 },
        decisionTrace: {
          queryClass: 'short_entity', top1CalibratedScore: 1.0, top2CalibratedScore: undefined,
          calibratedGap: undefined, decisionConfidenceC: 1.0, calibrationTrusted: false,
          ambiguityDetected: false, ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 }, outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      }),
    };
    const doc = { entityId: eid, entityType: 'wine' as const, canonicalLabel: 'Chateau Margaux' };
    const lookupPlanner: LookupPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'margaux', normalizedQuery: 'margaux', intent: 'known_item', route: 'entity',
        retrievalMode: 'entity_lookup', queryClass: 'short_entity',
        anchors: [{ surfaceForm: 'margaux', normalizedForm: 'margaux', candidateEntityIds: [eid], lookupStrategies: [strategy], confidence: 0.97 }],
        constraints: { hard: [], soft: [], inferred: [] }, expansions: { lexical: [], semantic: [] },
        policy: {}, uncertainty: {}, normalizedQueryViews: makeViews('margaux'),
        plannerVersion: '1', policyRuleVersion: '1', thresholdProfileId: 'default',
      } as never),
    };
    return new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      lookupPlanner,
      entityResolver: resolver,
      entityLookup: {
        getDocument: vi.fn().mockResolvedValue(doc),
        getDocuments: vi.fn().mockResolvedValue(new Map([[eid, doc]])),
      },
      querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
    });
  }

  it('FAILS closed when untrusted top candidate has only a lexical_exact (recall) strategy', async () => {
    const out = await untrustedUseCase('lexical_exact').execute({ query: 'margaux', maxCandidates: 5, mode: 'default' });
    expect(out.status).toBe('failed');
    expect(out.evidenceSummary.decisionReasonCode).toBe('recall_only_no_match');
  });

  it('RESOLVES when untrusted top candidate has a strict exact strategy', async () => {
    const out = await untrustedUseCase('exact').execute({ query: 'margaux', maxCandidates: 5, mode: 'default' });
    expect(out.status).toBe('resolved');
  });
});

// ── R5: empty anchor form must not emit a schema-invalid channel hit ─────────

describe('audit R5 — empty anchor form does not produce a wire-invalid hit', () => {
  it('skips an anchor with empty normalizedForm and omits empty matchedAlias', () => {
    const eid = createEntityId('opus-one-2018');
    // empty normalizedForm → hit skipped entirely
    expect(buildChannelHitsForEntity(eid, 1, [{ surfaceForm: 'x', normalizedForm: '', candidateEntityIds: [eid], lookupStrategies: ['exact'], confidence: 0.95 }], false)).toHaveLength(0);
    // empty surfaceForm → matchedAlias omitted (not '')
    const hits = buildChannelHitsForEntity(eid, 1, [{ surfaceForm: '', normalizedForm: 'opus one', candidateEntityIds: [eid], lookupStrategies: ['exact'], confidence: 0.95 }], false);
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedAlias).toBeUndefined();
    expect(hits[0].matchedView).toBe('opus one');
  });
});

// ── R3: fuzzy-fallback anchor must NOT forge exact-identity evidence ──────────

describe('audit R3 — fuzzy-fallback anchor cannot forge exact identity', () => {
  const eid = createEntityId('opus-one-2018');
  const anchorWith = (strategies: string[], confidence: number) => [{
    surfaceForm: 'opu one', normalizedForm: 'opu one', candidateEntityIds: [eid],
    lookupStrategies: strategies, confidence,
  }];

  it('rejects an anchor carrying both `exact` and a fuzzy marker (opu one → opus one)', () => {
    // The planner copies a bare `exact` (matched on the CORRECTED term) onto a
    // fuzzy-fallback anchor; this must NOT count as exact identity.
    expect(anchorsHaveExactIdentityEvidence(eid, anchorWith(['exact', 'fuzzy_match_fallback'], 0.873))).toBe(false);
  });

  it('accepts a genuine non-fuzzy exact anchor', () => {
    expect(anchorsHaveExactIdentityEvidence(eid, anchorWith(['exact'], 0.97))).toBe(true);
  });

  it('rejects recall strategies that merely contain the word exact/alias', () => {
    expect(anchorsHaveExactIdentityEvidence(eid, anchorWith(['lexical_exact'], 0.97))).toBe(false);
    expect(anchorsHaveExactIdentityEvidence(eid, anchorWith(['prefix_exact'], 0.97))).toBe(false);
    expect(anchorsHaveExactIdentityEvidence(eid, anchorWith(['inexact_alias'], 0.97))).toBe(false);
  });
});

// ── R3: concept-lexicon Korean spelling / josa / numeric brand ───────────────

describe('audit R3 — concept-lexicon Korean spelling + josa + numeric brand', () => {
  const gate = new ConceptAdmissionGate();

  it('redirects the standard ㅋ Korean Cabernet spelling 카베르네 (SSoT fix)', () => {
    expect(classifyConcept(makeViews('카베르네 소비뇽')).isConceptOnly).toBe(true);
    expect(gate.classify({ rawQuery: '카베르네 소비뇽', views: makeViews('카베르네 소비뇽') }).decision).toBe('redirect_discovery');
  });

  it('redirects a particle-suffixed concept query (까쇼는)', () => {
    expect(classifyConcept(makeViews('까쇼는')).isConceptOnly).toBe(true);
  });

  it('ADMITS pure-numeric wine brands (1865, 707) — not stray vintages', () => {
    expect(gate.classify({ rawQuery: '1865', views: makeViews('1865') }).decision).toBe('admit');
    expect(gate.classify({ rawQuery: '707', views: makeViews('707') }).decision).toBe('admit');
  });
});

// ── R4: recommendation-verb leak + bare-count residual ───────────────────────

describe('audit R4 — recommendation verbs & bare counts redirect (single-pass strip)', () => {
  const gate = new ConceptAdmissionGate();

  it('redirects agglutinated Korean recommendation queries (추천해줘 wins over 추천)', () => {
    for (const q of ['와인 추천해줘', '레드와인 추천해줘', '추천해줘', '추천해']) {
      expect(gate.classify({ rawQuery: q, views: makeViews(q) }).decision).toBe('redirect_discovery');
    }
  });

  it('redirects a concept + bare small count (까쇼 3) but still admits a numeric brand (1865)', () => {
    expect(classifyConcept(makeViews('까쇼 3')).isConceptOnly).toBe(true);
    expect(gate.classify({ rawQuery: '1865', views: makeViews('1865') }).decision).toBe('admit');
  });

  it('still admits a real producer (does not over-strip recommendation syllables)', () => {
    // Penfolds Grange must NOT be swept up by the recommendation-verb vocab.
    expect(gate.classify({ rawQuery: 'Penfolds Grange', views: makeViews('Penfolds Grange') }).decision).toBe('admit');
  });
});
