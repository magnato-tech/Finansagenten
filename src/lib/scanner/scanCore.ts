import { analyzeTechnicalSignals, calculateScore, type ScanResult } from './patterns';
import { calculateMA, calculateATR } from './indicators';
import { DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from '../../config/settings';

export type { ScoreWeights };

export interface QuoteRow {
  date: Date | string;
  close?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
}

export function evaluateSymbolQuotes(
  symbol: string,
  quotes: QuoteRow[],
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
  vixData?: Map<string, number>,
): ScanResult | null {
  const filtered = quotes.filter((q) => q.close != null && q.high != null && q.low != null);
  if (filtered.length < 200) return null;

  const data = {
    symbol,
    date: filtered.map((r) => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date))),
    close: filtered.map((r) => r.close as number),
    high: filtered.map((r) => r.high as number),
    low: filtered.map((r) => r.low as number),
    volume: filtered.map((r) => (r.volume ?? 0) as number),
  };

  const ma50 = calculateMA(data.close, 50);
  const ma150 = calculateMA(data.close, 150);
  const ma200 = calculateMA(data.close, 200);
  const atr = calculateATR(data.high, data.low, data.close, 14);
  const n = data.close.length;

  const signals = analyzeTechnicalSignals(data, vixData);
  const { score, breakdown, buckets } = calculateScore(signals, weights);

  return {
    symbol,
    price: data.close[n - 1],
    change: ((data.close[n - 1] - data.close[n - 2]) / data.close[n - 2]) * 100,
    ma50: ma50[n - 1],
    ma150: ma150[n - 1],
    ma200: ma200[n - 1],
    atr: atr[n - 1],
    stopLoss: data.close[n - 1] - atr[n - 1] * 2,
    patterns: signals.patterns,
    score,
    scoreBreakdown: breakdown,
    scoreBuckets: buckets,
  };
}
