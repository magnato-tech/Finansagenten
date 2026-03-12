import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSymbolQuotes, type QuoteRow } from '../src/lib/scanner/scanCore';

function makeBreakoutQuotes(days: number): QuoteRow[] {
  const quotes: QuoteRow[] = [];
  const start = new Date('2025-01-01');

  for (let i = 0; i < days - 1; i++) {
    const close = 100 + i * 0.4;
    quotes.push({
      date: new Date(start.getTime() + i * 86_400_000),
      close,
      high: close + 1,
      low: close - 1,
      volume: 1_000_000 + i * 1000,
    });
  }

  // Force a clear breakout on the final day
  const finalClose = 250;
  quotes.push({
    date: new Date(start.getTime() + (days - 1) * 86_400_000),
    close: finalClose,
    high: finalClose + 1,
    low: finalClose - 2,
    volume: 2_000_000,
  });

  return quotes;
}

test('evaluateSymbolQuotes returns null when < 200 bars', () => {
  const result = evaluateSymbolQuotes('AAPL', makeBreakoutQuotes(150));
  assert.equal(result, null);
});

test('evaluateSymbolQuotes produces candidate when patterns exist', () => {
  const result = evaluateSymbolQuotes('AAPL', makeBreakoutQuotes(220));

  assert.ok(result, 'expected scan result for valid breakout data');
  assert.equal(result?.symbol, 'AAPL');
  assert.ok(Array.isArray(result?.patterns));
  assert.ok(result?.patterns.includes('Breakout'));
  assert.ok((result?.score ?? 0) > 0);
  assert.ok((result?.ma50 ?? 0) > 0);
  assert.ok((result?.ma150 ?? 0) > 0);
});

