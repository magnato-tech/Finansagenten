/**
 * Fetches all US-listed stock symbols from NASDAQ's public data files.
 *
 * Sources (pipe-delimited, updated daily by NASDAQ):
 *   - nasdaqlisted.txt  → NASDAQ-listed securities
 *   - otherlisted.txt   → NYSE, AMEX, and other exchange securities
 *
 * Filters out test issues, warrants (W), rights (R), units (U),
 * preferred shares (ending in P/A/B/C/D/E), and notes (ending in L).
 */

const NASDAQ_LISTED_URL =
  'https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt';
const OTHER_LISTED_URL =
  'https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt';

const SYMBOL_BLACKLIST_REGEX = /[^A-Z]|W$|R$|U$|L$|[A-Z]{5,}/;

function isCleanSymbol(symbol: string): boolean {
  if (!symbol || symbol.length > 5) return false;
  if (SYMBOL_BLACKLIST_REGEX.test(symbol)) return false;
  return true;
}

export function parseSymbolFile(
  text: string,
  symbolCol: number,
  testIssueCol: number,
): string[] {
  const lines = text.split('\n');
  const symbols: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('|');
    if (cols.length <= Math.max(symbolCol, testIssueCol)) continue;

    const symbol = cols[symbolCol].trim();
    const testIssue = cols[testIssueCol].trim();

    if (testIssue === 'Y') continue;
    if (!isCleanSymbol(symbol)) continue;

    symbols.push(symbol);
  }

  return symbols;
}

async function fetchAndParse(url: string, symbolCol: number, testIssueCol: number): Promise<string[]> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  const text = await res.text();
  return parseSymbolFile(text, symbolCol, testIssueCol);
}

/**
 * Returns a deduplicated list of all clean US-listed stock symbols.
 * Typically yields 6 000–7 000 symbols depending on market activity.
 */
export async function fetchAllTickers(): Promise<string[]> {
  const [nasdaq, other] = await Promise.all([
    // nasdaqlisted.txt columns: Symbol(0) | Name(1) | MarketCat(2) | TestIssue(3) | ...
    fetchAndParse(NASDAQ_LISTED_URL, 0, 3),
    // otherlisted.txt columns:  ACTSymbol(0) | Name(1) | Exchange(2) | CQS(3) | ETF(4) | RoundLot(5) | TestIssue(6) | NASDAQSymbol(7)
    fetchAndParse(OTHER_LISTED_URL, 0, 6),
  ]);

  const unique = Array.from(new Set([...nasdaq, ...other]));
  return unique.sort();
}
