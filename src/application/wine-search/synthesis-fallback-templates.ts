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
 *
 * In addition to L2/L3/L4 fallback strings, this module also owns the
 * S3 grounding-verify RE-SYNTH DIRECTIVE template ({@link buildResynthDirective})
 * and its bounding constants. Keeping every synthesis-stage prompt/template in
 * one SSoT module makes it possible to (a) audit every LLM-facing string in
 * one place, (b) version templates via {@link RESYNTH_DIRECTIVE_VERSION} when
 * wording changes affect bench/golden behaviour, and (c) prevent template
 * drift from inline-defined strings scattered across the runner.
 */

import type { GroundingFacts } from './synthesis-grounding-verify.js';

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
  /**
   * Wave 1 (Cluster F) corpus-gap admission: the planner extracted a
   * high-confidence anchor (e.g. "Sassicaia") but the resolver returned
   * 0 candidates — the requested entity is not in our catalogue.
   * Clarification cannot help here (the user did not under-specify; the
   * entity does not exist in the corpus), so the synthesizer emits this
   * honest admission instead of a "please clarify" prompt. The Korean copy
   * nudges the user toward an actionable next step (recommendation /
   * adjacent search) without pretending we have data we do not.
   */
  corpusGapAdmission: {
    korean: '요청하신 와인은 현재 저희 카탈로그에서 찾지 못했어요. 비슷한 스타일의 와인을 추천해 드릴까요? 산지, 가격대, 음식 페어링 등을 알려주시면 도와드릴 수 있어요.',
    english: 'We could not find that wine in our catalogue. Would you like us to recommend a similar wine instead? Share details like region, price range, or food pairing and we can help.',
  },
} as const;

// ---------------------------------------------------------------------------
// S3 grounding-verify: re-synth directive template (moved from
// synthesis-runner.ts so every synthesis-stage LLM-facing string lives in
// this SSoT module).
// ---------------------------------------------------------------------------

/**
 * Template version for {@link buildResynthDirective}. Bumped whenever the
 * directive wording changes in a way that could shift LLM behaviour (and
 * therefore bench / golden-set scores). Consumers MAY log this with re-synth
 * attempts so operators can correlate wording revisions with metrics.
 */
export const RESYNTH_DIRECTIVE_VERSION = 'v1' as const;

/** Maximum number of ungrounded-claim surfaces named in the re-synth
 *  directive. Bounds prompt growth on pathological answers. */
export const RESYNTH_MAX_LISTED_CLAIMS = 5;

/** Maximum number of grounded wine labels enumerated in the re-synth directive.
 *  Bounds prompt growth while giving the model a concrete set to re-anchor on. */
export const RESYNTH_MAX_LISTED_LABELS = 8;

/** Maximum number of grounded regions sampled into the re-synth directive.
 *  Kept small — regions are a re-anchoring hint, not an exhaustive listing. */
export const RESYNTH_MAX_LISTED_REGIONS = 4;

/** Maximum number of grounded grape varietals sampled into the re-synth
 *  directive. Same bounding rationale as {@link RESYNTH_MAX_LISTED_REGIONS}. */
export const RESYNTH_MAX_LISTED_GRAPES = 4;

/**
 * S3 grounding-verify: build the directive appended to the re-synth request
 * when the primary answer asserted ungrounded claims.
 *
 * A3 hardening — the directive is now ADDITIVE, not purely subtractive. The
 * old directive only told the model what NOT to say ("do not name any wine
 * absent from the grounding"), which pushed re-synth toward thin/empty answers
 * that then fell through to the Layer 2 deterministic template. We now ALSO
 * enumerate the grounded wine labels (and a sample of regions/grapes) so the
 * model can RE-ANCHOR on the real grounding instead of merely deleting the
 * offending claim. The goal is a complete, grounded re-synth — a thin grounded
 * answer still beats a template, so we steer the model toward the available
 * facts rather than starving it.
 *
 * EXACT WORDING is load-bearing: the phrase "Grounding check failed:" anchors
 * scorer/golden-set assertions, and the "GROUNDING_JSON" keyword aligns with
 * the marker used by the structured-grounding preview parser. DO NOT
 * paraphrase without bumping {@link RESYNTH_DIRECTIVE_VERSION}.
 */
export function buildResynthDirective(
  ungroundedClaims: readonly string[],
  facts: GroundingFacts,
): string {
  const listedUngrounded = ungroundedClaims.slice(0, RESYNTH_MAX_LISTED_CLAIMS).join(', ');
  const groundedLabels = [...facts.labels].slice(0, RESYNTH_MAX_LISTED_LABELS);
  // A3: expand the re-anchoring context — sample regions and grapes too so the
  // model has more grounded fields to build a complete answer from, not just
  // labels. Bounded to keep the directive prompt small.
  const groundedRegions = [...facts.regions].slice(0, RESYNTH_MAX_LISTED_REGIONS);
  const groundedGrapes = [...facts.grapes].slice(0, RESYNTH_MAX_LISTED_GRAPES);
  const fieldSamples: string[] = [];
  if (groundedRegions.length > 0) {
    fieldSamples.push(`regions: ${groundedRegions.join(', ')}`);
  }
  if (groundedGrapes.length > 0) {
    fieldSamples.push(`grapes: ${groundedGrapes.join(', ')}`);
  }
  const fieldSampleClause = fieldSamples.length > 0
    ? ` Grounded fields you may draw on include — ${fieldSamples.join('; ')}.`
    : '';
  const groundedClause = groundedLabels.length > 0
    ? ` The wines actually present in the grounding are: ${groundedLabels.join(', ')}. `
      + 'Build your answer around THESE wines and their grounded fields '
      + '(region, grape, vintage, price). Provide a complete, helpful recommendation '
      + 'using only this grounded material — do not return an empty or one-line answer.'
      + fieldSampleClause
    : ' Use only the structured fields present in the tool outcomes (region, grape, '
      + 'vintage, price); keep the answer complete and helpful.'
      + fieldSampleClause;
  return (
    'Grounding check failed: your previous answer asserted facts not present in '
    + `the tool outcomes (ungrounded: ${listedUngrounded}). Re-emit using ONLY fields in `
    + 'GROUNDING_JSON / the provided tool outcomes. Do not name any wine, region, '
    + 'grape, vintage, or price that is absent from the grounding.'
    + groundedClause
  );
}
