import { z } from 'zod';
import type { AmbiguousEntityHint } from '../../attribute/model/ambiguous-entity-hint.js';
import type { ChatLlmPort } from '../../ai/port/chat-llm.port.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { QueryClass } from '../../shared/types/query-class.js';
import type {
  AmbiguityBranchSelection,
  AmbiguityIntentInterpretation,
  AmbiguityIntentTrace,
} from '../model/ambiguity-intent-interpretation.js';
import { QUERY_CLASSES, isQueryClass } from '../../shared/types/query-class.js';
import type { NormalizedConstraint } from '../../shared/types/index.js';
import { abortError, throwIfAborted } from '../../shared/cooperative-abort.js';
import { bootstrapLogger } from '../../../domain/shared/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'AmbiguityIntentCompiler' });

const AMBIGUITY_INTENT_COMPILER_VERSION = 'ambiguity-intent-compiler-v1.0';
const AMBIGUITY_INTENT_COMPILER_MAX_OUTPUT_TOKENS = 512;
const AMBIGUITY_INTENT_COMPILER_SEED = 1;
const AMBIGUITY_INTENT_COMPILER_TIMEOUT_MS = 4_000;
const CLARIFY_QUESTION_MAX_LEN = 160;
const RESPONSE_TEXT_PREVIEW_MAX_LEN = 200;

const AmbiguityBranchSelectionSchema = z.object({
  surface: z.string().min(1),
  entityType: z.string().min(1),
  decision: z.enum(['preserve_ambiguity', 'select_branches']),
  selectedBranchLabels: z.array(z.string().min(1)).max(8),
  resolvedQueryClass: z.string().optional(),
  clarifyQuestion: z.string().min(1).max(CLARIFY_QUESTION_MAX_LEN).optional(),
  confidence: z.number().finite().min(0).max(1),
}).strict();

const AmbiguityIntentResponseSchema = z.object({
  selections: z.array(AmbiguityBranchSelectionSchema).max(8),
}).strict();

type LlmAmbiguityBranchSelection = z.infer<typeof AmbiguityBranchSelectionSchema>;

export interface AmbiguityIntentCompilerInput {
  readonly rawQuery: string;
  readonly normalizedQuery: string;
  readonly intent: QueryIntent;
  readonly classifiedQueryClass: QueryClass;
  readonly constraints: {
    readonly hard: readonly NormalizedConstraint[];
    readonly soft: readonly NormalizedConstraint[];
  };
  readonly ambiguousEntityHints: readonly AmbiguousEntityHint[];
  readonly abortSignal?: AbortSignal | undefined;
}

interface AmbiguityIntentCompilerResult {
  readonly interpretation?: AmbiguityIntentInterpretation | undefined;
  readonly trace: AmbiguityIntentTrace;
}

const SYSTEM_PROMPT = `You are a wine search ambiguity intent compiler.

Your job is NOT to answer the query. Your job is to convert only the ambiguous entity-family evidence into a typed intent decision.

Rules:
- The deterministic parser already handled all obvious constraints.
- Only decide whether the ambiguous entity mention should remain ambiguous or be narrowed to specific candidate branches.
- Never invent a new branch label. You may only select from the provided branch labels.
- If the query still lacks enough evidence, return preserve_ambiguity.
- When selecting branches, prefer the smallest set that is strongly supported by the query context.
- resolvedQueryClass must be one of: ${QUERY_CLASSES.join(', ')}.
- Return JSON only.`;

function summarizeConstraints(constraints: readonly NormalizedConstraint[]): readonly {
  readonly attribute: string;
  readonly operator: string;
  readonly value: unknown;
}[] {
  return constraints.map((constraint) => ({
    attribute: constraint.attribute,
    operator: constraint.operator,
    value: constraint.value,
  }));
}

function buildUserPrompt(input: AmbiguityIntentCompilerInput): string {
  return JSON.stringify({
    rawQuery: input.rawQuery,
    normalizedQuery: input.normalizedQuery,
    intent: input.intent,
    classifiedQueryClass: input.classifiedQueryClass,
    deterministicConstraints: {
      hard: summarizeConstraints(input.constraints.hard),
      soft: summarizeConstraints(input.constraints.soft),
    },
    ambiguityCandidates: input.ambiguousEntityHints.map((hint) => ({
      surface: hint.surface,
      entityType: hint.entityType,
      retrievalConstraint: hint.retrievalConstraint,
      clarifyOptions: hint.clarifyOptions,
      branches: hint.explorationBranches.map((branch) => ({
        label: branch.label,
        softConstraint: branch.softConstraint,
        lexicalExpansions: branch.lexicalExpansions,
        semanticExpansions: branch.semanticExpansions,
      })),
    })),
    outputContract: {
      selections: [{
        surface: 'string',
        entityType: 'string',
        decision: 'preserve_ambiguity | select_branches',
        selectedBranchLabels: ['existing branch labels only'],
        resolvedQueryClass: 'valid query class',
        clarifyQuestion: 'optional question for unresolved ambiguity',
        confidence: '0..1',
      }],
    },
  });
}

