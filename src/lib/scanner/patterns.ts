import { calculateMA } from './indicators';
import { DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from '../../config/settings';

export type { ScoreWeights };

export interface StockData {
  symbol: string;
  date: string[];
  close: number[];
  high: number[];
  low: number[];
  volume: number[];
}

export interface ScanResult {
  symbol: string;
  price: number;
  change: number;
  ma50: number;
  ma150: number;
  ma200: number;
  atr: number;
  stopLoss: number;
  patterns: string[];
  score: number;
  scoreBreakdown: Record<string, number>;
  scoreBuckets: {
    trend: number;
    pattern: number;
    context: number;
  };
}

export interface TechnicalSignals {
  priceAboveMa50: boolean;
  ma50AboveMa200: boolean;
  breakout: boolean;
  pullback: boolean;
  ma50Reclaim: boolean;
  ma50Pressure: boolean;
  volumeConfirmedReclaim: boolean;
  positiveLowVixTrend: boolean;
  patterns: string[];
}

function detectPatternFlags(data: StockData) {
  const { close, high, low } = data;
  const n = close.length;
  if (n < 200) {
    return {
      breakout: false,
      pullback: false,
      ma50Reclaim: false,
      ma50Pressure: false,
    };
  }

  const ma50 = calculateMA(close, 50);
  const ma150 = calculateMA(close, 150);
  
  const currentPrice = close[n - 1];
  const prevPrice = close[n - 2];
  
  // 1. Breakout — price above highest high of last 20 bars (excl. today)
  const recentHigh = Math.max(...high.slice(n - 20, n - 1));
  const breakout = currentPrice > recentHigh;

  // 2. Pullback in trend — above MA150, hugging MA50 within ±2%
  const pullback =
    currentPrice > ma150[n - 1] &&
    currentPrice < ma50[n - 1] * 1.02 &&
    currentPrice > ma50[n - 1] * 0.98;

  // 3. MA50 Reclaim — crossed from below to above MA50
  const ma50Reclaim = prevPrice < ma50[n - 2] && currentPrice > ma50[n - 1];

  // 4. MA50 Pressure — repeatedly testing MA50 from below
  const last5 = close.slice(n - 5);
  const last5MA50 = ma50.slice(n - 5);
  const tests = last5.filter((p, i) => p > last5MA50[i] * 0.97 && p < last5MA50[i]).length;
  const ma50Pressure = tests >= 3 && currentPrice < ma50[n - 1];

  return { breakout, pullback, ma50Reclaim, ma50Pressure };
}

export function detectPatterns(data: StockData): string[] {
  const flags = detectPatternFlags(data);
  const patterns: string[] = [];
  if (flags.breakout) patterns.push('Breakout');
  if (flags.pullback) patterns.push('Pullback');
  if (flags.ma50Reclaim) patterns.push('MA50 Reclaim');
  if (flags.ma50Pressure) patterns.push('MA50 Pressure');
  return patterns;
}

// Volume confirmation: high volume on a MA50 reclaim signals institutional buying
function scoreVolumeConfirmation(
  close: number[],
  volume: number[],
  ma50: number[],
  weight: number,
): number {
  if (weight === 0) return 0;
  const n = close.length;
  if (n < 22) return 0;

  const prevPrice = close[n - 2];
  const currPrice = close[n - 1];
  const prevMa50 = ma50[n - 2];
  const currMa50 = ma50[n - 1];

  // Only applies when there is a MA50 reclaim today
  if (!(prevPrice < prevMa50 && currPrice > currMa50)) return 0;

  const recentVols = volume.slice(n - 21, n - 1);
  const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  if (avgVol === 0) return 0;

  const ratio = volume[n - 1] / avgVol;
  if (ratio >= 2.0) return weight;
  if (ratio >= 1.5) return Math.round(weight * 0.5);
  return 0;
}

// VIX regime: positive trend during low-volatility periods suggests the weakness
// is market-driven (tariffs, fear) rather than fundamental business deterioration.
function scoreVixRegime(
  close: number[],
  dates: string[],
  vixMap: Map<string, number>,
  weight: number,
): number {
  if (weight === 0 || vixMap.size === 0) return 0;
  const n = close.length;
  const lookback = Math.min(180, n);

  // Collect stock prices on days when VIX was < 20
  const lowVixPrices: number[] = [];
  for (let i = n - lookback; i < n; i++) {
    const vix = vixMap.get(dates[i]);
    if (vix !== undefined && vix < 20) {
      lowVixPrices.push(close[i]);
    }
  }

  if (lowVixPrices.length < 5) return 0;

  const mid = Math.floor(lowVixPrices.length / 2);
  const avgFirst = lowVixPrices.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
  const avgSecond = lowVixPrices.slice(mid).reduce((a, b) => a + b, 0) / (lowVixPrices.length - mid);

  if (avgSecond > avgFirst * 1.05) return weight;          // Strong uptrend in calm markets
  if (avgSecond > avgFirst) return Math.round(weight * 0.5); // Mild uptrend
  return 0;
}

function hasVolumeConfirmedReclaim(
  close: number[],
  volume: number[],
  ma50: number[],
): boolean {
  return scoreVolumeConfirmation(close, volume, ma50, 100) > 0;
}

function hasPositiveLowVixTrend(
  close: number[],
  dates: string[],
  vixMap?: Map<string, number>,
): boolean {
  if (!vixMap) return false;
  return scoreVixRegime(close, dates, vixMap, 100) > 0;
}

export function analyzeTechnicalSignals(
  data: StockData,
  vixData?: Map<string, number>,
): TechnicalSignals {
  const { close, volume, date } = data;
  const n = close.length;
  const ma50 = calculateMA(close, 50);
  const ma200 = calculateMA(close, 200);
  const patternFlags = detectPatternFlags(data);
  const patterns = detectPatterns(data);

  return {
    priceAboveMa50: close[n - 1] > ma50[n - 1],
    ma50AboveMa200: ma50[n - 1] > ma200[n - 1],
    breakout: patternFlags.breakout,
    pullback: patternFlags.pullback,
    ma50Reclaim: patternFlags.ma50Reclaim,
    ma50Pressure: patternFlags.ma50Pressure,
    volumeConfirmedReclaim: hasVolumeConfirmedReclaim(close, volume, ma50),
    positiveLowVixTrend: hasPositiveLowVixTrend(close, date, vixData),
    patterns,
  };
}

export function calculateScore(
  signals: TechnicalSignals,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
): {
  score: number;
  breakdown: Record<string, number>;
  buckets: { trend: number; pattern: number; context: number };
} {
  const breakdown: Record<string, number> = {};

  const add = (key: string, value: number) => {
    if (value !== 0) breakdown[key] = value;
    return value;
  };

  let score = 0;
  let trend = 0;
  let pattern = 0;
  let context = 0;

  // Trend
  trend += add('Trend: Price > MA50', signals.priceAboveMa50 ? weights.wTrendAboveMa50 : 0);
  trend += add('Trend: MA50 > MA200', signals.ma50AboveMa200 ? weights.wTrendMa50AboveMa200 : 0);

  // Patterns
  pattern += add('Pattern: Breakout', signals.breakout ? weights.wBreakout : 0);
  pattern += add('Pattern: MA50 Reclaim', signals.ma50Reclaim ? weights.wMa50Reclaim : 0);
  pattern += add('Pattern: Pullback', signals.pullback ? weights.wPullback : 0);
  pattern += add('Pattern: MA50 Pressure', signals.ma50Pressure ? weights.wMa50Pressure : 0);

  // Context
  context += add(
    'Context: Volume Confirmed Reclaim',
    signals.volumeConfirmedReclaim ? weights.wVolumeConfirmation : 0,
  );
  context += add(
    'Context: Positive Low-VIX Trend',
    signals.positiveLowVixTrend ? weights.wVixRegime : 0,
  );

  score = trend + pattern + context;
  return { score, breakdown, buckets: { trend, pattern, context } };
}
