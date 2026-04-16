/**
 * ADR-012 Phase 1b.2: LLM-backed topology planner for ConstraintGraph.
 *
 * Takes the deterministic atoms produced by ConstraintReasoner + the
 * normalized user query + optional decomposition hint, and asks an LLM
 * to emit AND/OR/XOR group structure, subquery scoping, and
 * cross-subquery edges. Returns `null` on any failure — the caller
 * (ConstraintCompiler) then falls back to the deterministic trivial
 * graph. This contract keeps the topology layer 100% optional.
 *
 * Determinism contract:
 *  - Temperature 0, `seed` pinned.
 *  - Frozen prompt with `promptVersion` emitted into the graph envelope.
 *  - Identical `{atoms, normalizedQuery}` → identical topology bytes
 *    (modulo `generatedAt` which is excluded from replay-hash comparison).
 *
 * Failure semantics (all → `null`):
 *  - LLM timeout, network error, upstream 5xx.
 *  - Non-JSON response.
 *  - Zod rejection against the output contract.
 *  - Empty-topology response (LLM says "no disjunction"; caller keeps trivial).
 *  - Disjoint-namespace violation (caller's `mergeTopologyIntoTrivial`
 *    also checks this; the planner itself filters at the input level).
 */

import { z } from 'zod';
import type { ChatLlmPort } from '../../ai/port/chat-llm.port.js';
import type { ConstraintAtom } from '../../shared/types/constraint-atom.js';
import type { QueryDecompositionHint } from '../model/query-decomposition.js';
import {
  CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
  type ConstraintGraph,
} from '../model/constraint-graph.js';
import {
  CTG_TOPOLOGY_PROMPT_VERSION,
  CTG_TOPOLOGY_SYSTEM_PROMPT,
  buildUserMessage,
} from './prompts/constraint-graph-topology.prompt.js';

/** Topology planner LLM call budget. */
const TOPOLOGY_MAX_OUTPUT_TOKENS = 1024;
/** Fixed seed pinned for replay stability. */
const TOPOLOGY_SEED = 1;
/** Upper bound on nodes / edges / children — mirrors `GRAPH_MAX_NODES` and
 *  `GRAPH_MAX_EDGES` from the graph model. Kept local so this file has no
 *  runtime dependency on the model's unexported constants. */
const TOPOLOGY_MAX_ARRAY_LEN = 1024;
/** Upper bound on identifier / label strings — mirrors `NODE_ID_MAX_LEN`. */
const TOPOLOGY_LABEL_MAX_LEN = 128;

/**
 * Keywords that open the LLM topology gate. Single source of truth —
 * additions require an ADR-012 amendment, not an ad-hoc edit.
 *
 * Rule 8 discipline: `[\p{L}\p{N}]`-based non-ASCII boundaries; `\b`
 * is unsafe on Korean. We match via `.includes()` for Korean syllables
 * (whole-character match is safe) and `\b` only on ASCII alternatives.
 */
const TOPOLOGY_INTENT_GATE_KEYWORDS_KO: readonly string[] = [
  '각각',
  '따로',
  '반반',
  '또는',
];

// Unicode-safe boundary per CLAUDE.md rule 8 — `\b` is ASCII-only and
// silently fails around non-ASCII letters. The negated letter/number
// character class below is Unicode-aware under the /u flag.
const TOPOLOGY_INTENT_GATE_KEYWORDS_EN_REGEX =
  /(?:^|[^\p{L}\p{N}])(?:either|or|one\s+[\p{L}\p{N}\s]*?\s+other)(?=$|[^\p{L}\p{N}])/iu;

export function isTopologyIntentGateOpen(input: {
  readonly normalizedQuery: string;
  readonly decompositionHint?: QueryDecompositionHint | undefined;
}): boolean {
  if (
    input.decompositionHint !== undefined &&
    input.decompositionHint.subQueryCount > 1
  ) {
    return true;
  }
  const q = input.normalizedQuery;
  for (const kw of TOPOLOGY_INTENT_GATE_KEYWORDS_KO) {
    if (q.includes(kw)) return true;
  }
  return TOPOLOGY_INTENT_GATE_KEYWORDS_EN_REGEX.test(q);
}

// ─── LLM response schema ──────────────────────────────────────────────────────

const TOPOLOGY_NODE_ID_PREFIX = 'topology/';
const SLOT_NODE_ID_PREFIX = 'slot-';

const TopologyNodeIdSchema = z
  .string()
  .min(1)
  .max(TOPOLOGY_LABEL_MAX_LEN)
  .refine((s) => s.startsWith(TOPOLOGY_NODE_ID_PREFIX), {
    message: 'Topology node ids MUST start with "topology/"',
  });

const ChildIdSchema = z
  .string()
  .min(1)
  .max(TOPOLOGY_LABEL_MAX_LEN)
  .refine(
    (s) => s.startsWith(TOPOLOGY_NODE_ID_PREFIX) || s.startsWith(SLOT_NODE_ID_PREFIX),
    { message: 'Children must reference topology/* or slot-* ids' },
  );

const LlmTopologyNodeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('group_and'),
      nodeId: TopologyNodeIdSchema,
      children: z.array(ChildIdSchema).max(TOPOLOGY_MAX_ARRAY_LEN),
    })
    .strict(),
  z
    .object({
      kind: z.literal('group_or'),
      nodeId: TopologyNodeIdSchema,
      children: z.array(ChildIdSchema).max(TOPOLOGY_MAX_ARRAY_LEN),
    })
    .strict(),
  z
    .object({
      kind: z.literal('group_xor'),
      nodeId: TopologyNodeIdSchema,
      children: z.array(ChildIdSchema).max(TOPOLOGY_MAX_ARRAY_LEN),
    })
    .strict(),
  z
    .object({
      kind: z.literal('subquery'),
      nodeId: TopologyNodeIdSchema,
      purpose: z.string().min(1).max(TOPOLOGY_LABEL_MAX_LEN),
      targetCardinality: z.number().int().nonnegative(),
    })
    .strict(),
]);

const LlmTopologyEdgeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('shares_budget'),
      from: TopologyNodeIdSchema,
      to: TopologyNodeIdSchema,
      resource: z.enum(['price_total', 'time', 'count']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('complements'),
      from: TopologyNodeIdSchema,
      to: TopologyNodeIdSchema,
      reason: z.enum(['meal_course', 'pairing', 'variety']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('depends_on'),
      from: TopologyNodeIdSchema,
      to: TopologyNodeIdSchema,
    })
    .strict(),
]);

const LlmTopologyResponseSchema = z
  .object({
    origin: z.enum(['planner_emitted', 'hybrid']),
    rootNodeId: TopologyNodeIdSchema,
    nodes: z.array(LlmTopologyNodeSchema).max(TOPOLOGY_MAX_ARRAY_LEN),
    edges: z.array(LlmTopologyEdgeSchema).max(TOPOLOGY_MAX_ARRAY_LEN),
    globalBudgets: z
      .object({
        priceTotal: z
          .object({
            currency: z.enum(['KRW', 'USD']),
            max: z.number().finite().nonnegative(),
          })
          .strict()
          .optional(),
        candidateCount: z.number().int().nonnegative().optional(),
        walltime: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ─── Planner ──────────────────────────────────────────────────────────────────

interface TopologyPlannerInput {
  readonly atoms: readonly ConstraintAtom[];
  readonly normalizedQuery: string;
  readonly decompositionHint?: QueryDecompositionHint | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  /**
   * Slot ids as produced by the deterministic trivial projector, in the
   * same order as `atoms`. The planner reuses these ids in its
   * `children` references rather than inventing new ones.
   */
  readonly slotIds: readonly string[];
}

export class ConstraintTopologyPlanner {
  constructor(private readonly chatLlm: ChatLlmPort) {}

  async plan(input: TopologyPlannerInput): Promise<ConstraintGraph | null> {
    if (!isTopologyIntentGateOpen({
      normalizedQuery: input.normalizedQuery,
      ...(input.decompositionHint !== undefined
        ? { decompositionHint: input.decompositionHint }
        : {}),
    })) {
      return null;
    }

    if (input.atoms.length !== input.slotIds.length) {
      return null;
    }

    const atomsForPrompt = input.atoms.map((atom, idx) => ({
      slotId: input.slotIds[idx] ?? '',
      attribute: atom.attribute,
      operator: atom.operator,
      value: atom.value,
      sourceTier: atom.source_tier,
    }));

    let result;
    try {
      result = await this.chatLlm.complete({
        messages: [
          { role: 'system', content: CTG_TOPOLOGY_SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildUserMessage({
              normalizedQuery: input.normalizedQuery,
              atoms: atomsForPrompt,
              ...(input.decompositionHint !== undefined
                ? {
                    decompositionHint: {
                      subQueryCount: input.decompositionHint.subQueryCount,
                      strategy: input.decompositionHint.strategy,
                    },
                  }
                : {}),
            }),
          },
        ],
        temperature: 0,
        maxOutputTokens: TOPOLOGY_MAX_OUTPUT_TOKENS,
        seed: TOPOLOGY_SEED,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      return null;
    }

    const validated = LlmTopologyResponseSchema.safeParse(parsed);
    if (!validated.success) {
      return null;
    }

    // Empty topology → planner abstained; caller keeps the trivial graph.
    if (validated.data.nodes.length === 0) {
      return null;
    }

    const rawBudgets = validated.data.globalBudgets;
    const globalBudgets =
      rawBudgets === undefined
        ? {}
        : {
            ...(rawBudgets.priceTotal !== undefined
              ? { priceTotal: rawBudgets.priceTotal }
              : {}),
            ...(rawBudgets.candidateCount !== undefined
              ? { candidateCount: rawBudgets.candidateCount }
              : {}),
            ...(rawBudgets.walltime !== undefined
              ? { walltime: rawBudgets.walltime }
              : {}),
          };

    return {
      graphSchemaVersion: CONSTRAINT_GRAPH_SCHEMA_VERSION_V1_1,
      origin: validated.data.origin,
      rootNodeId: validated.data.rootNodeId,
      nodes: validated.data.nodes,
      edges: validated.data.edges,
      globalBudgets,
      promptVersion: CTG_TOPOLOGY_PROMPT_VERSION,
      generatedAt: new Date().toISOString(),
      llmModel: result.model,
    };
  }
}
