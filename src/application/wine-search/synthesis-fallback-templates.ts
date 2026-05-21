/**
 * SynthesisRunner fallback templates — SSoT for deterministic Korean/English
 * answer strings used by the Plan-then-Execute synthesis runner.
 *
 * These strings are PORTED byte-for-byte from
 * `src/application/agent/agent-answer-recovery-policy.ts` so that the legacy
 * recovery policy and the new SynthesisRunner produce IDENTICAL output for the
 * same input. Behavioral parity is critical for golden-set / scorer tests that
 * pin exact answer strings.
 *
 * DO NOT paraphrase any of these strings. If a production template changes in
 * the source policy, update it here too (and in any test fixtures that assert
 * exact equality).
 *
 * Korean/English selection is governed by `containsHangul()` on the user
 * query — see `@shared/utils/hangul`.
 */

/**
 * Layer 3 grounding-preview slice cap: max characters of the last grounding
 * observation included verbatim when no structured GROUNDING_JSON marker is
 * present. Matches the legacy recovery policy
 * (`LAYER3_OBSERVATION_SLICE_CHARS`) within ±60 chars — kept at 240 for the
 * PtE runner where the preview path is preceded by a structured-LLM
 * synthesis attempt, so we can be slightly more conservative.
 */
export const LAYER3_OBSERVATION_SLICE_CHARS = 240;

/** Joiner used between producer and region in the Layer 2 detail clause. */
const LAYER2_DETAIL_JOINER = ', ';

function buildLayer2Detail(producer: string, region: string): string {
  const parts: string[] = [];
  if (producer.length > 0) parts.push(producer);
  if (region.length > 0) parts.push(region);
  return parts.join(LAYER2_DETAIL_JOINER);
}

function appendLayer2Detail(
  body: string,
  detail: string,
  suffix: string,
): string {
  return detail.length > 0
    ? `${body} (${detail}). ${suffix}`
    : `${body}. ${suffix}`;
}

/**
 * Production-pinned template strings. Each layer's Korean and English texts
 * are byte-identical to the existing AgentAnswerRecoveryPolicy emissions.
 */
export const FALLBACK_TEMPLATES = {
  layer2: {
    korean: (canonicalLabel: string, producer: string, region: string): string => {
      const detail = buildLayer2Detail(producer, region);
      return appendLayer2Detail(
        `검색 결과: ${canonicalLabel}`,
        detail,
        '(참고: 처리 제약으로 간단히 표시되었습니다.)',
      );
    },
    english: (canonicalLabel: string, producer: string, region: string): string => {
      const detail = buildLayer2Detail(producer, region);
      return appendLayer2Detail(
        `Based on your query, I found: ${canonicalLabel}`,
        detail,
        '(Note: simplified result due to processing constraints.)',
      );
    },
  },
  layer3: {
    korean: (preview: string): string => `검색 결과 요약: ${preview}`,
    english: (preview: string): string => `Search result summary: ${preview}`,
  },
  layer4: {
    korean: '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.',
    english: 'We could not process your wine query. Please try rephrasing or simplifying your search.',
  },
  policyBlocked: {
    korean: '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.',
    english: 'This request cannot be processed. Please ask a wine-related question.',
  },
  /**
   * Unsupported-intent (S1 semantic split): the orchestrator's deterministic
   * router could not derive a wine-search plan from the query (no anchors,
   * no constraints, intent=unknown — or admit-gate empty / too-long /
   * malformed). This is a vocabulary-coverage signal, NOT a security event.
   * The Korean / English copy explicitly nudges the user toward inputs the
   * planner can handle (entity name, region, price range, food pairing).
   */
  unsupportedIntent: {
    korean: '이 요청은 와인 검색으로 처리하기 어려워요. 와인 이름, 산지, 가격대, 음식 페어링 등을 알려주시면 도와드릴 수 있어요.',
    english: 'I could not handle this as a wine search. Please share details like wine name, region, price range, or food pairing so I can help.',
  },
  oodAlcohol: {
    korean: '저는 와인 중심으로만 도와드립니다. 맥주나 다른 주류 추천은 도와드리지 않고, 원하시면 취향에 맞는 와인으로 바로 추천해드릴게요.',
    english: 'I specialize in wine. I cannot help with beer or other spirits, but I can recommend a wine instead.',
  },
  unsupportedExternal: {
    korean: '저는 와인 중심으로 도와드립니다. 실시간 날씨 같은 외부 정보는 현재 확인할 수 없으니, 날씨 API나 실시간 검색으로 확인해 주세요.',
    english: 'I specialize in wine. I cannot verify real-time weather here, so please check a weather API or live search.',
  },
} as const;
