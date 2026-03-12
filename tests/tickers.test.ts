import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllTickers, parseSymbolFile } from '../src/data/tickers';

test('parseSymbolFile filters test and invalid symbols', () => {
  const txt = [
    'Symbol|Name|Category|TestIssue',
    'AAPL|Apple Inc|Q|N',
    'MSFT|Microsoft|Q|N',
    'TEST|Synthetic|Q|Y',
    'BRK.B|Berkshire|Q|N',
    'ABCDW|Warrant|Q|N',
    '',
  ].join('\n');

  const out = parseSymbolFile(txt, 0, 3);
  assert.deepEqual(out, ['AAPL', 'MSFT']);
});

test('fetchAllTickers merges and de-duplicates from both sources', async () => {
  const nasdaqTxt = [
    'Symbol|Name|Category|TestIssue',
    'AAPL|Apple Inc|Q|N',
    'MSFT|Microsoft|Q|N',
    'FAKE|Synthetic|Q|Y',
    '',
  ].join('\n');

  const otherTxt = [
    'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
    'MSFT|Microsoft|N|MSFT|N|100|N|MSFT',
    'NVDA|NVIDIA|N|NVDA|N|100|N|NVDA',
    'XYZU|Unit Security|N|XYZU|N|100|N|XYZU',
    '',
  ].join('\n');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes('nasdaqlisted.txt')) {
      return new Response(nasdaqTxt, { status: 200 });
    }
    if (url.includes('otherlisted.txt')) {
      return new Response(otherTxt, { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;

  try {
    const symbols = await fetchAllTickers();
    assert.deepEqual(symbols, ['AAPL', 'MSFT', 'NVDA']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

