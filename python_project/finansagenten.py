
import sqlite3
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta
import os
import json

# --- database.py ---
class Database:
    def __init__(self, db_path="finansagenten.db"):
        self.conn = sqlite3.connect(db_path)
        self.create_tables()

    def create_tables(self):
        cursor = self.conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS stocks (
                symbol TEXT PRIMARY KEY,
                name TEXT,
                sector TEXT
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS prices (
                symbol TEXT,
                date TEXT,
                open REAL,
                high REAL,
                low REAL,
                close REAL,
                volume INTEGER,
                PRIMARY KEY (symbol, date)
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS scan_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scan_date TEXT,
                results TEXT
            )
        """)
        self.conn.commit()

# --- technical_indicators.py ---
class Indicators:
    @staticmethod
    def calculate_ma(df, period):
        return df['Close'].rolling(window=period).mean()

    @staticmethod
    def calculate_atr(df, period=14):
        high_low = df['High'] - df['Low']
        high_close = (df['High'] - df['Close'].shift()).abs()
        low_close = (df['Low'] - df['Close'].shift()).abs()
        ranges = pd.concat([high_low, high_close, low_close], axis=1)
        true_range = ranges.max(axis=1)
        return true_range.rolling(window=period).mean()

# --- scanner.py ---
class Scanner:
    def __init__(self, config):
        self.config = config

    def detect_patterns(self, df):
        patterns = []
        last_idx = -1
        
        ma50 = Indicators.calculate_ma(df, 50)
        ma150 = Indicators.calculate_ma(df, 150)
        ma200 = Indicators.calculate_ma(df, 200)
        
        current_price = df['Close'].iloc[last_idx]
        prev_price = df['Close'].iloc[last_idx - 1]
        
        # 1. Breakout
        recent_high = df['High'].iloc[-20:-1].max()
        if current_price > recent_high:
            patterns.append("Breakout")
            
        # 2. Pullback in trend
        if ma150.iloc[last_idx] < current_price < ma50.iloc[last_idx] * 1.02:
            patterns.append("Pullback")
            
        # 3. MA50 Reclaim
        if prev_price < ma50.iloc[last_idx-1] and current_price > ma50.iloc[last_idx]:
            patterns.append("MA50 Reclaim")
            
        return patterns

# --- main.py ---
def main():
    print("Starting Finansagenten Weekly Scan...")
    db = Database()
    scanner = Scanner(config={})
    
    # Example Tickers
    tickers = ["AAPL", "MSFT", "NVDA", "TSLA", "EQNR.OL", "DNB.OL"]
    
    results = []
    for ticker in tickers:
        print(f"Scanning {ticker}...")
        data = yf.download(ticker, start="2024-01-01", progress=False)
        if len(data) < 200: continue
        
        patterns = scanner.detect_patterns(data)
        if patterns:
            results.append({
                "symbol": ticker,
                "price": data['Close'].iloc[-1],
                "patterns": patterns
            })
            
    print("\n--- SCAN RESULTS ---")
    for res in results:
        print(f"{res['symbol']}: {res['patterns']} at ${res['price']:.2f}")

if __name__ == "__main__":
    main()
