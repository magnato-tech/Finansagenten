
import { calculateMA, calculateATR } from './indicators';

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
}

export function detectPatterns(data: StockData): string[] {
  const { close, high, low } = data;
  const n = close.length;
  if (n < 200) return [];

  const ma50 = calculateMA(close, 50);
  const ma150 = calculateMA(close, 150);
  const ma200 = calculateMA(close, 200);
  
  const patterns: string[] = [];
  const currentPrice = close[n - 1];
  const prevPrice = close[n - 2];
  
  // 1. Breakout (Simplified: Price above 52-week high or recent resistance)
  const recentHigh = Math.max(...high.slice(n - 20, n - 1));
  if (currentPrice > recentHigh) {
    patterns.push('Breakout');
  }

  // 2. Pullback in trend
  if (currentPrice > ma150[n - 1] && currentPrice < ma50[n - 1] * 1.02 && currentPrice > ma50[n - 1] * 0.98) {
    patterns.push('Pullback');
  }

  // 3. MA50 Reclaim
  if (prevPrice < ma50[n - 2] && currentPrice > ma50[n - 1]) {
    patterns.push('MA50 Reclaim');
  }

  // 4. MA50 Pressure (Repeatedly testing from below)
  const last5 = close.slice(n - 5);
  const last5MA50 = ma50.slice(n - 5);
  const tests = last5.filter((p, i) => p > last5MA50[i] * 0.97 && p < last5MA50[i]).length;
  if (tests >= 3 && currentPrice < ma50[n - 1]) {
    patterns.push('MA50 Pressure');
  }

  return patterns;
}

export function calculateScore(data: StockData, patterns: string[]): number {
  const { close } = data;
  const n = close.length;
  const ma50 = calculateMA(close, 50);
  const ma200 = calculateMA(close, 200);
  
  let score = 0;
  
  // Trend strength
  if (close[n - 1] > ma50[n - 1]) score += 20;
  if (ma50[n - 1] > ma200[n - 1]) score += 30;
  
  // Pattern bonuses
  if (patterns.includes('Breakout')) score += 50;
  if (patterns.includes('MA50 Reclaim')) score += 40;
  if (patterns.includes('Pullback')) score += 30;
  if (patterns.includes('MA50 Pressure')) score += 20;

  return score;
}
