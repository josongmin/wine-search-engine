/**
 * SOTA++ Doc2Query generator (v3) backed by an OpenAI Chat Completions LLM.
 *
 * Design history (2026-04-10):
 *   v1 — Simple single-shot with 7 intent hints. Legacy baseline.
 *   v2 — 15-slot forced template. Improved coverage but introduced
 *        severe IDF dilution: every wine got the same stopword vocabulary
 *        ("추천", "와인", "similar to"), making those tokens useless
 *        for BM25 ranking. Empirically lost to v1 on 33/50 pilot queries.
 *   v3 — This file. Drops slot forcing in favor of the SOTA approach
 *        used by Promptagator (Dai et al., 2022) and DocT5Query
 *        (Nogueira & Lin 2019): generate naturally, then filter with a
 *        round-trip embedding consistency check.
 *
 * Pipeline:
 *   1. Multi-sample natural generation (N calls, each asking for diverse
 *      queries without slot labels — few-shot examples carry the
 *      taxonomy implicitly). Each call has a different "angle" seed so
 *      the samples don't converge on the same wording.
 *   2. Union + case-insensitive dedup.
 *   3. Stopword blacklist filter (drops "레드 와인 추천" etc.).
 *   4. Round-trip embedding filter (Promptagator-style): embed the
 *      source wine document + every candidate query, keep only queries
 *      whose cosine similarity with the source ≥ MIN_SIM. This is the
 *      key SOTA move — it drops generic hallucinations automatically.
 *   5. Deterministic typo / spacing augmentation on the top entity-exact
 *      queries (rule-based, no LLM, covers the "샤토마고" / "opusone"
 *      pattern that LLMs consistently miss).
 *   6. Anchor + length sanity check.
 *   7. Hard cap to MAX_OUTPUT_QUERIES.
 *
 * Evidence for the design:
 *   - Promptagator (Dai et al., 2022) — round-trip consistency filter
 *     is the single biggest quality lever for synthetic query generation.
 *   - DocT5Query (Nogueira & Lin 2019) — natural multi-sample beats
 *     slot-forced single-shot because samples carry independent diversity.
 *   - Park & Kim (2019) — Korean wine descriptor vocabulary (dropped
 *     into the few-shot examples instead of enforced as slots).
 *   - Internal critical review (2026-04-10 critical-review.py) — v2
 *     slot-forced design produced "부드러운" in 97/200 wines and
 *     "similar to" in 200/200, killing those tokens' IDF.
 */

import type { ChatLlmPort } from '../../domain/ai/port/chat-llm.port.js';
import type { EmbeddingServicePort } from '../../domain/retrieval/port/embedding-service.port.js';
import type {
  Doc2QueryGeneratorPort,
  Doc2QueryInput,
} from '../../domain/retrieval/port/doc2query-generator.port.js';
import { filterStopwordOnly } from './doc2query-stopwords.js';
import { augmentWithTypoVariants } from './doc2query-typo-augment.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard cap on synthetic query length (chars). */
const MAX_QUERY_CHARS = 120;

/**
 * Output token budget per call. A single natural-generation call asking
 * for ~12 queries averages ~280 output tokens; 512 leaves headroom for
 * long Korean natural-language queries without truncation.
 */
const MAX_OUTPUT_TOKENS = 512;

/** How many natural-generation samples to run per wine. */
const NUM_SAMPLES = 3;

/**
 * Per-call query budget. The total after union+dedup is typically
 * NUM_SAMPLES × PER_CALL × 0.55 (samples overlap ~45%).
 */
const QUERIES_PER_CALL = 12;

/** Final per-wine query count after filtering + typo augmentation. */
const MAX_OUTPUT_QUERIES = 20;

/**
 * Minimum number of queries we accept before declaring the response
 * usable. Below this the ETL script counts it as failed so the
 * fingerprinted idempotency retries on the next run.
 */
const MIN_ACCEPTABLE_QUERIES = 8;

