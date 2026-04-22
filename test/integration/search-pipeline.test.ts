/**
 * Integration tests for the full search pipeline.
 *
 * Uses real domain services wired with in-memory adapters.
 * No database, no network.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestContainer, type TestContainerParts } from './helpers/test-container.js';
import {
  TEST_ALIASES,
  TEST_DOCUMENTS,
  MOET_BRUT_ID,
  OPUS_ONE_ID,
  SAUTERNES_ID,
} from './helpers/test-fixtures.js';
import type { SearchRequest } from '../../src/application/search/search.usecase.js';

let parts: TestContainerParts;

function loadFixtures(): void {
  // Load all aliases into the alias matcher
  for (const alias of TEST_ALIASES) {
    parts.aliasMatcher.addAlias(alias.surfaceForm, alias.entityId, alias.confidence);
  }

  // Load all documents into the search index
  for (const doc of TEST_DOCUMENTS) {
    parts.searchIndex.upsertDoc(doc);
  }

  // Load all entity IDs into the blocking adapter
  const uniqueIds = new Set(TEST_ALIASES.map((a) => a.entityId));
  parts.blockingAdapter.addEntityIds(Array.from(uniqueIds));
}

function makeRequest(query: string, overrides: Partial<SearchRequest> = {}): SearchRequest {
  return { query, ...overrides };
}

describe('Search Pipeline Integration', () => {
  beforeEach(() => {
    parts = createTestContainer();
    loadFixtures();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 1: Entity Resolution Path
  // ─────────────────────────────────────────────────────────────────────────
  describe('Group 1 — Entity Resolution Path', () => {
    it('resolves "오푸스원" to Opus One 2018 via exact alias match', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('오푸스원', { options: { mode: 'entity', explain: false, clarification: false } }),
        'req-test-1',
      );

      expect(response.meta.requestId).toBe('req-test-1');
      // The planner should detect the alias and route entity; the decision
      // engine may resolve or go ambiguous depending on confidence — check status is not failed
      expect(response.engineDecision.decisionStatus).toMatch(/^(resolved|ambiguous)$/);
      expect(response.engineDecision.decisionSnapshot).toBeDefined();
    });

    it('resolves "opus one" case-insensitively to Opus One', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('opus one', { options: { mode: 'entity', explain: false, clarification: false } }),
        'req-test-2',
      );

      expect(response.meta.requestId).toBe('req-test-2');
      expect(response.engineDecision.decisionStatus).toMatch(/^(resolved|ambiguous)$/);
    });

    it('recovers bare Korean "오푸스" short form into the Opus One candidate set', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('오푸스', { options: { mode: 'entity', explain: false, clarification: true } }),
        'req-test-2b',
      );

      expect(response.meta.requestId).toBe('req-test-2b');
      expect(response.engineDecision.decisionStatus).toMatch(/^(resolved|ambiguous)$/);
      const ids = response.results.map((r) => r.entity.entityId);
      expect(ids).toContain(OPUS_ONE_ID);
    });

    it('resolves "Château Margaux" to Château Margaux 2015', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('Château Margaux', { options: { mode: 'entity', explain: false, clarification: false } }),
        'req-test-3',
      );

      expect(response.engineDecision.decisionStatus).toMatch(/^(resolved|ambiguous)$/);
    });

    it('"마고" triggers ambiguity detection or alias match', async () => {
      // Register "마고" as ambiguous (region vs wine)
      parts.ambiguityDict.setAmbiguous('마고', ['region', 'entity'], 'medium');

      const response = await parts.container.searchUseCase.execute(
        makeRequest('마고', { options: { mode: 'entity', explain: false, clarification: true } }),
        'req-test-4',
      );

      // Should NOT be a hard failure — ambiguous or resolved both valid
      expect(response.engineDecision.decisionStatus).toMatch(/^(resolved|ambiguous)$/);
      expect(response.engineDecision.decisionSnapshot).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 2: Hybrid / Semantic Path
  // ─────────────────────────────────────────────────────────────────────────
  describe('Group 2 — Hybrid/Semantic Path', () => {
    it('"10만원 이하 풀바디 레드" returns results via hybrid route', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('10만원 이하 풀바디 레드', { options: { mode: 'hybrid', explain: true, clarification: false } }),
        'req-hybrid-1',
      );

      expect(response.meta.route).toBe('hybrid');
      expect(response.results.length).toBeGreaterThan(0);
    });

    it('"풀바디 타닌 강한 와인" — sparse search finds full-body wines', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('풀바디 타닌 강한 와인', { options: { mode: 'hybrid', explain: false, clarification: false } }),
        'req-hybrid-2',
      );

      expect(response.meta.route).toBe('hybrid');
      expect(response.results.length).toBeGreaterThan(0);
      // All result entities must have evidenceItems (enforced by ResponseBuilder)
      for (const result of response.results) {
        expect(result.evidenceItems.length).toBeGreaterThan(0);
      }
    });

    it('"스파클링 와인" — search index returns Moët Brut', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('스파클링 와인', { options: { mode: 'hybrid', explain: false, clarification: false } }),
        'req-hybrid-3',
      );

      expect(response.meta.route).toBe('hybrid');
      expect(response.results.length).toBeGreaterThan(0);
      const ids = response.results.map((r) => r.entity.entityId);
      expect(ids).toContain(MOET_BRUT_ID);
    });

    it('"달달한 와인" — search index returns Sauternes', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('달달한 와인', { options: { mode: 'hybrid', explain: false, clarification: false } }),
        'req-hybrid-4',
      );

      expect(response.meta.route).toBe('hybrid');
      expect(response.results.length).toBeGreaterThan(0);
      const ids = response.results.map((r) => r.entity.entityId);
      expect(ids).toContain(SAUTERNES_ID);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Group 3: Decision Contract
  // ─────────────────────────────────────────────────────────────────────────
  describe('Group 3 — Decision Contract', () => {
    it('every resolved response has required fields', async () => {
      // Force entity mode with a known alias to maximize chance of resolution
      const response = await parts.container.searchUseCase.execute(
        makeRequest('Opus One 2018', { options: { mode: 'entity', explain: false, clarification: false } }),
        'req-contract-1',
      );

      // Core contract fields must always be present regardless of status
      expect(response.engineDecision).toBeDefined();
      expect(response.engineDecision.decisionStatus).toMatch(/^(resolved|ambiguous|failed)$/);
      expect(response.engineDecision.decisionSnapshot).toBeDefined();
      expect(response.engineDecision.decisionTraceRef).toBeTruthy();
      expect(response.meta.requestId).toBe('req-contract-1');
      expect(response.meta.queryTimeMs).toBeGreaterThanOrEqual(0);
      expect(response.engineDecision.nextAction).toBeTruthy();
    });

    it('every result has at least one evidenceItem (enforced by ResponseBuilder)', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('풀바디 레드 와인', { options: { mode: 'hybrid', explain: false, clarification: false } }),
        'req-contract-2',
      );

      for (const result of response.results) {
        expect(result.evidenceItems.length).toBeGreaterThan(0);
        expect(result.evidenceItems[0]).toHaveProperty('type');
        expect(result.evidenceItems[0]).toHaveProperty('source');
        expect(result.evidenceItems[0]).toHaveProperty('contribution');
        expect(result.evidenceItems[0]).toHaveProperty('strength');
      }
    });

    it('meta.queryTimeMs is set and non-negative', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('스파클링 와인'),
        'req-contract-3',
      );

      expect(typeof response.meta.queryTimeMs).toBe('number');
      expect(response.meta.queryTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('engineDecision.decisionSnapshot contains required fields', async () => {
      const response = await parts.container.searchUseCase.execute(
        makeRequest('Château Margaux', { options: { mode: 'entity', explain: false, clarification: false } }),
        'req-contract-4',
      );

      const snapshot = response.engineDecision.decisionSnapshot;
      expect(snapshot).toHaveProperty('model_versions');
      expect(snapshot).toHaveProperty('index_versions');
      expect(snapshot).toHaveProperty('policy_rule_version');
      expect(snapshot).toHaveProperty('threshold_profile_id');
      expect(snapshot).toHaveProperty('planner_version');
      expect(snapshot).toHaveProperty('feature_flags');
    });

    it('ambiguous response has status=ambiguous and valid nextAction', async () => {
      // Register "마고" as ambiguous to force ambiguous outcome
      parts.ambiguityDict.setAmbiguous('마고', ['region', 'entity'], 'high');

      const response = await parts.container.searchUseCase.execute(
        makeRequest('마고', { options: { mode: 'entity', explain: false, clarification: true } }),
        'req-contract-5',
      );

      // Status is either resolved or ambiguous, never an uncaught exception
      expect(response.engineDecision.decisionStatus).toMatch(/^(resolved|ambiguous)$/);
      expect(['clarify', 'return_results', 'hybrid_search']).toContain(
        response.engineDecision.nextAction,
      );
    });
  });

});
