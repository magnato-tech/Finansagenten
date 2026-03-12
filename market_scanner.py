import yfinance as yf
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed

# ── Ticker universe ────────────────────────────────────────────────────────────
TICKERS = [
    # Tech
    "AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN", "TSLA", "AMD", "INTC", "CRM",
    # Finance
    "JPM", "BAC", "GS", "MS", "V", "MA", "BRK-B",
    # Healthcare
    "JNJ", "UNH", "PFE", "MRK", "ABBV",
    # Energy
    "XOM", "CVX", "COP",
    # Consumer / Industrials
    "WMT", "HD", "NKE", "MCD", "BA", "CAT",
    # ETFs
    "SPY", "QQQ", "IWM",
]

MIN_BARS = 150          # Need at least this many trading days of history
DOWNLOAD_WORKERS = 10   # Parallel download threads


def _fetch_ticker(ticker: str) -> dict | None:
    """Download data for one ticker and return a result dict, or None to skip."""
    try:
        data = yf.download(ticker, period="1y", progress=False, auto_adjust=True)
    except Exception:
        return None

    if len(data) < MIN_BARS:
        return None

    close = data["Close"].squeeze()  # works for both single and multi-level columns
    ma50  = close.rolling(50).mean()
    ma150 = close.rolling(150).mean()

    price  = float(close.iloc[-1])
    ma50_  = float(ma50.iloc[-1])
    ma150_ = float(ma150.iloc[-1])

    # Only keep stocks where price sits between MA50 and MA150
    low, high = min(ma50_, ma150_), max(ma50_, ma150_)
    if not (low < price < high):
        return None

    return {
        "ticker":        ticker,
        "price":         round(price,  2),
        "MA50":          round(ma50_,  2),
        "MA150":         round(ma150_, 2),
        "above_MA50":    price > ma50_,   # True → price is above MA50 inside the band
        "bullish_cross": ma50_ > ma150_,  # True → short-term MA is above long-term MA
    }


def scan_market(tickers: list[str] = TICKERS) -> pd.DataFrame:
    """
    Scan a list of tickers and return only those whose current price
    is between their 50-day and 150-day moving averages.

    Parameters
    ----------
    tickers : list of ticker symbols to scan (defaults to the built-in universe)

    Returns
    -------
    pd.DataFrame sorted by ticker, with price / MA columns and signal flags.
    """
    results = []

    with ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS) as pool:
        futures = {pool.submit(_fetch_ticker, t): t for t in tickers}
        for future in as_completed(futures):
            result = future.result()
            if result is not None:
                results.append(result)

    if not results:
        return pd.DataFrame()

    df = (
        pd.DataFrame(results)
        .sort_values("ticker")
        .reset_index(drop=True)
    )
    return df


if __name__ == "__main__":
    print(f"Scanning {len(TICKERS)} tickers …\n")
    df = scan_market()

    if df.empty:
        print("No stocks found with price between MA50 and MA150.")
    else:
        print(f"Found {len(df)} stock(s) with price between MA50 and MA150:\n")
        print(df.to_string(index=False))