/** Minimum fraction of final queries that must contain Hangul. */
const MIN_KOREAN_RATIO = 0.35;

/**
 * Round-trip cosine similarity floor. Queries below this are considered
 * clearly hallucinated / off-topic and dropped. The threshold is kept
 * permissive (0.15) because the round-trip filter is used primarily as
 * a RANKING signal (top-K by similarity) rather than a hard cut — see
 * `roundTripRankAndFilter`. A low floor catches extreme drift while
 * letting content-poor wines still produce a full query set.
 *
 * Tuning rationale (2026-04-10): an earlier version ran threshold=0.28
 * which drove down-the-middle wines like "2023 The Terraces Zinfandel"
 * (sparse flavor / pairing fields) to only 8 entity-variant queries —
 * the Korean food / style / occasion queries all fell below the cut
 * because the source text lacked the semantic anchors to score them.
 * Top-K ranking without aggressive dropping preserves recall on
 * content-poor records.
 */
const ROUND_TRIP_MIN_SIM = 0.15;

/** Sampling temperature. gpt-5 series ignores this; we still set it. */
const DOC2QUERY_TEMPERATURE = 1;

// Korean price-tier hint thresholds
const USD_TO_KRW = 1300;
const KRW_TIER_LOW = 30_000;
const KRW_TIER_MID = 100_000;
const KRW_TIER_HIGH = 1_000_000;
const WON_PER_CHEON = 1_000;
const WON_PER_MAN = 10_000;

const BODY_TANNIN_HIGH = 0.7;
const BODY_TANNIN_MID = 0.4;

const MAX_FLAVOR_ENTRIES = 8;
const MAX_PAIRING_ENTRIES = 8;

const ANCHOR_MIN_TOKEN_LEN = 4;

// ---------------------------------------------------------------------------
// System prompt — cached by OpenAI (≥1024 token auto-cache threshold).
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a wine search query generator. Given ONE wine document, output a JSON array of realistic search queries that a real shopper would type to find this wine.

OUTPUT FORMAT
- JSON array of strings ONLY. No prose, no markdown fences.
- Each query: 3–120 characters.
- Aim for roughly 12 queries, but adjust up or down based on what this specific wine actually supports.

STYLE REQUIREMENTS
- Write queries as a real shopper would type into a search box.
- Mix Korean and English naturally. Target roughly 55–65% Korean.
- Mix query shapes: exact entity, short phrases, natural sentences, colloquial style, misspellings, abbreviations.
- Mix intents: entity lookup, region/grape browse, food pairing, occasion, price tier, beginner, comparison. But do NOT force every intent — only include intents that genuinely fit this wine.
- DO NOT emit generic stopword-only queries like "레드 와인 추천", "와인 추천", "좋은 와인", "best red wine".
- DO NOT start every query with "similar to" or end every query with "추천". Use these patterns at most once each per wine.
- Use vocabulary a Korean wine shopper actually uses: 부드러운, 묵직한, 떫지 않은, 드라이한, 상큼한, 과일향, 오크향, 풀바디, 미디엄바디, 선물용, 기념일, 홈술, 데일리, 와린이, 가성비, 삼겹살, 한우, 스테이크, 회, 치즈, 10만원대, 5만원 이하.
- Price phrases: use 원 units derived from the USD hint provided in the input.
- Korean transliteration: if koreanAliases is non-empty, REUSE one of them verbatim for your entity-exact query. Do not invent alternate romanizations.

CONSTRAINTS
- Do not hallucinate producers, regions, or grapes not present in the input. Inferring grape from the canonicalLabel is fine ("Pinot Noir" in the name → grape=Pinot Noir).
- Do not invent vintages.

EXAMPLES

Example 1 — luxury Bordeaux:

Input:
canonicalLabel: 2015 Château Margaux
producer: Château Margaux
region: France / Bordeaux / Médoc / Margaux
grape hint (from label): Cabernet Sauvignon blend
price hint: 약 100만원 이상 (luxury)
koreanAliases: ["샤토 마고", "샤토 마고 2015"]

