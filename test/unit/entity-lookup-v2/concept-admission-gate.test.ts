import { describe, expect, it, vi } from 'vitest';
import { ConceptAdmissionGate } from '../../../src/domain/resolver/v2/concept-admission-gate.js';
import { classifyConcept } from '../../../src/domain/resolver/v2/concept-lexicon.js';
import { EntityLookupV2UseCase } from '../../../src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import type { NormalizedQueryViews } from '../../../src/domain/query/model/query-views.js';
import type {
  EntityResolverPort,
  QueryPlannerPort,
} from '../../../src/application/search/port/search-pipeline-deps.port.js';

function makeViews(query: string): NormalizedQueryViews {
  const lower = query.toLowerCase();
  // Mimic the normalizer's vintageStripped: accentless, lower, vintage removed.
  const vintageStripped = lower.replace(/\b(19|20)\d{2}\b/gu, '').replace(/\s+/gu, ' ').trim();
  return {
    raw: query,
    strict: lower,
    accentless: lower,
    collapsedWhitespace: lower,
    punctuationStripped: lower,
    compact: lower.replace(/[^\p{L}\p{N}]/gu, ''),
    vintageCanonicalized: lower,
    vintageStripped,
    semanticVariants: [lower],
    lookupVariants: [lower],
  };
}

const gate = new ConceptAdmissionGate();

describe('ConceptAdmissionGate — concept/facet redirect (T-ELV2-02)', () => {
  it('redirects the 까쇼 grape shorthand to discovery (DoD §3)', () => {
    const v = gate.classify({ rawQuery: '까쇼', views: makeViews('까쇼') });
    expect(v.decision).toBe('redirect_discovery');
    expect(v.reasonCode).toBe('concept_query');
    expect(v.conceptTermsMatched).toContain('Cabernet Sauvignon');
  });

  it.each([
    ['Cabernet Sauvignon', 'Cabernet Sauvignon'],
    ['까베르네 소비뇽', 'Cabernet Sauvignon'],
    ['Pinot Noir', 'Pinot Noir'],
    ['메를로', 'Merlot'],
  ])('redirects bare grape concept %s', (query, grape) => {
    const v = gate.classify({ rawQuery: query, views: makeViews(query) });
    expect(v.decision).toBe('redirect_discovery');
    expect(v.conceptTermsMatched).toContain(grape);
  });

  it('redirects bare region / country concepts', () => {
    expect(gate.classify({ rawQuery: 'Napa Valley', views: makeViews('Napa Valley') }).decision).toBe('redirect_discovery');
    expect(gate.classify({ rawQuery: 'Bordeaux', views: makeViews('Bordeaux') }).decision).toBe('redirect_discovery');
  });

  it('redirects style / descriptor facet queries (EN + KO)', () => {
    expect(gate.classify({ rawQuery: 'full bodied red', views: makeViews('full bodied red') }).decision).toBe('redirect_discovery');
    expect(gate.classify({ rawQuery: '달콤한 화이트', views: makeViews('달콤한 화이트') }).decision).toBe('redirect_discovery');
  });

  it('redirects a bare generic non-entity query as generic (no concept term)', () => {
    const v = gate.classify({ rawQuery: 'wine', views: makeViews('wine') });
    expect(v.decision).toBe('redirect_discovery');
    expect(v.reasonCode).toBe('generic_non_entity_query');
  });

  it('ADMITS a producer + grape (residual proper-name token) — false-positive guard (rule 23)', () => {
    // "Caymus" is a producer, not a concept word → must NOT be swept up as concept.
    // "Cabernet" alone is intentionally ambiguous (Sauvignon vs Franc) and is
    // NOT a concept token; "Caymus" is a residual proper-name → admit.
    const v = gate.classify({ rawQuery: 'Caymus Cabernet Sauvignon', views: makeViews('Caymus Cabernet Sauvignon') });
    expect(v.decision).toBe('admit');
    expect(v.conceptTermsMatched).toContain('Cabernet Sauvignon');
  });

  it('ADMITS specific entity references incl. noisy typos (let the resolver close them)', () => {
    expect(gate.classify({ rawQuery: 'Opus One 2018', views: makeViews('Opus One 2018') }).decision).toBe('admit');
    expect(gate.classify({ rawQuery: '오푸스원', views: makeViews('오푸스원') }).decision).toBe('admit');
    // noisy typo "opu one" → admit (no concept token), resolver will fail/abstain
    expect(gate.classify({ rawQuery: 'opu one', views: makeViews('opu one') }).decision).toBe('admit');
    // famous producer
    expect(gate.classify({ rawQuery: 'Penfolds Grange', views: makeViews('Penfolds Grange') }).decision).toBe('admit');
  });

  it('rejects empty / under-specified before concept classification', () => {
    expect(gate.classify({ rawQuery: '', views: makeViews('') }).decision).toBe('reject');
    expect(gate.classify({ rawQuery: 'a', views: makeViews('a') }).decision).toBe('reject');
  });
});

describe('classifyConcept', () => {
  it('treats a vintage-only residual as concept (digits are not entity signal)', () => {
    // "Cabernet Sauvignon 2018" → grape concept + stray vintage digits stripped → concept-only
    const c = classifyConcept(makeViews('Cabernet Sauvignon 2018'));
    expect(c.isConceptOnly).toBe(true);
    expect(c.hasConceptTerm).toBe(true);
  });

  it('keeps a producer token as residual', () => {
    const c = classifyConcept(makeViews('Caymus Cabernet'));
    expect(c.isConceptOnly).toBe(false);
    expect(c.residual).toContain('caymus');
  });
});

// ── end-to-end: concept query must NOT reach the resolver ─────────────────────

describe('EntityLookupV2UseCase — concept admission short-circuit', () => {
  it('redirects 까쇼 to discovery without invoking the resolver', async () => {
    const resolver: EntityResolverPort = { resolve: vi.fn() };
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: '까쇼',
        normalizedQuery: '까쇼',
        intent: 'search',
        route: 'entity',
        retrievalMode: 'entity_lookup',
        queryClass: 'concept',
        anchors: [],
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {},
        normalizedQueryViews: makeViews('까쇼'),
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      }),
    };
    const useCase = new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      queryPlanner,
      entityResolver: resolver,
      querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
    });

    const out = await useCase.execute({ query: '까쇼', maxCandidates: 10, mode: 'default' });

    expect(out.status).toBe('redirect_discovery');
    expect(out.evidenceSummary.admissionReasonCode).toBe('concept_query');
    expect(out.topCandidate).toBeNull();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });
});
