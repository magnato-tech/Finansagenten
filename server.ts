
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import Database from 'better-sqlite3';
import YahooFinance from 'yahoo-finance2';
const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical'] });
import { evaluateSymbolQuotes } from './src/lib/scanner/scanCore';
import { fetchAllTickers } from './src/data/tickers';
import { SETTINGS, DEFAULT_SCORE_WEIGHTS } from './src/config/settings';
import type { ScoreWeights } from './src/config/settings';
import { analyzeTechnicalSignals } from './src/lib/scanner/patterns';

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
    results TEXT,
    stats TEXT
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

function ensureScanResultsSchema() {
  const cols = db.prepare('PRAGMA table_info(scan_results)').all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('stats')) {
    db.exec('ALTER TABLE scan_results ADD COLUMN stats TEXT');
  }
}

ensureScanResultsSchema();

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
  // Score weight columns
  const scoreDefaults: [string, number][] = [
    ['w_trend_above_ma50', DEFAULT_SCORE_WEIGHTS.wTrendAboveMa50],
    ['w_trend_ma50_above_ma200', DEFAULT_SCORE_WEIGHTS.wTrendMa50AboveMa200],
    ['w_breakout', DEFAULT_SCORE_WEIGHTS.wBreakout],
    ['w_ma50_reclaim', DEFAULT_SCORE_WEIGHTS.wMa50Reclaim],
    ['w_pullback', DEFAULT_SCORE_WEIGHTS.wPullback],
    ['w_ma50_pressure', DEFAULT_SCORE_WEIGHTS.wMa50Pressure],
    ['w_vix_regime', DEFAULT_SCORE_WEIGHTS.wVixRegime],
    ['w_volume_confirmation', DEFAULT_SCORE_WEIGHTS.wVolumeConfirmation],
  ];
  for (const [col, def] of scoreDefaults) {
    if (!names.has(col)) {
      db.exec(`ALTER TABLE settings ADD COLUMN ${col} REAL NOT NULL DEFAULT ${def}`);
    }
  }
}

ensureSettingsSchema();