Output:
["2015 Château Margaux","샤토 마고 2015","chateau margaux","Margaux First Growth Bordeaux","보르도 1등급 샤토 마고","full bodied Left Bank Bordeaux","묵직한 카베르네 블렌드","기념일 프리미엄 와인 추천","한우 오마카세와 어울리는 프리미엄 레드","20년 숙성 고급 보르도","보르도 1등급 와인 중에 기념일에 마실 고급 프리미엄 레드","similar to Lafite Rothschild"]

Example 2 — value Spanish Tempranillo:

Input:
canonicalLabel: 2019 Finca Villacreces Nebro Ribera del Duero
producer: Finca Villacreces
region: Spain / Ribera del Duero
grape hint (from label): Tempranillo
price hint: 약 4만원 (value)
koreanAliases: ["핑카 빌라크레세스", "핑카 빌라크레세스 2019"]

Output:
["2019 Finca Villacreces Nebro","핑카 빌라크레세스 2019","finca villacreces nebro","Ribera del Duero Tempranillo","리베라 델 두에로 템프라니요","medium Spanish red under 50","부드러운 스페인 레드","5만원 이하 가성비 스페인 와인","와린이가 데일리로 마시기 좋은 템프라니요","삼겹살과 어울리는 부드러운 레드","홈술 편안한 레드 와인","Vega Sicilia 비슷한 스타일"]

Example 3 — mid Argentinian Malbec:

Input:
canonicalLabel: 2020 Trapiche Gran Medalla Malbec
producer: Trapiche
region: Argentina / Mendoza
grape hint (from label): Malbec
price hint: 약 4만원 (mid)
koreanAliases: []

