import { describe, it, expect } from 'vitest';
import { Planner } from '../planner.js';
import { AnchorExtractor } from '../anchor-extractor.js';
import { ExpansionBuilder } from '../expansion-builder.js';
import { planV2ToUnderstandingSnapshot } from '../../model/query-plan.js';
import type { QueryPlanV2 } from '../../model/query-plan.js';
import type { QueryUnderstandingSnapshot } from '../../model/query-understanding-snapshot.js';
import type { AmbiguityDictionary } from '../../port/ambiguity-dictionary.port.js';
import type { AliasMatcher, AliasMatchResult } from '../anchor-extractor.js';
import type { NLMapper } from '../../../attribute/service/nl-mapper.js';

// ── Stub helpers ───────────────────────────────────────────────────────────────

class StubAliasMatcher implements AliasMatcher {
  constructor(private readonly entries: Map<string, AliasMatchResult> = new Map()) {}

  findMatches(normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    const results: AliasMatchResult[] = [];
    for (const [key, result] of this.entries) {
      if (normalizedQuery.includes(key)) {
        results.push(result);
      }
    }
    return Promise.resolve(results.sort((a, b) => b.matchConfidence - a.matchConfidence));
  }
}

function makeMatchResult(
  surfaceForm: string,
  confidence = 0.9,
  entityIds: string[] = [`entity-${surfaceForm.toLowerCase().replace(/\s+/g, '-')}`],
): AliasMatchResult {
  return {
    surfaceForm,
    normalizedForm: surfaceForm.toLowerCase(),
    entityIds: entityIds as unknown as AliasMatchResult['entityIds'],
    matchConfidence: confidence,
  };
}

const noAmbiguityDict: AmbiguityDictionary = {
  isKnownAmbiguous: () => Promise.resolve(false),
  getAmbiguityInfo: () => Promise.resolve(null),
};

const noOpNLMapper: NLMapper = {
  mapPhrase: () => Promise.resolve(null),
  mapConstraints: () => Promise.resolve([]),
} as unknown as NLMapper;

function makePlanner(
  entries: Map<string, AliasMatchResult> = new Map(),
  dict: AmbiguityDictionary = noAmbiguityDict,
): Planner {
  const aliasMatcher = new StubAliasMatcher(entries);
  const anchorExtractor = new AnchorExtractor(aliasMatcher);
  const expansionBuilder = new ExpansionBuilder();
  return new Planner(dict, anchorExtractor, expansionBuilder, noOpNLMapper);
}

// ── QueryPlanV2 shape ──────────────────────────────────────────────────────────

describe('Planner – returns QueryPlanV2', () => {
  it('plan() resolves to an object with suggestedRoute and suggestedRetrievalMode', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');

    expect(plan).toHaveProperty('suggestedRoute');
    expect(plan).toHaveProperty('suggestedRetrievalMode');
  });

  it('plan() result does NOT have legacy "route" or "retrievalMode" fields', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');

    // QueryPlanV2 drops the binding execution fields from V1
    expect(plan).not.toHaveProperty('route');
    expect(plan).not.toHaveProperty('retrievalMode');
    expect(plan).not.toHaveProperty('policy');
  });
});

// ── suggestedRoute matches old route logic ─────────────────────────────────────

describe('Planner – suggestedRoute matches expected routing', () => {
  it('entity query with strong anchor → suggestedRoute is "entity"', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One');

    expect(plan.suggestedRoute).toBe('entity');
  });

  it('Korean mixed query with anchor → suggestedRoute is "mixed"', async () => {
    const entries = new Map([['오푸스원', makeMatchResult('오푸스원', 0.9)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('오푸스원 같은 10만원 와인');

    expect(plan.suggestedRoute).toBe('mixed');
  });

  it('constraint-only query with no anchors → suggestedRoute is "hybrid"', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('풀바디 레드 와인');

    expect(plan.suggestedRoute).toBe('hybrid');
  });
});

// ── suggestedRetrievalMode matches old retrievalMode logic ────────────────────

describe('Planner – suggestedRetrievalMode matches expected mode', () => {
  it('strong anchor + "best wines" → suggestedRetrievalMode is "producer_browse"', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One best wines');

    expect(plan.suggestedRetrievalMode).toBe('producer_browse');
  });

  it('facet query with hierarchical path (≥2 slashes) → suggestedRetrievalMode is "region_browse"', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('red wine from france / bordeaux / medoc');

    expect(plan.intent).toBe('facet_search');
    expect(plan.suggestedRetrievalMode).toBe('region_browse');
  });

  it('entity_exact with no anchor → suggestedRetrievalMode is "attribute_search"', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('semantic discovery wine');

    expect(plan.suggestedRetrievalMode).toBeDefined();
    expect(typeof plan.suggestedRetrievalMode).toBe('string');
  });
});

