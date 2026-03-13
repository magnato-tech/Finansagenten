
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import Database from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
import { evaluateSymbolQuotes } from './src/lib/scanner/scanCore';
import { fetchAllTickers } from './src/data/tickers';
import { SETTINGS } from './src/config/settings';

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
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    min_market_cap REAL NOT NULL DEFAULT 500000000,
    min_daily_volume REAL NOT NULL DEFAULT 500000
  );
  CREATE TABLE IF NOT EXISTS universe_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_updated DATETIME,
    stock_count INTEGER
  );
`);

function ensureStocksSchema() {
  const columns = db.prepare('PRAGMA table_info(stocks)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has('exchange')) {
    db.exec('ALTER TABLE stocks ADD COLUMN exchange TEXT');
  }
  if (!names.has('market_cap')) {
    db.exec('ALTER TABLE stocks ADD COLUMN market_cap REAL');
  }
  if (!names.has('avg_daily_volume')) {
    db.exec('ALTER TABLE stocks ADD COLUMN avg_daily_volume REAL');
  }
  if (!names.has('price')) {
    db.exec('ALTER TABLE stocks ADD COLUMN price REAL');
  }
  if (!names.has('avg_daily_dollar_volume')) {
    db.exec('ALTER TABLE stocks ADD COLUMN avg_daily_dollar_volume REAL');
  }
}

ensureStocksSchema();

function ensureSettingsSchema() {
  const cols = db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('min_dollar_volume')) {
    db.exec('ALTER TABLE settings ADD COLUMN min_dollar_volume REAL NOT NULL DEFAULT 5000000');
  }
  if (!names.has('min_price')) {
    db.exec('ALTER TABLE settings ADD COLUMN min_price REAL NOT NULL DEFAULT 3');
  }
}

ensureSettingsSchema();

function ensureSettingsRow() {
  db.prepare(`
    INSERT OR IGNORE INTO settings (id, min_dollar_volume, min_price)
    VALUES (1, ?, ?)
  `).run(SETTINGS.minDollarVolume, SETTINGS.minPrice);
}

ensureSettingsRow();

function loadActiveSettings() {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  return {
    minDollarVolume: (row?.min_dollar_volume as number) ?? SETTINGS.minDollarVolume,
    minPrice: (row?.min_price as number) ?? SETTINGS.minPrice,
  };
}

let activeSettings = loadActiveSettings();

// ── Universe update: background job + progress tracking ──────────────────────

interface UniverseUpdateProgress {
  running: boolean;
  phase: 'idle' | 'fetching-symbols' | 'fetching-fundamentals' | 'saving' | 'done' | 'error';
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

let universeProgress: UniverseUpdateProgress = {
  running: false,
  phase: 'idle',
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

async function runUniverseUpdate(): Promise<void> {
  universeProgress = {
    running: true,
    phase: 'fetching-symbols',
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  try {
    const symbols = await fetchAllTickers();
    const now = new Date().toISOString();
    const FUNDAMENTAL_CONCURRENCY = 10;

    universeProgress.phase = 'fetching-fundamentals';
    universeProgress.total = symbols.length;

    const enriched: Array<{
      symbol: string;
      exchange: string | null;
      marketCap: number | null;
      price: number | null;
      avgDailyVolume: number | null;
      avgDailyDollarVolume: number | null;
    }> = [];

    let sampleQuoteErrors: string[] = [];

    async function fetchFundamentals(symbol: string): Promise<void> {
      try {
        const quote = await yahooFinance.quote(symbol, {}, { validateResult: false } as any);
        const q = quote as any;
        const price = typeof q?.regularMarketPrice === 'number' ? q.regularMarketPrice : null;
        const avgVol = typeof q?.averageDailyVolume3Month === 'number' ? q.averageDailyVolume3Month : null;
        enriched.push({
          symbol,
          exchange: q?.fullExchangeName ?? q?.exchange ?? null,
          marketCap: typeof q?.marketCap === 'number' ? q.marketCap : null,
          price,
          avgDailyVolume: avgVol,
          avgDailyDollarVolume: price !== null && avgVol !== null ? price * avgVol : null,
        });
        universeProgress.succeeded += 1;
      } catch (e: any) {
        if (sampleQuoteErrors.length < 3) {
          sampleQuoteErrors.push(`[${symbol}] ${e?.message ?? String(e)}`);
          if (sampleQuoteErrors.length === 3) {
            console.error('[universe] Sample quote errors:', sampleQuoteErrors);
          }
        }
        enriched.push({ symbol, exchange: null, marketCap: null, price: null, avgDailyVolume: null, avgDailyDollarVolume: null });
        universeProgress.failed += 1;
      } finally {
        universeProgress.completed += 1;
      }
    }

    for (let i = 0; i < symbols.length; i += FUNDAMENTAL_CONCURRENCY) {
      const batch = symbols.slice(i, i + FUNDAMENTAL_CONCURRENCY).map((s) => fetchFundamentals(s));
      await Promise.allSettled(batch);
    }

    universeProgress.phase = 'saving';

    db.transaction(() => {
      db.prepare('DELETE FROM stocks').run();
      const insert = db.prepare(`
        INSERT OR REPLACE INTO stocks (symbol, exchange, market_cap, avg_daily_volume, price, avg_daily_dollar_volume, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of enriched) {
        insert.run(row.symbol, row.exchange, row.marketCap, row.avgDailyVolume, row.price, row.avgDailyDollarVolume, now);
      }
      db.prepare(`
        INSERT INTO universe_meta (id, last_updated, stock_count)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_updated = excluded.last_updated, stock_count = excluded.stock_count
      `).run(now, enriched.length);
    })();

    universeProgress = {
      ...universeProgress,
      running: false,
      phase: 'done',
      finishedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    universeProgress = {
      ...universeProgress,
      running: false,
      phase: 'error',
      finishedAt: new Date().toISOString(),
      error: String(e?.message ?? e ?? 'Unknown error'),
    };
    console.error('Universe update failed:', e);
  }
}

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

  // API: Get Settings
  app.get('/api/settings', (req, res) => {
    res.json(activeSettings);
  });

  // API: Update Settings
  app.put('/api/settings', (req, res) => {
    const { minDollarVolume, minPrice } = req.body as { minDollarVolume: unknown; minPrice: unknown };

    if (typeof minDollarVolume !== 'number' || minDollarVolume < 0) {
      res.status(400).json({ error: 'minDollarVolume must be a non-negative number' });
      return;
    }
    if (typeof minPrice !== 'number' || minPrice < 0) {
      res.status(400).json({ error: 'minPrice must be a non-negative number' });
      return;
    }

    db.prepare('UPDATE settings SET min_dollar_volume = ?, min_price = ? WHERE id = 1')
      .run(minDollarVolume, minPrice);
    activeSettings = { minDollarVolume, minPrice };
    res.json(activeSettings);
  });

  // API: Filter Impact — returns funnel counts with current settings
  app.get('/api/settings/impact', (req, res) => {
    const universe = (db.prepare('SELECT COUNT(*) as cnt FROM stocks').get() as any).cnt as number;
    const afterPrice = (
      db.prepare('SELECT COUNT(*) as cnt FROM stocks WHERE price > ?').get(activeSettings.minPrice) as any
    ).cnt as number;
    const afterDollarVolume = (
      db.prepare('SELECT COUNT(*) as cnt FROM stocks WHERE price > ? AND avg_daily_dollar_volume > ?')
        .get(activeSettings.minPrice, activeSettings.minDollarVolume) as any
    ).cnt as number;

    res.json({ universe, afterPrice, afterDollarVolume, settings: activeSettings });
  });

  // API: Universe update progress
  app.get('/api/universe/progress', (req, res) => {
    res.json(universeProgress);
  });

  // API: Update Universe — starts background job and returns immediately
  app.post('/api/universe/update', (req, res) => {
    if (universeProgress.running) {
      res.status(409).json({ error: 'Update already in progress' });
      return;
    }
    runUniverseUpdate().catch(console.error);
    res.json({ started: true });
  });

  // API: Run Scan
  app.post('/api/scan', async (req, res) => {
    const universeSize = (db.prepare('SELECT COUNT(*) as cnt FROM stocks').get() as any).cnt as number;
    const afterPriceFilter = (
      db.prepare('SELECT COUNT(*) as cnt FROM stocks WHERE price > ?').get(activeSettings.minPrice) as any
    ).cnt as number;
    const afterDollarVolumeFilter = (
      db.prepare('SELECT COUNT(*) as cnt FROM stocks WHERE price > ? AND avg_daily_dollar_volume > ?')
        .get(activeSettings.minPrice, activeSettings.minDollarVolume) as any
    ).cnt as number;
    const stocks = db.prepare(
      'SELECT symbol FROM stocks WHERE price > ? AND avg_daily_dollar_volume > ?',
    ).all(activeSettings.minPrice, activeSettings.minDollarVolume) as { symbol: string }[];

    console.log(`[scan] Universe size: ${universeSize}`);
    console.log(`[scan] After price filter (>$${activeSettings.minPrice}): ${afterPriceFilter}`);
    console.log(`[scan] After dollar volume filter (>$${(activeSettings.minDollarVolume / 1_000_000).toFixed(0)}M): ${afterDollarVolumeFilter}`);

    const allResults: any[] = [];
    const CONCURRENCY = 20; // parallel fetches; stay well under Yahoo rate limits
    let attempted = 0;
    let chartOk = 0;
    let enoughBars = 0;
    let patternHits = 0;
    let failed = 0;
    const sampleErrors: { symbol: string; message: string }[] = [];

    // #region agent log
    fetch('http://127.0.0.1:7243/ingest/e8aa03b7-da89-4850-bc69-7463913932d1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'H1',location:'server.ts:runScan:start',message:'Scan request started',data:{universeSize,afterPriceFilter,afterDollarVolumeFilter,stockCount:stocks.length,concurrency:CONCURRENCY},timestamp:Date.now()})}).catch(()=>{});
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
    console.log(`[scan] Symbols scanned: ${attempted}`);
    console.log(`[scan] Candidates found: ${patternHits}`);

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
