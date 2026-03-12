
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import yahooFinance from 'yahoo-finance2';
import { detectPatterns, calculateScore } from './src/lib/scanner/patterns';
import { calculateMA, calculateATR } from './src/lib/scanner/indicators';

const db = new Database('finansagenten.db');

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS stocks (
    symbol TEXT PRIMARY KEY,
    name TEXT,
    sector TEXT,
    last_updated DATETIME
  );
  CREATE TABLE IF NOT EXISTS prices (
    symbol TEXT,
    date TEXT,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume INTEGER,
    PRIMARY KEY (symbol, date)
  );
  CREATE TABLE IF NOT EXISTS scan_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    results TEXT
  );
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API: Get Universe
  app.get('/api/universe', (req, res) => {
    const stocks = db.prepare('SELECT * FROM stocks').all();
    res.json(stocks);
  });

  // API: Add Tickers
  app.post('/api/universe', (req, res) => {
    const { symbols } = req.body;
    const insert = db.prepare('INSERT OR IGNORE INTO stocks (symbol) VALUES (?)');
    const transaction = db.transaction((syms) => {
      for (const s of syms) insert.run(s);
    });
    transaction(symbols);
    res.json({ success: true });
  });

  // API: Run Scan
  app.post('/api/scan', async (req, res) => {
    const stocks = db.prepare('SELECT symbol FROM stocks').all() as { symbol: string }[];
    const allResults = [];

    for (const stock of stocks) {
      try {
        const queryOptions = { period1: '2024-01-01' };
        const result = await yahooFinance.historical(stock.symbol, queryOptions) as any[];
        
        if (!result || result.length < 200) continue;

        const data = {
          symbol: stock.symbol,
          date: result.map((r: any) => r.date.toISOString()),
          close: result.map((r: any) => r.close),
          high: result.map((r: any) => r.high),
          low: result.map((r: any) => r.low),
          volume: result.map((r: any) => r.volume),
        };

        const patterns = detectPatterns(data);
        if (patterns.length > 0) {
          const ma50 = calculateMA(data.close, 50);
          const ma150 = calculateMA(data.close, 150);
          const ma200 = calculateMA(data.close, 200);
          const atr = calculateATR(data.high, data.low, data.close, 14);
          
          const n = data.close.length;
          const score = calculateScore(data, patterns);

          allResults.push({
            symbol: stock.symbol,
            price: data.close[n - 1],
            change: ((data.close[n - 1] - data.close[n - 2]) / data.close[n - 2]) * 100,
            ma50: ma50[n - 1],
            ma150: ma150[n - 1],
            ma200: ma200[n - 1],
            atr: atr[n - 1],
            stopLoss: data.close[n - 1] - (atr[n - 1] * 2),
            patterns,
            score
          });
        }
      } catch (e) {
        console.error(`Error scanning ${stock.symbol}:`, e);
      }
    }

    const sortedResults = allResults.sort((a, b) => b.score - a.score).slice(0, 30);
    db.prepare('INSERT INTO scan_results (results) VALUES (?)').run(JSON.stringify(sortedResults));
    
    res.json(sortedResults);
  });

  // API: Get Latest Scan
  app.get('/api/scan/latest', (req, res) => {
    const row = db.prepare('SELECT * FROM scan_results ORDER BY scan_date DESC LIMIT 1').get() as any;
    if (row) {
      res.json(JSON.parse(row.results));
    } else {
      res.json([]);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
