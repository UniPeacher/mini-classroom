/** 一次作答的预估时长与实际用时 */
export interface DurationSample {
  estSeconds: number;
  durationMs: number;
}

/** 至少有这么多次作答才校准，样本太少时不调整 */
export const MIN_SAMPLES = 5;
/** 只看最近这么多次作答 */
export const RECENT_SAMPLES = 20;

/**
 * 时长校准系数：最近若干次作答"实际用时 ÷ 预估时长"的中位数，限制在 0.5~2 倍。
 * 用中位数而不是平均数：中途离开一会儿造成的超长用时不会把系数拉偏。
 */
export function timeFactor(samples: DurationSample[]): number {
  const ratios = samples
    .slice(-RECENT_SAMPLES)
    .filter((s) => s.estSeconds > 0 && s.durationMs > 0)
    .map((s) => s.durationMs / 1000 / s.estSeconds)
    .sort((a, b) => a - b);
  if (ratios.length < MIN_SAMPLES) return 1;
  const middle = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 1 ? ratios[middle]! : (ratios[middle - 1]! + ratios[middle]!) / 2;
  return Math.min(2, Math.max(0.5, median));
}