function normalizeSelection(
  selection: LlmAmbiguityBranchSelection,
  hints: readonly AmbiguousEntityHint[],
): AmbiguityBranchSelection | null {
  const matchedHint = hints.find((hint) =>
    hint.surface === selection.surface
    && hint.entityType === selection.entityType,
  );
  if (matchedHint === undefined) {
    return null;
  }

  const availableLabels = new Set(matchedHint.explorationBranches.map((branch) => branch.label));
  const selectedBranchLabels = selection.selectedBranchLabels.filter((label) => availableLabels.has(label));
  const resolvedQueryClass = selection.resolvedQueryClass !== undefined && isQueryClass(selection.resolvedQueryClass)
    ? selection.resolvedQueryClass
    : undefined;

  if (selection.decision === 'select_branches' && selectedBranchLabels.length === 0) {
    return null;
  }

  return {
    surface: selection.surface,
    entityType: selection.entityType,
    decision: selection.decision,
    selectedBranchLabels,
    ...(resolvedQueryClass !== undefined ? { resolvedQueryClass } : {}),
    ...(selection.clarifyQuestion !== undefined ? { clarifyQuestion: selection.clarifyQuestion } : {}),
    confidence: selection.confidence,
  };
}

export class AmbiguityIntentCompiler {
  constructor(
    private readonly chatLlm: ChatLlmPort,
    private readonly timeoutMs: number = AMBIGUITY_INTENT_COMPILER_TIMEOUT_MS,
  ) {}

  async compile(input: AmbiguityIntentCompilerInput): Promise<AmbiguityIntentCompilerResult> {
    if (input.ambiguousEntityHints.length === 0) {
      return {
        trace: {
          source: 'not_applicable',
          latencyMs: null,
          branchSelectionCount: 0,
          selectedBranchCount: 0,
        },
      };
    }

    throwIfAborted(input.abortSignal, 'Ambiguity intent compilation aborted');
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const propagateAbort = (): void => controller.abort();
    input.abortSignal?.addEventListener('abort', propagateAbort, { once: true });

    try {
      const result = await this.chatLlm.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(input) },
        ],
        temperature: 0,
        seed: AMBIGUITY_INTENT_COMPILER_SEED,
        maxOutputTokens: AMBIGUITY_INTENT_COMPILER_MAX_OUTPUT_TOKENS,
        abortSignal: controller.signal,
      });

      const latencyMs = Date.now() - startedAt;
      let parsedText: unknown;
      try {
        parsedText = JSON.parse(result.text);
      } catch {
        log.warn(
          {
            textPreview: result.text.slice(0, RESPONSE_TEXT_PREVIEW_MAX_LEN),
          },
          '[AmbiguityIntentCompiler] Non-JSON response; ignoring compiler output',
        );
        return {
          trace: {
            source: 'llm_intent_compiler_invalid',
            compilerVersion: AMBIGUITY_INTENT_COMPILER_VERSION,
            latencyMs,
            branchSelectionCount: 0,
            selectedBranchCount: 0,
          },
        };
      }

      const parsed = AmbiguityIntentResponseSchema.safeParse(parsedText);
      if (!parsed.success) {
        log.warn(
          {
            issues: parsed.error.issues.map((issue) => issue.message),
          },
          '[AmbiguityIntentCompiler] Schema validation failed; ignoring compiler output',
        );
        return {
          trace: {
            source: 'llm_intent_compiler_invalid',
            compilerVersion: AMBIGUITY_INTENT_COMPILER_VERSION,
            latencyMs,
            branchSelectionCount: 0,
            selectedBranchCount: 0,
          },
        };
      }

      const branchSelections = parsed.data.selections
        .map((selection) => normalizeSelection(selection, input.ambiguousEntityHints))
        .filter((selection): selection is AmbiguityBranchSelection => selection !== null);

      if (branchSelections.length === 0) {
        return {
          trace: {
            source: 'llm_intent_compiler_empty',
            compilerVersion: AMBIGUITY_INTENT_COMPILER_VERSION,
            latencyMs,
            branchSelectionCount: 0,
            selectedBranchCount: 0,
          },
        };
      }

      const interpretation: AmbiguityIntentInterpretation = {
        source: 'llm_intent_compiler',
        compilerVersion: AMBIGUITY_INTENT_COMPILER_VERSION,
        branchSelections,
      };
      const queryClassOverride = branchSelections
        .map((selection) => selection.resolvedQueryClass)
        .find((queryClass): queryClass is QueryClass => queryClass !== undefined);

      return {
        interpretation,
        trace: {
          source: 'llm_intent_compiler',
          compilerVersion: AMBIGUITY_INTENT_COMPILER_VERSION,
          latencyMs,
          branchSelectionCount: branchSelections.length,
          selectedBranchCount: branchSelections.reduce((sum, selection) => sum + selection.selectedBranchLabels.length, 0),
          ...(queryClassOverride !== undefined ? { queryClassOverride } : {}),
        },
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw abortError('Ambiguity intent compilation aborted');
      }
      log.warn(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        '[AmbiguityIntentCompiler] LLM call failed; preserving deterministic ambiguity output',
      );
      return {
        trace: {
          source: 'llm_intent_compiler_error',
          compilerVersion: AMBIGUITY_INTENT_COMPILER_VERSION,
          latencyMs: Date.now() - startedAt,
          branchSelectionCount: 0,
          selectedBranchCount: 0,
        },
      };
    } finally {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener('abort', propagateAbort);
    }
  }
}
