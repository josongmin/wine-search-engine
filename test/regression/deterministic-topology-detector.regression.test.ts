/**
 * Wave F1 — DeterministicTopologyDetector regression lock.
 *
 * Pattern-based, LLM-free emission of XOR / multi-subquery topology.
 * This detector unlocks BundleSelector and the Axis 2 critic on real
 * user traffic without waiting for LLM credential rollout.
 *
 * Locks:
 *  - XOR on `또는` (Korean) across two wine_type hard atoms
 *  - XOR on `either ... or` (English, Unicode-safe boundary) across two
 *    wine_type hard atoms
 *  - `반반` → XOR
 *  - Multi-course pairing (`메인`, `디저트`) → subquery nodes + root group_and
 *  - English multi-course (`main course`, `dessert`) → subquery nodes
 *  - No-match query → null (caller falls back to trivial)
 *  - Empty atoms → null
 *  - XOR keyword present but only one wine_type atom → null (caller keeps trivial)
 *  - Multi-byte safety: pattern does NOT match `sworded` (substring false positive)
 *  - Output is a valid ConstraintGraph that `mergeTopologyIntoTrivial` accepts
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { DeterministicTopologyDetector } from '../../src/domain/query/service/deterministic-topology-detector.js';
import { buildTrivialGraphFromAtoms } from '../../src/domain/query/service/build-trivial-graph-from-atoms.js';
import { mergeTopologyIntoTrivial } from '../../src/domain/query/service/merge-topology-into-trivial.js';
import { liftBundleToAtoms } from '../../src/domain/shared/types/constraint-atom.js';
import type { ConstraintBundle } from '../../src/domain/shared/types/constraint-bundle.js';

function makeXorBundle(): ConstraintBundle {
  return {
    hard: [
      { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
      { attribute: 'wine_type', operator: '=', value: 'white', source_phrase: 'white', confidence: 1 },
    ],
    soft: [],
    inferred: [],
  };
}

function makeSingleTypeBundle(): ConstraintBundle {
  return {
    hard: [
      { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: 'red', confidence: 1 },
    ],
    soft: [],
    inferred: [],
  };
}

function slotIdsFor(bundle: ConstraintBundle): readonly string[] {
  const atoms = liftBundleToAtoms(bundle);
  const graph = buildTrivialGraphFromAtoms(atoms);
  return graph.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
}

describe('DeterministicTopologyDetector — XOR patterns', () => {
  it('emits group_xor on Korean 또는 with two wine_type atoms', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeXorBundle();
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: '레드 또는 화이트 와인 추천',
      slotIds,
    });

    expect(result).not.toBeNull();
    expect(result?.origin).toBe('planner_emitted');
    const xorNode = result?.nodes.find((n) => n.kind === 'group_xor');
    expect(xorNode).toBeDefined();
    expect(xorNode?.kind).toBe('group_xor');
    if (xorNode && xorNode.kind === 'group_xor') {
      expect(xorNode.children).toEqual(expect.arrayContaining([...slotIds]));
    }
  });

  it('emits group_xor on English `either ... or` across wine_type atoms', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeXorBundle();
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: 'either red or white wine',
      slotIds,
    });

    expect(result).not.toBeNull();
    const xor = result?.nodes.find((n) => n.kind === 'group_xor');
    expect(xor).toBeDefined();
  });

  it('emits group_xor on 반반', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeXorBundle();
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: '레드 화이트 반반',
      slotIds,
    });
    expect(result).not.toBeNull();
    expect(result?.nodes.some((n) => n.kind === 'group_xor')).toBe(true);
  });

  it('returns null when XOR keyword present but only one wine_type atom', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeSingleTypeBundle();
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: '또는 레드',
      slotIds,
    });
    expect(result).toBeNull();
  });
});

describe('DeterministicTopologyDetector — multi-course subquery patterns', () => {
  it('emits subquery nodes per Korean course (메인, 디저트)', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'price_total', operator: '<=', value: 100000, source_phrase: '10만원', confidence: 1 },
      ],
      soft: [],
      inferred: [],
    };
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: '메인에 고기 디저트에 초콜릿',
      slotIds,
    });

    expect(result).not.toBeNull();
    const subqueries = result?.nodes.filter((n) => n.kind === 'subquery') ?? [];
    expect(subqueries.length).toBeGreaterThanOrEqual(2);
    const andRoot = result?.nodes.find((n) => n.kind === 'group_and');
    expect(andRoot).toBeDefined();
  });

  it('emits subquery nodes per English course (main course, dessert)', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'price_total', operator: '<=', value: 200, source_phrase: 'under 200', confidence: 1 },
      ],
      soft: [],
      inferred: [],
    };
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: 'wine pairing for main course and dessert',
      slotIds,
    });
    expect(result).not.toBeNull();
    const subqueries = result?.nodes.filter((n) => n.kind === 'subquery') ?? [];
    expect(subqueries.length).toBeGreaterThanOrEqual(2);
  });
});

describe('DeterministicTopologyDetector — null branches', () => {
  it('returns null for plain non-XOR, non-course query', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeSingleTypeBundle();
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: 'recommend a red wine under 50',
      slotIds,
    });
    expect(result).toBeNull();
  });

  it('returns null on empty atoms', () => {
    const detector = new DeterministicTopologyDetector();
    const result = detector.detect({
      atoms: [],
      normalizedQuery: 'red or white',
      slotIds: [],
    });
    expect(result).toBeNull();
  });

  it('does NOT match English `or` embedded inside another word (sworded)', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeXorBundle();
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    // No standalone `or`/`either` here — only the substring inside `sworded`.
    const result = detector.detect({
      atoms,
      normalizedQuery: 'sworded red white wine',
      slotIds,
    });
    expect(result).toBeNull();
  });
});

// ─── Wave I1 — broadened lexicon integration ─────────────────────────────────

describe('DeterministicTopologyDetector — Wave I1 lexicon integration', () => {
  it('Korean negation XOR "보르도 말고 부르고뉴" + two region atoms → group_xor', () => {
    const detector = new DeterministicTopologyDetector();
    // We use a 2-atom wine_type bundle so the detector's XOR branch has
    // an attribute tier ≥2 to wrap; the lexicon match is the trigger.
    const bundle: ConstraintBundle = {
      hard: [
        { attribute: 'wine_type', operator: '=', value: 'red', source_phrase: '보르도', confidence: 1 },
        { attribute: 'wine_type', operator: '=', value: 'white', source_phrase: '부르고뉴', confidence: 1 },
      ],
      soft: [],
      inferred: [],
    };
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: '보르도 말고 부르고뉴',
      slotIds,
    });
    expect(result).not.toBeNull();
    expect(result?.nodes.some((n) => n.kind === 'group_xor')).toBe(true);
  });

  it('Korean negation XOR does NOT fire on 말고기 (horse meat) substring trap', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeXorBundle();
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      // No other XOR markers in this query — only the `말고` substring
      // inside `말고기`. Must NOT match.
      normalizedQuery: '말고기 페어링 red white',
      slotIds,
    });
    expect(result).toBeNull();
  });

  it('Korean 전식 본식 후식 통틀어 20만원 → multi-course + shares_budget edges', () => {
    const detector = new DeterministicTopologyDetector();
    const result = detector.detect({
      atoms: [],
      normalizedQuery: '전식 본식 후식 통틀어 20만원',
      slotIds: [],
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    const subqueries = result.nodes.filter((n) => n.kind === 'subquery');
    expect(subqueries).toHaveLength(3);
    // C(3,2) = 3 pairwise shares_budget edges.
    expect(result.edges).toHaveLength(3);
    expect(result.edges.every((e) => e.kind === 'shares_budget')).toBe(true);
    // Canonical purposes ordered: appetizer, main_course, dessert.
    const purposes = subqueries.map((n) =>
      n.kind === 'subquery' ? n.purpose : null,
    );
    expect(purposes).toEqual(['appetizer', 'main_course', 'dessert']);
  });

  it('English "cheese course and main dish, budget of $200" → multi-course + shares_budget', () => {
    const detector = new DeterministicTopologyDetector();
    const result = detector.detect({
      atoms: [],
      normalizedQuery: 'cheese course and main dish, budget of $200',
      slotIds: [],
    });
    expect(result).not.toBeNull();
    if (result === null) return;
    const subqueries = result.nodes.filter((n) => n.kind === 'subquery');
    expect(subqueries).toHaveLength(2);
    // 2 subqueries → 1 pairwise shares_budget edge.
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.kind).toBe('shares_budget');
    // Canonical ordering: main_course before dessert (cheese course
    // canonicalizes to dessert per the 3-bucket vocabulary).
    const purposes = subqueries.map((n) =>
      n.kind === 'subquery' ? n.purpose : null,
    );
    expect(purposes).toEqual(['main_course', 'dessert']);
  });

  it('English disjunction "red and/or white" fires XOR branch with 2 wine_type atoms', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeXorBundle();
    const atoms = liftBundleToAtoms(bundle);
    const slotIds = slotIdsFor(bundle);
    const result = detector.detect({
      atoms,
      normalizedQuery: 'red and/or white wine',
      slotIds,
    });
    expect(result).not.toBeNull();
    expect(result?.nodes.some((n) => n.kind === 'group_xor')).toBe(true);
  });
});

describe('DeterministicTopologyDetector — merge compatibility', () => {
  it('output merges cleanly into trivial graph via mergeTopologyIntoTrivial', () => {
    const detector = new DeterministicTopologyDetector();
    const bundle = makeXorBundle();
    const atoms = liftBundleToAtoms(bundle);
    const trivial = buildTrivialGraphFromAtoms(atoms);
    const slotIds = trivial.nodes.filter((n) => n.kind === 'slot').map((n) => n.nodeId);
    const detected = detector.detect({
      atoms,
      normalizedQuery: '레드 또는 화이트',
      slotIds,
    });
    expect(detected).not.toBeNull();
    const merged = mergeTopologyIntoTrivial(trivial, detected!);
    expect(merged).not.toBeNull();
    // Wave F1 contract: merge preserves topology origin. Deterministic
    // detector outputs `'planner_emitted'`; LLM outputs their own label.
    expect(merged?.origin).toBe('planner_emitted');
    // Merged graph root must be a topology node.
    expect(merged?.rootNodeId.startsWith('topology/')).toBe(true);
  });
});
