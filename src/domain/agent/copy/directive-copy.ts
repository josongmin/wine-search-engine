/**
 * Directive copy — single source of truth (SSoT) for the natural-language
 * strings that the agent layer and the wine-agent-loop runner inject into the
 * LLM context as authoritative directives.
 *
 * Rationale (CLAUDE.md rule 25 / 30): the same directive copy was previously
 * authored independently in two places:
 *   - `src/application/agent/agent-contract-policy.ts` (English-only,
 *     "grounded_search_required" and "required_tool" instruction strings).
 *   - `src/application/wine-search/wine-agent-loop-schemas.ts`
 *     (`WINE_AGENT_LOOP_DIRECTIVE_COPY_ENGLISH` + `WINE_AGENT_LOOP_DIRECTIVE_COPY_KOREAN`).
 *
 * The English variants are byte-identical. Drift would cause inconsistent
 * model behavior between the legacy agent loop and the new wine-agent-loop runner,
 * and would silently break unit tests that assert exact directive strings.
 *
 * The wine-agent-loop also owns Korean copy + the `relax_constraints_retry`,
 * `pending_drinkability_check`, `loop_detected` directives that the agent
 * contract policy does NOT use. We expose those here too so any future
 * consumer can pick the same canonical strings.
 *
 * SSoT placement (domain > application > infrastructure preference): the
 * strings describe a domain contract between the agent and the model; they
 * are not provider-specific. The `directive-copy.ts` module lives under
 * `src/domain/agent/copy/` so application-layer modules import from a
 * deeper-than-them layer (no circular dependency risk).
 */

const ENGLISH_GROUNDED_SEARCH_REQUIRED =
  'This request still requires a grounded wine search before answering. Call search_wines first and answer only from the returned evidence.';

const ENGLISH_RELAX_CONSTRAINTS_RETRY =
  'Search returned too few results. Relax one non-must-have constraint and call search_wines again.';

const ENGLISH_LOOP_DETECTED =
  'Loop detected: same or near-duplicate call recently. Try a different angle (different tool or different input).';

const KOREAN_GROUNDED_SEARCH_REQUIRED =
  '이 요청은 답변하기 전에 search_wines로 근거를 확보해야 합니다. 먼저 search_wines를 호출한 후 결과만으로 답하세요.';

const KOREAN_RELAX_CONSTRAINTS_RETRY =
  '검색 결과가 부족합니다. 필수 조건이 아닌 제약 중 하나를 완화해서 search_wines를 다시 호출하세요.';

const KOREAN_LOOP_DETECTED =
  '동일하거나 매우 유사한 호출이 감지되었습니다. 다른 각도(다른 도구·다른 입력)로 진행하세요.';

function buildEnglishRequiredToolInstruction(tool: string): string {
  return `This request requires ${tool} before answering. Call ${tool} first and answer only from the returned evidence.`;
}

function buildKoreanRequiredToolInstruction(tool: string): string {
  return `이 요청은 답변하기 전에 ${tool}을(를) 먼저 호출해야 합니다. 결과만으로 답하세요.`;
}

function buildEnglishPendingDrinkabilityInstruction(
  entityIds: readonly string[],
): string {
  return `Call check_drinking_window for the following entities before answering: ${entityIds
    .map((id) => `"${id}"`)
    .join(', ')}.`;
}

function buildKoreanPendingDrinkabilityInstruction(
  entityIds: readonly string[],
): string {
  return `다음 와인의 음용 적합 시기를 check_drinking_window로 확인한 뒤 답변하세요: ${entityIds
    .map((id) => `"${id}"`)
    .join(', ')}.`;
}

/**
 * Bundle of directive copy strings keyed by directive kind.
 *
 * Why this shape: the wine-agent-loop runner picks copy by `hangulDominant` and
 * calls per-directive accessors; the agent contract policy emits one
 * English directive at a time. Both call sites consume the same bundle.
 */
interface DirectiveCopy {
  /** `relax_constraints_retry` directive — instructs the model to drop a
   *  non-must-have constraint and retry `search_wines`. */
  readonly relax: string;
  /** `grounded_search_required` directive — requires a `search_wines` call
   *  before any answer. */
  readonly groundedSearch: string;
  /** `required_tool` directive — generic tool-required instruction. */
  readonly requiredTool: (tool: string) => string;
  /** `pending_drinkability_check` directive — instructs the model to call
   *  `check_drinking_window` for the listed entity ids. */
  readonly pendingDrinkability: (entityIds: readonly string[]) => string;
  /** `loop_detected` notice — instructs the model to vary its next call. */
  readonly loopDetected: string;
}

export const AGENT_DIRECTIVE_COPY: {
  readonly english: DirectiveCopy;
  readonly korean: DirectiveCopy;
} = {
  english: {
    relax: ENGLISH_RELAX_CONSTRAINTS_RETRY,
    groundedSearch: ENGLISH_GROUNDED_SEARCH_REQUIRED,
    requiredTool: buildEnglishRequiredToolInstruction,
    pendingDrinkability: buildEnglishPendingDrinkabilityInstruction,
    loopDetected: ENGLISH_LOOP_DETECTED,
  },
  korean: {
    relax: KOREAN_RELAX_CONSTRAINTS_RETRY,
    groundedSearch: KOREAN_GROUNDED_SEARCH_REQUIRED,
    requiredTool: buildKoreanRequiredToolInstruction,
    pendingDrinkability: buildKoreanPendingDrinkabilityInstruction,
    loopDetected: KOREAN_LOOP_DETECTED,
  },
} as const;
