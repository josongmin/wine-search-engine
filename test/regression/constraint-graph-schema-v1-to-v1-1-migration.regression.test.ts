/**
 * ADR-012 Phase 1b.2: ConstraintGraph envelope schema v1 → v1.1.
 *
 * v1.1 is a pure superset of v1 — every v1 JSON parses under v1.1 Zod
 * unchanged. LLM-sourced graphs add `promptVersion` / `generatedAt` /
 * `llmModel` optional replay metadata. Unknown `graphSchemaVersion`
 * strings fail closed.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  CONSTRAINT_GRAPH_SCHEMA_VERSION,
  CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
  ConstraintGraphSchema,
} from '../../src/domain/query/model/constraint-graph.js';

function v1TrivialEnvelope() {
  return {
    graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION,
    origin: 'deterministic_from_atoms' as const,
    rootNodeId: 'root',
    nodes: [{ kind: 'group_and' as const, nodeId: 'root', children: [] }],
    edges: [] as const,
    globalBudgets: {},
  };
}

function v11HybridEnvelope() {
  return {
    graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
    origin: 'hybrid' as const,
    rootNodeId: 'topology/root',
    nodes: [
      { kind: 'group_xor' as const, nodeId: 'topology/root', children: [] },
    ],
    edges: [] as const,
    globalBudgets: {},
    promptVersion: 'ctg_topology_v1',
    generatedAt: '2026-04-15T10:00:00.000Z',
    llmModel: 'claude-opus-4-6',
  };
}

describe('ConstraintGraph schema v1 → v1.1 migration', () => {
  it('v1 envelope still parses under v1.1 Zod (no required new field)', () => {
    const parsed = ConstraintGraphSchema.safeParse(v1TrivialEnvelope());
    expect(parsed.success).toBe(true);
  });

  it('v1.1 envelope with replay metadata parses', () => {
    const parsed = ConstraintGraphSchema.safeParse(v11HybridEnvelope());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.promptVersion).toBe('ctg_topology_v1');
      expect(parsed.data.llmModel).toBe('claude-opus-4-6');
    }
  });

  it('v1 literal still recognised by value (regression guard)', () => {
    expect(CONSTRAINT_GRAPH_SCHEMA_VERSION).toBe('constraint_graph_v1');
    expect(CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1).toBe('constraint_graph_v1.1');
  });

  it('unknown graphSchemaVersion fails closed', () => {
    const bad = { ...v1TrivialEnvelope(), graphSchemaVersion: 'constraint_graph_v99' };
    expect(ConstraintGraphSchema.safeParse(bad).success).toBe(false);
  });

  it('round-trip preserves promptVersion', () => {
    const envelope = v11HybridEnvelope();
    const parsed = ConstraintGraphSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const serialised = JSON.stringify(parsed.data);
      const reparsed = ConstraintGraphSchema.safeParse(JSON.parse(serialised));
      expect(reparsed.success).toBe(true);
      if (reparsed.success) {
        expect(reparsed.data.promptVersion).toBe(envelope.promptVersion);
      }
    }
  });

  it('replay metadata fields are individually optional (omit any subset)', () => {
    const onlyPrompt = {
      ...v1TrivialEnvelope(),
      graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
      promptVersion: 'ctg_topology_v1',
    };
    expect(ConstraintGraphSchema.safeParse(onlyPrompt).success).toBe(true);

    const onlyModel = {
      ...v1TrivialEnvelope(),
      graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
      llmModel: 'claude-opus-4-6',
    };
    expect(ConstraintGraphSchema.safeParse(onlyModel).success).toBe(true);
  });
});
