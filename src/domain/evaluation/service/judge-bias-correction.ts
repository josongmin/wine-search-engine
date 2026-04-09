/**
 * LLM judge bias correction (Epic-13 T13-10).
 *
 * LLM judges have systematic biases:
 *   1. Per-judge lenience/strictness (some judges score everything 0.1 higher)
 *   2. Position bias (the first item in a pair is preferred regardless of merit)
 *   3. Inter-judge disagreement (no consensus on borderline cases)
 *
 * This module computes a per-judge bias estimate from a calibration set and
 * exposes a correction function that subtracts the bias from raw scores.
 *
 * Reference: Zheng et al. 2023 "Judging LLM-as-a-Judge with MT-Bench and
 * Chatbot Arena", which documents these biases and the swap-position
 * countermeasure.
 */

/** Tolerance for "same score" agreement comparison. */
const AGREEMENT_TOLERANCE = 0.1;

export interface JudgeSample {
  readonly judgeId: string;
  readonly score: number;
  /** For pairwise judges: which position the judged item was shown in. */
  readonly position?: 'A' | 'B';
  readonly itemA: string;
  /** Optional second item for pairwise judges. */
  readonly itemB?: string;
}

export interface JudgeBiasReport {
  readonly meanScore: number;
  readonly stdScore: number;
  readonly perJudgeMean: ReadonlyMap<string, number>;
  /** Per-judge bias = (perJudgeMean - meanScore). Positive = lenient. */
  readonly perJudgeBias: ReadonlyMap<string, number>;
  /** Position bias = mean(score | position=A) - mean(score | position=B). */
  readonly positionBias: number;
  /** Fraction of inter-judge agreement (within AGREEMENT_TOLERANCE). */
  readonly interJudgeAgreement: number;
  readonly sampleCount: number;
}

const EMPTY_REPORT: JudgeBiasReport = {
  meanScore: 0,
  stdScore: 0,
  perJudgeMean: new Map(),
  perJudgeBias: new Map(),
  positionBias: 0,
  interJudgeAgreement: 0,
  sampleCount: 0,
};

export function computeJudgeBias(samples: readonly JudgeSample[]): JudgeBiasReport {
  if (samples.length === 0) return EMPTY_REPORT;

  const validScores: number[] = [];
  const perJudgeSum = new Map<string, number>();
  const perJudgeCount = new Map<string, number>();
  let posASum = 0;
  let posACount = 0;
  let posBSum = 0;
  let posBCount = 0;

  for (const s of samples) {
    if (!Number.isFinite(s.score)) continue;
    validScores.push(s.score);
    perJudgeSum.set(s.judgeId, (perJudgeSum.get(s.judgeId) ?? 0) + s.score);
    perJudgeCount.set(s.judgeId, (perJudgeCount.get(s.judgeId) ?? 0) + 1);
    if (s.position === 'A') {
      posASum += s.score;
      posACount++;
    } else if (s.position === 'B') {
      posBSum += s.score;
      posBCount++;
    }
  }

  if (validScores.length === 0) return EMPTY_REPORT;

  let mean = 0;
  for (const v of validScores) mean += v;
  mean /= validScores.length;

  let varSum = 0;
  for (const v of validScores) varSum += (v - mean) ** 2;
  const std = Math.sqrt(varSum / validScores.length);

  const perJudgeMean = new Map<string, number>();
  const perJudgeBias = new Map<string, number>();
  for (const [judgeId, sum] of perJudgeSum) {
    const count = perJudgeCount.get(judgeId)!;
    const judgeMean = sum / count;
    perJudgeMean.set(judgeId, judgeMean);
    perJudgeBias.set(judgeId, judgeMean - mean);
  }

  const meanA = posACount > 0 ? posASum / posACount : 0;
  const meanB = posBCount > 0 ? posBSum / posBCount : 0;
  const positionBias = posACount > 0 && posBCount > 0 ? meanA - meanB : 0;

  // Inter-judge agreement: for samples with the same (itemA, itemB) but
  // different judgeIds, compute the fraction of pairs that agreed within tolerance.
  const groups = new Map<string, JudgeSample[]>();
  for (const s of samples) {
    if (!Number.isFinite(s.score)) continue;
    const key = `${s.itemA}\u0000${s.itemB ?? ''}`;
    const existing = groups.get(key) ?? [];
    existing.push(s);
    groups.set(key, existing);
  }
  let agreementHits = 0;
  let agreementTotal = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.judgeId === b.judgeId) continue;
        agreementTotal++;
        if (Math.abs(a.score - b.score) <= AGREEMENT_TOLERANCE) {
          agreementHits++;
        }
      }
    }
  }
  const interJudgeAgreement = agreementTotal > 0 ? agreementHits / agreementTotal : 0;

  return {
    meanScore: mean,
    stdScore: std,
    perJudgeMean,
    perJudgeBias,
    positionBias,
    interJudgeAgreement,
    sampleCount: validScores.length,
  };
}

export interface BiasCorrectedScore {
  readonly originalScore: number;
  readonly correctedScore: number;
  readonly judgeId: string;
  readonly correctionApplied: number;
}

export function correctJudgeBias(
  samples: readonly JudgeSample[],
  biasReport: JudgeBiasReport,
): readonly BiasCorrectedScore[] {
  const out: BiasCorrectedScore[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.score)) continue;
    const bias = biasReport.perJudgeBias.get(s.judgeId) ?? 0;
    out.push({
      originalScore: s.score,
      correctedScore: s.score - bias,
      judgeId: s.judgeId,
      correctionApplied: -bias,
    });
  }
  return out;
}
