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
  const prompt = CRITIC_PROXY_PROMPT.replace('{canonicalLabel}', wine.canonicalLabel)
    .replace('{searchTextEn}', wine.searchTextEn)
    .replace('{body}', wine.body ?? 'unknown')
    .replace('{acidity}', wine.acidity ?? 'unknown')
    .replace('{tannin}', wine.tannin ?? 'unknown')
    .replace('{region}', wine.region ?? 'unknown')
    .replace('{grapePrimary}', wine.grapePrimary ?? 'unknown');

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

  // Parse JSON
  // Non-greedy match: extract the first complete JSON object, not the span between first { and last }
  const jsonMatch = textContent.text.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to extract JSON from response: ${textContent.text}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);

  return {
    proxyScore: parsed.proxy_score,
    scoreTier: parsed.score_tier,
    confidence: parsed.confidence,
    reasoningSignals: parsed.reasoning_signals ?? [],
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