function ensureSettingsRow() {
  db.prepare(`
    INSERT OR IGNORE INTO settings (
      id, min_dollar_volume, min_price,
      w_trend_above_ma50, w_trend_ma50_above_ma200, w_breakout, w_ma50_reclaim,
      w_pullback, w_ma50_pressure, w_vix_regime, w_volume_confirmation
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SETTINGS.minDollarVolume, SETTINGS.minPrice,
    DEFAULT_SCORE_WEIGHTS.wTrendAboveMa50, DEFAULT_SCORE_WEIGHTS.wTrendMa50AboveMa200,
    DEFAULT_SCORE_WEIGHTS.wBreakout, DEFAULT_SCORE_WEIGHTS.wMa50Reclaim,
    DEFAULT_SCORE_WEIGHTS.wPullback, DEFAULT_SCORE_WEIGHTS.wMa50Pressure,
    DEFAULT_SCORE_WEIGHTS.wVixRegime, DEFAULT_SCORE_WEIGHTS.wVolumeConfirmation,
  );
}

ensureSettingsRow();

function loadActiveSettings() {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
  return {
    minDollarVolume: (row?.min_dollar_volume as number) ?? SETTINGS.minDollarVolume,
    minPrice: (row?.min_price as number) ?? SETTINGS.minPrice,
    scoreWeights: {
      wTrendAboveMa50: (row?.w_trend_above_ma50 as number) ?? DEFAULT_SCORE_WEIGHTS.wTrendAboveMa50,
      wTrendMa50AboveMa200: (row?.w_trend_ma50_above_ma200 as number) ?? DEFAULT_SCORE_WEIGHTS.wTrendMa50AboveMa200,
      wBreakout: (row?.w_breakout as number) ?? DEFAULT_SCORE_WEIGHTS.wBreakout,
      wMa50Reclaim: (row?.w_ma50_reclaim as number) ?? DEFAULT_SCORE_WEIGHTS.wMa50Reclaim,
      wPullback: (row?.w_pullback as number) ?? DEFAULT_SCORE_WEIGHTS.wPullback,
      wMa50Pressure: (row?.w_ma50_pressure as number) ?? DEFAULT_SCORE_WEIGHTS.wMa50Pressure,
      wVixRegime: (row?.w_vix_regime as number) ?? DEFAULT_SCORE_WEIGHTS.wVixRegime,
      wVolumeConfirmation: (row?.w_volume_confirmation as number) ?? DEFAULT_SCORE_WEIGHTS.wVolumeConfirmation,
    } as ScoreWeights,
  };
}

let activeSettings = loadActiveSettings();

// ── Chart cache: background job + progress tracking ──────────────────────────

interface ChartRefreshProgress {
  running: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

let chartRefreshProgress: ChartRefreshProgress = {
  running: false,
  total: 0,
  completed: 0,
  succeeded: 0,
  failed: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
};

async function runChartRefresh(): Promise<void> {
  const symbols = db
    .prepare('SELECT symbol FROM stocks WHERE price > ? AND avg_daily_dollar_volume > ?')
    .all(activeSettings.minPrice, activeSettings.minDollarVolume) as { symbol: string }[];

  chartRefreshProgress = {
    running: true,
    total: symbols.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };

  const CHART_CONCURRENCY = 8;
  const BATCH_DELAY_MS = 400;

  const insertRow = db.prepare(`
    INSERT OR REPLACE INTO prices (symbol, date, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteSymbol = db.prepare('DELETE FROM prices WHERE symbol = ?');

  // Fetch VIX data first (needed for regime scoring)
  try {
    const vixResult = await yahooFinance.chart('^VIX', { period1: new Date('2024-01-01'), interval: '1d' });
    const vixQuotes = vixResult.quotes ?? [];
    if (vixQuotes.length > 0) {
      db.transaction(() => {
        deleteSymbol.run('^VIX');
        for (const q of vixQuotes) {
          if (q.close == null) continue;
          const date = q.date instanceof Date ? q.date.toISOString().slice(0, 10) : String(q.date).slice(0, 10);
          insertRow.run('^VIX', date, q.open ?? null, q.high ?? null, q.low ?? null, q.close, q.volume ?? null);
        }
      })();
      console.log(`[charts] VIX cached: ${vixQuotes.length} rows`);
    }
  } catch (e) {
    console.warn('[charts] Failed to fetch VIX:', e);
  }

  async function fetchChartForSymbol(symbol: string): Promise<void> {
    try {
      const result = await yahooFinance.chart(symbol, {
        period1: new Date('2024-01-01'),
        interval: '1d',
      });
      const quotes = result.quotes ?? [];
      if (quotes.length > 0) {
        db.transaction(() => {
          deleteSymbol.run(symbol);
          for (const q of quotes) {
            if (q.close == null) continue;
            const date =
              q.date instanceof Date
                ? q.date.toISOString().slice(0, 10)
                : String(q.date).slice(0, 10);
            insertRow.run(symbol, date, q.open ?? null, q.high ?? null, q.low ?? null, q.close, q.volume ?? null);
          }
        })();
      }
      chartRefreshProgress.succeeded += 1;
    } catch {
      chartRefreshProgress.failed += 1;
    } finally {
      chartRefreshProgress.completed += 1;
    }
  }

  try {
    for (let i = 0; i < symbols.length; i += CHART_CONCURRENCY) {
      const batch = symbols.slice(i, i + CHART_CONCURRENCY).map((s) => fetchChartForSymbol(s.symbol));
      await Promise.allSettled(batch);
      if (i + CHART_CONCURRENCY < symbols.length) {
        await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    chartRefreshProgress = {
      ...chartRefreshProgress,
      running: false,
      finishedAt: new Date().toISOString(),
    };
    console.log(`[charts] Refresh done: ${chartRefreshProgress.succeeded} cached, ${chartRefreshProgress.failed} failed`);
  } catch (e: any) {
    chartRefreshProgress = {
      ...chartRefreshProgress,
      running: false,
      finishedAt: new Date().toISOString(),
      error: String(e?.message ?? e),
    };
    console.error('[charts] Refresh failed:', e);
  }
}

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
    const body = req.body as any;
    const { minDollarVolume, minPrice, scoreWeights } = body;

    if (typeof minDollarVolume !== 'number' || minDollarVolume < 0) {
      res.status(400).json({ error: 'minDollarVolume must be a non-negative number' });
      return;
    }
    if (typeof minPrice !== 'number' || minPrice < 0) {
      res.status(400).json({ error: 'minPrice must be a non-negative number' });
      return;
    }

    const sw: ScoreWeights = {
      wTrendAboveMa50: typeof scoreWeights?.wTrendAboveMa50 === 'number' ? scoreWeights.wTrendAboveMa50 : activeSettings.scoreWeights.wTrendAboveMa50,
      wTrendMa50AboveMa200: typeof scoreWeights?.wTrendMa50AboveMa200 === 'number' ? scoreWeights.wTrendMa50AboveMa200 : activeSettings.scoreWeights.wTrendMa50AboveMa200,
      wBreakout: typeof scoreWeights?.wBreakout === 'number' ? scoreWeights.wBreakout : activeSettings.scoreWeights.wBreakout,
      wMa50Reclaim: typeof scoreWeights?.wMa50Reclaim === 'number' ? scoreWeights.wMa50Reclaim : activeSettings.scoreWeights.wMa50Reclaim,
      wPullback: typeof scoreWeights?.wPullback === 'number' ? scoreWeights.wPullback : activeSettings.scoreWeights.wPullback,
      wMa50Pressure: typeof scoreWeights?.wMa50Pressure === 'number' ? scoreWeights.wMa50Pressure : activeSettings.scoreWeights.wMa50Pressure,
      wVixRegime: typeof scoreWeights?.wVixRegime === 'number' ? scoreWeights.wVixRegime : activeSettings.scoreWeights.wVixRegime,
      wVolumeConfirmation: typeof scoreWeights?.wVolumeConfirmation === 'number' ? scoreWeights.wVolumeConfirmation : activeSettings.scoreWeights.wVolumeConfirmation,
    };

    db.prepare(`
      UPDATE settings SET
        min_dollar_volume = ?, min_price = ?,
        w_trend_above_ma50 = ?, w_trend_ma50_above_ma200 = ?,
        w_breakout = ?, w_ma50_reclaim = ?, w_pullback = ?, w_ma50_pressure = ?,
        w_vix_regime = ?, w_volume_confirmation = ?
      WHERE id = 1
    `).run(
      minDollarVolume, minPrice,
      sw.wTrendAboveMa50, sw.wTrendMa50AboveMa200,
      sw.wBreakout, sw.wMa50Reclaim, sw.wPullback, sw.wMa50Pressure,
      sw.wVixRegime, sw.wVolumeConfirmation,
    );
    activeSettings = { minDollarVolume, minPrice, scoreWeights: sw };
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
    const chartDataAvailable = (
      db.prepare(`
        SELECT COUNT(*) as cnt
        FROM stocks s
        WHERE s.price > ? AND s.avg_daily_dollar_volume > ?
          AND EXISTS (SELECT 1 FROM prices p WHERE p.symbol = s.symbol)
      `).get(activeSettings.minPrice, activeSettings.minDollarVolume) as any
    ).cnt as number;
    const enoughBars = (
      db.prepare(`
        SELECT COUNT(*) as cnt
        FROM stocks s
        WHERE s.price > ? AND s.avg_daily_dollar_volume > ?
          AND (SELECT COUNT(*) FROM prices p WHERE p.symbol = s.symbol) >= 200
      `).get(activeSettings.minPrice, activeSettings.minDollarVolume) as any
    ).cnt as number;

    res.json({
      universe,
      afterPrice,
      afterDollarVolume,
      chartDataAvailable,
      enoughBars,
      scoredUniverse: enoughBars,
      settings: activeSettings,
    });
  });

  // API: Universe update progress
  app.get('/api/universe/progress', (req, res) => {
    res.json(universeProgress);
  });

  // API: Chart cache status
  app.get('/api/charts/status', (req, res) => {
    const row = db
      .prepare(`
        SELECT COUNT(DISTINCT symbol) as symbols, COUNT(*) as rows, MAX(date) as lastDate
        FROM prices
        WHERE symbol != '^VIX'
      `)
      .get() as any;
    res.json({
      cachedSymbols: row?.symbols ?? 0,
      totalRows: row?.rows ?? 0,
      lastDate: row?.lastDate ?? null,
      ...chartRefreshProgress,
    });
  });

  // API: Chart refresh progress
  app.get('/api/charts/progress', (req, res) => {
    res.json(chartRefreshProgress);
  });

  // API: Start chart refresh — background job
  app.post('/api/charts/refresh', (req, res) => {
    if (chartRefreshProgress.running) {
      res.status(409).json({ error: 'Chart refresh already in progress' });
      return;
    }
    runChartRefresh().catch(console.error);
    res.json({ started: true });
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

  // API: Run Scan (reads from local prices cache — fast, no Yahoo rate limits)
  app.post('/api/scan', (req, res) => {
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

    // Load VIX data from cache into a Map for fast lookup
    const vixRows = db.prepare('SELECT date, close FROM prices WHERE symbol = ? ORDER BY date ASC').all('^VIX') as Array<{ date: string; close: number }>;
    const vixData = vixRows.length > 0 ? new Map<string, number>(vixRows.map((r) => [r.date, r.close])) : undefined;

    const scoreWeights = activeSettings.scoreWeights;

    console.log(`[scan] Universe size: ${universeSize}`);
    console.log(`[scan] After price filter (>$${activeSettings.minPrice}): ${afterPriceFilter}`);
    console.log(`[scan] After dollar volume filter (>$${(activeSettings.minDollarVolume / 1_000_000).toFixed(0)}M): ${afterDollarVolumeFilter}`);

    const allResults: any[] = [];
    let attempted = 0;
    let chartOk = 0;
    let enoughBars = 0;
    let failed = 0;
    const sampleErrors: { symbol: string; message: string }[] = [];
    const scoreCoverage = {
      trendAboveMa50: 0,
      trendMa50AboveMa200: 0,
      breakout: 0,
      pullback: 0,
      ma50Reclaim: 0,
      ma50Pressure: 0,
      volumeConfirmedReclaim: 0,
      positiveLowVixTrend: 0,
    };

    function scanOne(symbol: string): void {
      attempted += 1;
      try {
        const rows = db
          .prepare('SELECT date, open, high, low, close, volume FROM prices WHERE symbol = ? ORDER BY date ASC')
          .all(symbol) as Array<{
            date: string;
            open: number | null;
            high: number | null;
            low: number | null;
            close: number | null;
            volume: number | null;
          }>;

        if (rows.length === 0) {
          failed += 1;
          if (sampleErrors.length < 5) {
            sampleErrors.push({ symbol, message: 'No cached data — run Refresh Charts first' });
          }
          return;
        }

        chartOk += 1;
        const filteredQuotes = rows.filter(
          (r) => r.close != null && r.high != null && r.low != null,
        );

        if (filteredQuotes.length >= 200) {
          enoughBars += 1;
          const data = {
            symbol,
            date: filteredQuotes.map((r) => r.date),
            close: filteredQuotes.map((r) => r.close as number),
            high: filteredQuotes.map((r) => r.high as number),
            low: filteredQuotes.map((r) => r.low as number),
            volume: filteredQuotes.map((r) => (r.volume ?? 0) as number),
          };
          const signals = analyzeTechnicalSignals(data, vixData);

          if (signals.priceAboveMa50) scoreCoverage.trendAboveMa50 += 1;
          if (signals.ma50AboveMa200) scoreCoverage.trendMa50AboveMa200 += 1;
          if (signals.breakout) scoreCoverage.breakout += 1;
          if (signals.pullback) scoreCoverage.pullback += 1;
          if (signals.ma50Reclaim) scoreCoverage.ma50Reclaim += 1;
          if (signals.ma50Pressure) scoreCoverage.ma50Pressure += 1;
          if (signals.volumeConfirmedReclaim) scoreCoverage.volumeConfirmedReclaim += 1;
          if (signals.positiveLowVixTrend) scoreCoverage.positiveLowVixTrend += 1;
        }

        const scanResult = evaluateSymbolQuotes(symbol, rows, scoreWeights, vixData);
        if (scanResult) {
          allResults.push(scanResult);
        }
      } catch (error: any) {
        failed += 1;
        if (sampleErrors.length < 5) {
          sampleErrors.push({ symbol, message: String(error?.message ?? error ?? 'unknown') });
        }
      }
    }

    // Scan from local DB cache — synchronous, no rate limits
    for (const s of stocks) {
      scanOne(s.symbol);
    }

    const sortedResults = allResults.sort((a, b) => b.score - a.score).slice(0, 30);
    const maxTrendScore = scoreWeights.wTrendAboveMa50 + scoreWeights.wTrendMa50AboveMa200;
    const maxPatternScore =
      scoreWeights.wBreakout +
      scoreWeights.wMa50Reclaim +
      scoreWeights.wPullback +
      scoreWeights.wMa50Pressure;
    const maxContextScore = scoreWeights.wVixRegime + scoreWeights.wVolumeConfirmation;

    const scanStats = {
      hardFilters: {
        universe: universeSize,
        afterPrice: afterPriceFilter,
        afterDollarVolume: afterDollarVolumeFilter,
        chartDataAvailable: chartOk,
        enoughBars,
        scoredUniverse: allResults.length,
      },
      scoreSummary: {
        maxScore: maxTrendScore + maxPatternScore + maxContextScore,
        trendMax: maxTrendScore,
        patternMax: maxPatternScore,
        contextMax: maxContextScore,
        coverage: scoreCoverage,
      },
      attempted,
      failed,
      candidates: sortedResults.length,
      sampleErrors,
      scannedAt: new Date().toISOString(),
    };

    db.prepare('INSERT INTO scan_results (results, stats) VALUES (?, ?)').run(
      JSON.stringify(sortedResults),
      JSON.stringify(scanStats),
    );

    console.log(
      `[scan] Scored universe: ${allResults.length} | top returned: ${sortedResults.length} | failed: ${failed}`,
    );

    res.json({ candidates: sortedResults, stats: scanStats });
  });

  // API: Get Latest Scan
  app.get('/api/scan/latest', (req, res) => {
    const row = db.prepare('SELECT * FROM scan_results ORDER BY scan_date DESC LIMIT 1').get() as any;
    if (row) {
      res.json({
        candidates: JSON.parse(row.results),
        stats: row.stats ? JSON.parse(row.stats) : null,
      });
    } else {
      res.json({ candidates: [], stats: null });
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
