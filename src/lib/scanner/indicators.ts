
export function calculateMA(prices: number[], period: number): number[] {
  const ma: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      ma.push(NaN);
      continue;
    }
    const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    ma.push(sum / period);
  }
  return ma;
}

export function calculateATR(highs: number[], lows: number[], closes: number[], period: number): number[] {
  const tr: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hpc = Math.abs(highs[i] - closes[i - 1]);
    const lpc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hpc, lpc));
  }

  const atr: number[] = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period) {
      atr.push(NaN);
      continue;
    }
    const sum = tr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    atr.push(sum / period);
  }
  return atr;
}

export function calculateRSI(closes: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (i <= period) {
      if (diff > 0) gains += diff;
      else losses -= diff;
      
      if (i === period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        rsi.push(100 - (100 / (1 + avgGain / avgLoss)));
      } else {
        rsi.push(NaN);
      }
      continue;
    }

    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    
    // Simple moving average for RSI
    const prevRSI = rsi[rsi.length - 1];
    const rs = (( (rsi[rsi.length-1] ? (100/(100-prevRSI)-1) : 0) * (period-1) + (gain/loss || 0)) / period);
    // More accurate Wilder's smoothing would be better but this is a start
    const avgGain = (gains * (period - 1) + gain) / period;
    const avgLoss = (losses * (period - 1) + loss) / period;
    gains = avgGain;
    losses = avgLoss;
    
    rsi.push(100 - (100 / (1 + avgGain / avgLoss)));
  }
  
  while(rsi.length < closes.length) rsi.unshift(NaN);
  return rsi;
}
