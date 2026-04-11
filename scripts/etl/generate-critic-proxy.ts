import { Anthropic } from '@anthropic-ai/sdk';

/**
 * Step 12.1: Synthetic Critic Score Proxy Generator
 *
 * Generates critic score proxies (Robert Parker / Wine Spectator style)
 * from wine tasting notes using Claude API.
 *
 * RFC: v0.2 Epic 12 (Data Enrichment)
 * Input: Vivino wine record with tasting notes
 * Output: CriticProxyResult with score, tier, and confidence
 */

export interface WineRecord {
  readonly canonicalLabel: string;
  readonly searchTextEn: string;
  readonly body?: string;
  readonly acidity?: string;
  readonly tannin?: string;
  readonly region?: string;
  readonly grapePrimary?: string;
}

export interface CriticProxyResult {
  readonly proxyScore: number;
  readonly scoreTier: 'exceptional' | 'outstanding' | 'very_good' | 'good';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly reasoningSignals: string[];
  readonly isSynthetic: true;
}

/** Module-scope (Rule 16): deterministic sets, allocate once not per-call. */
const VALID_SCORE_TIERS: ReadonlySet<string> = new Set(['exceptional', 'outstanding', 'very_good', 'good']);
const VALID_CONFIDENCES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

const CRITIC_PROXY_PROMPT = `
You are scoring a wine based on its tasting notes using the 100-point scale
used by professional wine critics (Robert Parker, Wine Spectator style).

Wine: {canonicalLabel}
Tasting notes: {searchTextEn}
Style: body={body}, acidity={acidity}, tannin={tannin}
Region: {region}, Grape: {grapePrimary}

Respond with ONLY a valid JSON object (no markdown, no code fence):
{
  "proxy_score": <integer 80-100>,
  "score_tier": "exceptional|outstanding|very_good|good",
  "confidence": "high|medium|low",
  "reasoning_signals": ["signal1", "signal2", "signal3"]
}

Scoring guide:
- 95-100 "exceptional": extraordinary complexity, profound depth, age-worthy potential, perfumed, elegant
- 90-94 "outstanding": complex, concentrated, excellent balance, harmonious, well-structured
- 85-89 "very_good": well-made, good varietal character, pleasant flavors, balanced acidity
- 80-84 "good": pleasant, straightforward, clean, approachable, everyday drinking

Confidence:
- high: tasting notes ≥ 100 chars, clear flavor descriptors, coherent profile
- medium: notes 30-100 chars, some ambiguity, partial clarity
- low: notes < 30 chars, minimal descriptors, high uncertainty

Output only valid JSON.
`;

/**
 * Generates a critic proxy score for a single wine record.
 */
export async function generateCriticProxy(
  wine: WineRecord,
  client: Anthropic,
): Promise<CriticProxyResult> {
  // Prepare prompt with wine data
  // Single-pass template substitution to avoid chained .replace() double-substitution
  // when user data contains template tokens like {region}.
  const templateVars: Record<string, string> = {
    canonicalLabel: wine.canonicalLabel,
    searchTextEn: wine.searchTextEn,
    body: wine.body ?? 'unknown',
    acidity: wine.acidity ?? 'unknown',
    tannin: wine.tannin ?? 'unknown',
    region: wine.region ?? 'unknown',
    grapePrimary: wine.grapePrimary ?? 'unknown',
  };
  const prompt = CRITIC_PROXY_PROMPT.replace(
    /\{(\w+)\}/g,
    (_, key: string) => templateVars[key] ?? '',
  );

  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });

  // Extract text from response
  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  // Parse JSON — bracket-balanced extraction to handle nested objects/arrays
  const responseText = textContent.text;
  const startIdx = responseText.indexOf('{');
  if (startIdx === -1) {
    throw new Error(`Failed to extract JSON from response: ${responseText}`);
  }
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < responseText.length; i++) {
    if (responseText[i] === '{') depth++;
    else if (responseText[i] === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) {
    throw new Error(`Unbalanced JSON braces in response: ${responseText.slice(0, 200)}`);
  }

  // CLAUDE.md Rule 12: cast JSON.parse result to unknown, then validate.
  const rawParsed: unknown = JSON.parse(responseText.slice(startIdx, endIdx + 1));
  if (typeof rawParsed !== 'object' || rawParsed === null) {
    throw new Error(`Expected JSON object from Claude, got: ${typeof rawParsed}`);
  }
  const parsed = rawParsed as Record<string, unknown>;

  // SCAN4-09 fix: LLMs sometimes emit proxy_score as a string (e.g. "87" instead of 87).
  // CLAUDE.md Rule 26: use != null, not truthiness, to handle score=0 edge case.
  // CLAUDE.md schema quality bar: parseFloat result must be guarded with Number.isFinite().
  const rawScore = parsed['proxy_score'];
  const numericScore =
    typeof rawScore === 'number'
      ? rawScore
      : typeof rawScore === 'string'
        ? parseFloat(rawScore)
        : NaN;
  if (!Number.isFinite(numericScore)) {
    throw new Error(`Invalid proxy_score from Claude: ${String(rawScore)}`);
  }
  // Guard against LLM emitting an out-of-range value (e.g. already-normalized 0.85
  // instead of integer 80-100, or a hallucinated 110/200). The downstream indexer
  // divides by 100 expecting a [80,100] integer — an out-of-range value silently
  // produces a score far outside [0,1] (e.g. 0.0085 for 0.85, or 1.1 for 110).
  if (numericScore < 0 || numericScore > 100) {
    throw new Error(`proxy_score out of expected range [0,100]: ${numericScore}`);
  }

  // Validate enum fields against module-scope sets — LLMs can emit values
  // outside the declared union; `as` cast is unsafe without a runtime check.
  const rawTier = parsed['score_tier'];
  const rawConfidence = parsed['confidence'];

  if (typeof rawTier !== 'string' || !VALID_SCORE_TIERS.has(rawTier)) {
    throw new Error(`Invalid score_tier from Claude: ${String(rawTier)}`);
  }
  if (typeof rawConfidence !== 'string' || !VALID_CONFIDENCES.has(rawConfidence)) {
    throw new Error(`Invalid confidence from Claude: ${String(rawConfidence)}`);
  }

  return {
    proxyScore: numericScore,
    scoreTier: rawTier as CriticProxyResult['scoreTier'],
    confidence: rawConfidence as CriticProxyResult['confidence'],
    reasoningSignals: Array.isArray(parsed['reasoning_signals'])
      ? (parsed['reasoning_signals'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    isSynthetic: true,
  };
}

/**
 * Batch generate critic proxies for multiple wines.
 * Respects rate limits by spacing requests.
 */
export async function generateCriticProxiesBatch(
  wines: WineRecord[],
  client: Anthropic,
  batchSize: number = 10,
): Promise<Map<string, CriticProxyResult>> {
  const results = new Map<string, CriticProxyResult>();

  for (let i = 0; i < wines.length; i += batchSize) {
    const batch = wines.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (wine) => {
        try {
          const proxy = await generateCriticProxy(wine, client);
          results.set(wine.canonicalLabel, proxy);
        } catch (error) {
          console.error(`Failed to generate proxy for ${wine.canonicalLabel}:`, error);
        }
      }),
    );

    // Slight delay between batches to avoid rate limits
    if (i + batchSize < wines.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return results;
}