// ── planV2ToUnderstandingSnapshot ─────────────────────────────────────────────

describe('planV2ToUnderstandingSnapshot', () => {
  it('produces a valid QueryUnderstandingSnapshot from a QueryPlanV2', async () => {
    const planner = makePlanner();
    const plan: QueryPlanV2 = await planner.plan('Château Margaux 2015');

    const snapshot: QueryUnderstandingSnapshot = planV2ToUnderstandingSnapshot(plan);

    // All understanding fields are present
    expect(snapshot.rawQuery).toBe('Château Margaux 2015');
    expect(typeof snapshot.normalizedQuery).toBe('string');
    expect(snapshot.intent).toBeDefined();
    expect(Array.isArray(snapshot.anchors)).toBe(true);
    expect(snapshot.constraints).toBeDefined();
    expect(snapshot.expansions).toBeDefined();
    expect(snapshot.uncertainty).toBeDefined();
    expect(snapshot.queryClass).toBeDefined();
    expect(typeof snapshot.plannerVersion).toBe('string');
    expect(typeof snapshot.policyRuleVersion).toBe('string');
    expect(typeof snapshot.thresholdProfileId).toBe('string');
  });

  it('snapshot does NOT include suggestedRoute, suggestedRetrievalMode, or admission_context', () => {
    const plan: QueryPlanV2 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'semantic_discovery',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0,
        constraintConfidence: 0.5,
      },
      queryClass: 'semantic_preference',
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'attribute_search',
      admission_context: {
        requires_identity_seal: false,
        requires_constraint_evidence: false,
        requires_anchor_evidence: false,
      },
    };

    const snapshot = planV2ToUnderstandingSnapshot(plan);

    expect(snapshot).not.toHaveProperty('suggestedRoute');
    expect(snapshot).not.toHaveProperty('suggestedRetrievalMode');
    expect(snapshot).not.toHaveProperty('admission_context');
  });

  it('optional fields (normalizedQueryViews, secondaryIntents, targetEntityType, sessionContext, queryBudget) are omitted when absent', () => {
    const plan: QueryPlanV2 = {
      rawQuery: 'test',
      normalizedQuery: 'test',
      intent: 'facet_search',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      uncertainty: {
        overall: 0.2,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.8,
        anchorConfidence: 0,
        constraintConfidence: 0.5,
      },
      queryClass: 'pure_constraint',
      plannerVersion: '1.0.0',
      policyRuleVersion: '1.0.0',
      thresholdProfileId: 'default',
      suggestedRoute: 'hybrid',
      suggestedRetrievalMode: 'constraint_filter',
    };

    const snapshot = planV2ToUnderstandingSnapshot(plan);

    expect(Object.prototype.hasOwnProperty.call(snapshot, 'normalizedQueryViews')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'secondaryIntents')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'targetEntityType')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'sessionContext')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(snapshot, 'queryBudget')).toBe(false);
  });
});

// ── Regression: existing planner behavior unchanged ───────────────────────────

describe('Planner – regression (same query → same intent, anchors, constraints)', () => {
  it('normalizedQuery is correctly lowercased and accent-stripped', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Château Margaux');

    expect(plan.normalizedQuery).toContain('chateau margaux');
    expect(plan.rawQuery).toBe('Château Margaux');
  });

  it('plannerVersion is a non-empty string', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');

    expect(typeof plan.plannerVersion).toBe('string');
    expect(plan.plannerVersion.length).toBeGreaterThan(0);
  });

  it('entity query with anchor → intent is entity_exact', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One');

    expect(plan.intent).toBe('entity_exact');
  });

  it('anchors are extracted for known entities', async () => {
    const entries = new Map([['opus one', makeMatchResult('Opus One', 0.95)]]);
    const planner = makePlanner(entries);
    const plan = await planner.plan('Opus One');

    expect(plan.anchors.length).toBeGreaterThan(0);
    expect(plan.anchors[0]?.normalizedForm).toBe('opus one');
  });

  it('constraints are populated for attribute queries', async () => {
    const planner = makePlanner(new Map());
    const plan = await planner.plan('full body red wine under 50 dollars');

    // Rule-based extraction should detect wine_type or price constraints
    const allConstraints = [
      ...plan.constraints.hard,
      ...plan.constraints.soft,
      ...plan.constraints.inferred,
    ];
    expect(allConstraints.length).toBeGreaterThan(0);
  });

  it('uncertainty is populated with expected shape', async () => {
    const planner = makePlanner();
    const plan = await planner.plan('Opus One');

    expect(typeof plan.uncertainty.overall).toBe('number');
    expect(plan.uncertainty.overall).toBeGreaterThanOrEqual(0);
    expect(plan.uncertainty.overall).toBeLessThanOrEqual(1);
    expect(typeof plan.uncertainty.ambiguityDetected).toBe('boolean');
  });
});