Output:
["2020 Trapiche Gran Medalla Malbec","trapiche malbec","Argentina Mendoza Malbec","아르헨티나 멘도사 말벡","full bodied juicy Malbec","묵직한 과일향 말벡","5만원대 아르헨티나 레드","바베큐 스테이크와 어울리는 말벡","홈술 캐주얼 저녁 레드","Malbec for grilled beef","아르헨티나 와인 중에 고기랑 잘 어울리는 과일향 있는 말벡","Catena Zapata 같은 스타일"]`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HANGUL_REGEX = /[\u3131-\u318E\uAC00-\uD7A3]/u;

function hasHangul(s: string): boolean {
  return HANGUL_REGEX.test(s);
}

function describePriceKrw(priceUsd: number | null, priceBand: string): string {
  if (priceUsd === null) return priceBand;
  const krw = Math.round(priceUsd * USD_TO_KRW);
  if (krw < KRW_TIER_LOW) {
    return `약 ${Math.round(krw / WON_PER_CHEON)}천원 (${priceBand})`;
  }
  if (krw < KRW_TIER_MID) {
    return `약 ${Math.round(krw / WON_PER_MAN)}만원 (${priceBand})`;
  }
  if (krw < KRW_TIER_HIGH) {
    return `약 ${Math.round(krw / WON_PER_MAN)}만원 (${priceBand})`;
  }
  return `약 ${(krw / WON_PER_MAN).toFixed(0)}만원 (${priceBand})`;
}

function styleDescriptor(body: number | null, tannin: number | null): string {
  if (body === null || tannin === null) {
    return 'body/tannin unavailable';
  }
  const bodyLabel =
    body >= BODY_TANNIN_HIGH ? 'full' : body >= BODY_TANNIN_MID ? 'medium' : 'light';
  const tanninLabel =
    tannin >= BODY_TANNIN_HIGH ? 'high' : tannin >= BODY_TANNIN_MID ? 'medium' : 'low';
  return `body=${bodyLabel} (${body.toFixed(2)}), tannin=${tanninLabel} (${tannin.toFixed(2)})`;
}

/**
 * Per-sample angle hints — cycles across the multi-sample loop so each
 * call naturally emphasizes different query families without enforcing
 * slots. This is the Multi-Sample Aggregation trick from GenRead /
 * Promptagator — samples diverge, union converges on diversity.
 */
const SAMPLE_ANGLES: readonly string[] = [
  'Mix entity-exact, region/grape, and style queries. Include at least one intentional spacing/typo variant of the entity.',
  'Emphasize food pairing (Korean dishes welcome), occasion (선물용/기념일/홈술/데일리), and beginner-level phrasing (와린이).',
  'Emphasize price-tier phrasing (원 units), hashtag categories (슈퍼 투스칸, 보르도 1등급, 그랑 크뤼 etc. only if they apply), and one or two long natural-sentence discovery queries in Korean.',
];

function buildUserPrompt(input: Doc2QueryInput, angleIdx: number): string {
  const lines: string[] = [];
  lines.push('<WINE>');
  lines.push(`canonicalLabel: ${input.canonicalLabel}`);
  lines.push(`producer: ${input.producer}`);
  lines.push(`region: ${input.region}`);
  if (input.country) lines.push(`country: ${input.country}`);
  if (input.grapePrimary !== null) lines.push(`grape: ${input.grapePrimary}`);
  else if (input.grapes.length > 0) lines.push(`grapes: ${input.grapes.join(', ')}`);
  lines.push(`sensory: ${styleDescriptor(input.body, input.tannin)}`);
  lines.push(`price: $${input.priceUsd ?? 'unknown'} — ${describePriceKrw(input.priceUsd, input.priceBand)}`);
  if (input.vintageYear !== null) lines.push(`vintage: ${input.vintageYear}`);
  if (input.alcoholPct !== null) lines.push(`alcohol: ${input.alcoholPct}%`);
  if (input.flavorProfiles.length > 0) {
    lines.push(`flavor: [${input.flavorProfiles.slice(0, MAX_FLAVOR_ENTRIES).join(', ')}]`);
  }
  if (input.pairingTags.length > 0) {
    lines.push(`pairingTags: [${input.pairingTags.slice(0, MAX_PAIRING_ENTRIES).join(', ')}]`);
  }
  if (input.drinkingWindowStart !== null && input.drinkingWindowEnd !== null) {
    lines.push(`drinkingWindow: ${input.drinkingWindowStart}-${input.drinkingWindowEnd}`);
  }
  if (input.isTopRated) lines.push(`isTopRated: true`);
  lines.push(
    `koreanAliases: ${input.koreanAliases.length > 0 ? JSON.stringify(input.koreanAliases) : '[]'}`,
  );
  lines.push('</WINE>');
  lines.push('');
  const angle = SAMPLE_ANGLES[angleIdx % SAMPLE_ANGLES.length] ?? SAMPLE_ANGLES[0]!;
  lines.push(`Angle for this pass: ${angle}`);
  lines.push(
    `Generate around ${QUERIES_PER_CALL} search queries for this wine. Output JSON array of strings ONLY.`,
  );
  return lines.join('\n');
}

/** Bracket-balancing JSON-array extractor tolerant of code fences / prose. */
function extractJsonArray(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value)) return false;
  return value.every((entry): entry is string => typeof entry === 'string');
}

function normalizeQuery(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_QUERY_CHARS) return trimmed.slice(0, MAX_QUERY_CHARS);
  return trimmed;
}

/**
 * Anchor check: at least one generated query should reference either the
 * producer name or a region token (≥4 chars) from the source record.
 */
function hasAnchor(queries: readonly string[], input: Doc2QueryInput): boolean {
  const producerTokens = input.producer
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= ANCHOR_MIN_TOKEN_LEN);
  const regionTokens = input.region
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= ANCHOR_MIN_TOKEN_LEN);
  const anchors = new Set<string>([...producerTokens, ...regionTokens]);
  if (anchors.size === 0) return true;
  for (const q of queries) {
    const ql = q.toLowerCase();
    for (const a of anchors) {
      if (ql.includes(a)) return true;
    }
  }
  return false;
}

/**
 * Build the "source text" a synthetic query must relate to, used as
 * the reference for the round-trip embedding ranker.
 *
 * The source text intentionally mixes structured facts (canonical label,
 * producer, region, grape, Korean aliases) with shopper-intent meta
 * phrases — "wine for food pairing, gift, daily drinking, occasion" —
 * so that queries covering legitimate shopper intents (food / occasion /
 * beginner / price tier) are not scored as unrelated when the underlying
 * record has empty flavor / pairing fields. Without the meta hints,
 * content-poor records (which dominate our corpus) would collapse the
 * similarity space around just their canonical label and drop most
 * intent-oriented queries as "off-topic".
 */
function buildSourceDocText(input: Doc2QueryInput): string {
  const structured = [
    input.canonicalLabel,
    input.producer,
    input.region,
    input.country,
    input.grapePrimary ?? '',
    input.grapes.join(' '),
    input.priceBand,
    input.flavorProfiles.join(' '),
    input.pairingTags.join(' '),
    ...input.koreanAliases,
  ].filter((s) => s && s.length > 0);

  // Shopper-intent meta — keeps the round-trip ranker from scoring
  // legitimate intent queries as outliers on content-poor records.
  const intentMeta =
    'red wine for food pairing gift occasion daily drinking beginner steak cheese '
    + '레드 와인 음식 페어링 선물 기념일 홈술 데일리 와린이 스테이크 치즈 삼겹살 한우 가성비 추천';

  return structured.join(' · ') + ' · ' + intentMeta;
}

function dot(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function norm(a: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface OpenAiDoc2QueryGeneratorOptions {
  readonly chatLlm: ChatLlmPort;
  /**
   * Embedding service used for the round-trip consistency filter.
   * Optional — when absent, the adapter still runs but skips the
   * Promptagator-style filtering step (lower quality but still usable
   * for dev / test wiring where no embedding key is configured).
   */
  readonly embeddingService?: EmbeddingServicePort | undefined;
  /** Override the chat adapter's default model. */
  readonly model?: string | undefined;
}

export class OpenAiDoc2QueryGenerator implements Doc2QueryGeneratorPort {
  readonly modelId: string;
  private readonly chatLlm: ChatLlmPort;
  private readonly embeddingService: EmbeddingServicePort | undefined;
  private readonly model: string | undefined;

  constructor(options: OpenAiDoc2QueryGeneratorOptions) {
    this.chatLlm = options.chatLlm;
    this.embeddingService = options.embeddingService;
    this.model = options.model;
    // modelId carries the v3 designation so fingerprints flip when the
    // pipeline changes — ensures existing silver records regenerate.
    this.modelId = `openai-v3:${options.model ?? 'default'}`;
  }

  async generate(input: Doc2QueryInput): Promise<readonly string[]> {
    if (!Number.isFinite(input.numQueries) || input.numQueries <= 0) return [];
    if (
      typeof input.canonicalLabel !== 'string'
      || input.canonicalLabel.trim().length === 0
    ) {
      return [];
    }

    // Step 1: multi-sample generation. Run the N calls in parallel —
    // they're independent, so Promise.all keeps wall-clock close to the
    // single-call latency rather than multiplying it.
    const sampleCalls = Array.from({ length: NUM_SAMPLES }, (_, i) =>
      this.runSingleSample(input, i),
    );
    const samples = await Promise.all(sampleCalls);

    // Step 2: union + case-insensitive dedup (preserve first occurrence).
    const seen = new Set<string>();
    const union: string[] = [];
    for (const sample of samples) {
      for (const raw of sample) {
        const normalized = normalizeQuery(raw);
        if (normalized === undefined) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        union.push(normalized);
      }
    }

    // Step 3: stopword blacklist.
    let filtered = filterStopwordOnly(union) as string[];

    // Step 4: round-trip embedding ranking (Promptagator-inspired, but
    // used as a ranker rather than a hard filter — see
    // roundTripRankAndFilter for the rationale). Skipped when no
    // embedding service is wired.
    if (this.embeddingService !== undefined && filtered.length > 0) {
      filtered = (await this.roundTripRankAndFilter(input, filtered)) as string[];
    }

    // Step 5: deterministic typo / spacing augmentation based on
    // entity-exact anchor queries (canonicalLabel + Korean aliases).
    const entityAnchors: string[] = [input.canonicalLabel, ...input.koreanAliases];
    const typoVariants = augmentWithTypoVariants(entityAnchors);
    for (const v of typoVariants) {
      const key = v.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        filtered.push(v);
      }
    }

    // Step 6: anchor + minimum-size + Korean-ratio sanity checks.
    if (filtered.length < MIN_ACCEPTABLE_QUERIES) return [];
    if (!hasAnchor(filtered, input)) return [];
    const koCount = filtered.filter(hasHangul).length;
    if (koCount / filtered.length < MIN_KOREAN_RATIO) return [];

    // Step 7: hard cap. Preserve the order we built up — LLM-generated
    // queries first (highest round-trip scores are already at the top
    // because roundTripFilter keeps that order), then typo variants.
    if (filtered.length > MAX_OUTPUT_QUERIES) {
      filtered = filtered.slice(0, MAX_OUTPUT_QUERIES);
    }

    return filtered;
  }

  /**
   * Fire a single LLM sample with the shared system prompt and an
   * angle-seeded user prompt. Returns an array of raw strings (possibly
   * empty on transport error or unparseable output — multi-sample
   * absorbs the loss).
   */
  private async runSingleSample(
    input: Doc2QueryInput,
    angleIdx: number,
  ): Promise<readonly string[]> {
    try {
      const userPrompt = buildUserPrompt(input, angleIdx);
      const result = await this.chatLlm.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        ...(this.model !== undefined ? { model: this.model } : {}),
        temperature: DOC2QUERY_TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      });
      const arrayText = extractJsonArray(result.text);
      if (arrayText === undefined) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(arrayText);
      } catch {
        return [];
      }
      if (!isStringArray(parsed)) return [];
      return parsed;
    } catch {
      // One sample failing is survivable — multi-sample absorbs it.
      return [];
    }
  }

  /**
   * Round-trip embedding ranker (Promptagator-inspired). Embed the
   * source wine text + every candidate query, then:
   *
   *   1. Drop only clearly off-topic queries (sim below ROUND_TRIP_MIN_SIM,
   *      currently 0.15 — an extreme-hallucination floor, not a quality cut).
   *   2. Rank the survivors by similarity descending.
   *
   * The returned order means the caller's downstream hard cap picks the
   * most on-topic queries first, while still leaving content-poor wines
   * (which score everything in a modest 0.15–0.35 band) with a full
   * query set. Hallucinations that score below 0.15 are genuinely
   * incoherent relative to the source and are safe to drop.
   */
  private async roundTripRankAndFilter(
    input: Doc2QueryInput,
    queries: readonly string[],
  ): Promise<readonly string[]> {
    const service = this.embeddingService;
    if (service === undefined) return queries;
    const sourceText = buildSourceDocText(input);
    try {
      const embeddings = await service.embedBatch([sourceText, ...queries]);
      const sourceEmb = embeddings[0];
      if (sourceEmb === undefined) return queries;
      const scored: Array<{ query: string; sim: number }> = [];
      for (let i = 0; i < queries.length; i += 1) {
        const queryEmb = embeddings[i + 1];
        if (queryEmb === undefined) continue;
        const sim = cosine(sourceEmb, queryEmb);
        if (sim < ROUND_TRIP_MIN_SIM) continue;
        scored.push({ query: queries[i]!, sim });
      }
      scored.sort((a, b) => b.sim - a.sim);
      return scored.map((s) => s.query);
    } catch {
      // Embedding failure degrades gracefully — fall back to
      // un-filtered queries so the ETL pass still produces output.
      return queries;
    }
  }
}
