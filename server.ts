
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import Database from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
import { evaluateSymbolQuotes } from './src/lib/scanner/scanCore';
import { fetchAllTickers } from './src/data/tickers';

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
  CREATE TABLE IF NOT EXISTS universe_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_updated DATETIME,
    stock_count INTEGER
  );
`);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API: Get Universe metadata (count + last updated)
  app.get('/api/universe', (req, res) => {
    const meta = db.prepare('SELECT * FROM universe_meta WHERE id = 1').get() as any;
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM stocks').get() as any).cnt;
    res.json({
      count,
      lastUpdated: meta?.last_updated ?? null,
    });
  });

  // API: Update Universe — fetches all US tickers from NASDAQ and populates the DB
  app.post('/api/universe/update', async (req, res) => {
    try {
      const symbols = await fetchAllTickers();

      db.transaction(() => {
        db.prepare('DELETE FROM stocks').run();
        const insert = db.prepare('INSERT OR IGNORE INTO stocks (symbol) VALUES (?)');
        for (const s of symbols) insert.run(s);

        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO universe_meta (id, last_updated, stock_count)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET last_updated = excluded.last_updated, stock_count = excluded.stock_count
        `).run(now, symbols.length);
      })();

      res.json({ success: true, count: symbols.length });
    } catch (e: any) {
      console.error('Universe update failed:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // API: Run Scan
  app.post('/api/scan', async (req, res) => {
    const stocks = db.prepare('SELECT symbol FROM stocks').all() as { symbol: string }[];
    const allResults: any[] = [];
    const CONCURRENCY = 20; // parallel fetches; stay well under Yahoo rate limits
    let attempted = 0;
    let chartOk = 0;
    let enoughBars = 0;
    let patternHits = 0;
    let failed = 0;
    const sampleErrors: { symbol: string; message: string }[] = [];

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/e8aa03b7-da89-4850-bc69-7463913932d1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H1',location:'server.ts:runScan:start',message:'Scan request started',data:{stockCount:stocks.length,concurrency:CONCURRENCY},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    async function scanOne(symbol: string): Promise<void> {
      attempted += 1;
      try {
        const result = await yahooFinance.chart(symbol, {
          period1: new Date('2024-01-01'),
          interval: '1d',
        });
        chartOk += 1;
        const quoteCount = result.quotes?.length ?? 0;
        if (quoteCount >= 200) enoughBars += 1;
        const scanResult = evaluateSymbolQuotes(symbol, result.quotes ?? []);
        if (scanResult) {
          allResults.push(scanResult);
          patternHits += 1;
        }
      } catch (error: any) {
        // silently skip failed / delisted symbols
        failed += 1;
        if (sampleErrors.length < 5) {
          sampleErrors.push({ symbol, message: String(error?.message ?? error ?? 'unknown') });
        }
      }
    }

    // Run all scans with bounded concurrency
    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY).map(s => scanOne(s.symbol));
      await Promise.all(batch);
    }

    const sortedResults = allResults.sort((a, b) => b.score - a.score).slice(0, 30);
    db.prepare('INSERT INTO scan_results (results) VALUES (?)').run(JSON.stringify(sortedResults));

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/e8aa03b7-da89-4850-bc69-7463913932d1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H2',location:'server.ts:runScan:end',message:'Scan request completed',data:{attempted,chartOk,enoughBars,patternHits,failed,returned:sortedResults.length,sampleErrors},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    
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
