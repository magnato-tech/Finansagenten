import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  AlertCircle,
  RefreshCw,
  Target,
  ShieldAlert,
  Zap,
  Database,
  Settings,
  Filter,
  Save,
  RotateCcw,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ScanResult {
  symbol: string;
  price: number;
  change: number;
  ma50: number;
  ma150: number;
  ma200: number;
  atr: number;
  stopLoss: number;
  patterns: string[];
  score: number;
  scoreBreakdown: Record<string, number>;
  scoreBuckets: {
    trend: number;
    pattern: number;
    context: number;
  };
}

interface UniverseMeta {
  count: number;
  lastUpdated: string | null;
}

interface ScoreWeights {
  wTrendAboveMa50: number;
  wTrendMa50AboveMa200: number;
  wBreakout: number;
  wMa50Reclaim: number;
  wPullback: number;
  wMa50Pressure: number;
  wVixRegime: number;
  wVolumeConfirmation: number;
}

interface ScannerSettings {
  minDollarVolume: number;
  minPrice: number;
  scoreWeights: ScoreWeights;
}

interface FilterImpact {
  universe: number;
  afterPrice: number;
  afterDollarVolume: number;
  chartDataAvailable: number;
  enoughBars: number;
  scoredUniverse: number;
  settings: ScannerSettings;
}

interface ScanStats {
  hardFilters: {
    universe: number;
    afterPrice: number;
    afterDollarVolume: number;
    chartDataAvailable: number;
    enoughBars: number;
    scoredUniverse: number;
  };
  scoreSummary: {
    maxScore: number;
    trendMax: number;
    patternMax: number;
    contextMax: number;
    coverage: {
      trendAboveMa50: number;
      trendMa50AboveMa200: number;
      breakout: number;
      pullback: number;
      ma50Reclaim: number;
      ma50Pressure: number;
      volumeConfirmedReclaim: number;
      positiveLowVixTrend: number;
    };
  };
  attempted: number;
  failed: number;
  candidates: number;
  sampleErrors: { symbol: string; message: string }[];
  scannedAt: string;
}

interface UniverseProgress {
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

interface ChartStatus {
  cachedSymbols: number;
  totalRows: number;
  lastDate: string | null;
}

type ActiveTab = 'scanner' | 'settings';

const DEFAULT_WEIGHTS: ScoreWeights = {
  wTrendAboveMa50: 20,
  wTrendMa50AboveMa200: 30,
  wBreakout: 50,
  wMa50Reclaim: 40,
  wPullback: 30,
  wMa50Pressure: 20,
  wVixRegime: 25,
  wVolumeConfirmation: 30,
};

const DEFAULTS: ScannerSettings = {
  minDollarVolume: 5_000_000,
  minPrice: 3,
  scoreWeights: DEFAULT_WEIGHTS,
};

function formatMarketCap(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

function pct(value: number, total: number): string {
  if (total === 0) return '0%';
  return `${((value / total) * 100).toFixed(1)}%`;
}

function dropOff(from: number, to: number): string {
  if (from === 0) return '—';
  return `-${(((from - to) / from) * 100).toFixed(1)}%`;
}

function getScoreBand(score: number, maxScore: number) {
  if (maxScore === 0) return { label: 'Neutral', className: 'text-[#141414]/60' };
  const ratio = score / maxScore;
  if (ratio >= 0.7) return { label: 'Strong', className: 'text-emerald-600' };
  if (ratio >= 0.45) return { label: 'Moderate', className: 'text-amber-600' };
  return { label: 'Weak', className: 'text-rose-600' };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('scanner');

  // Scanner state
  const [results, setResults] = useState<ScanResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [universeMeta, setUniverseMeta] = useState<UniverseMeta>({ count: 0, lastUpdated: null });
  const [updatingUniverse, setUpdatingUniverse] = useState(false);
  const [selectedStock, setSelectedStock] = useState<ScanResult | null>(null);
  const [scanStats, setScanStats] = useState<ScanStats | null>(null);

  // Universe update progress
  const [updateProgress, setUpdateProgress] = useState<UniverseProgress | null>(null);
  const pollingRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Chart cache state
  const [chartStatus, setChartStatus] = useState<ChartStatus | null>(null);
  const [chartRefreshProgress, setChartRefreshProgress] = useState<ChartRefreshProgress | null>(null);
  const [refreshingCharts, setRefreshingCharts] = useState(false);
  const chartPollingRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  // Settings state
  const [settings, setSettings] = useState<ScannerSettings>(DEFAULTS);
  const [draft, setDraft] = useState<ScannerSettings>(DEFAULTS);
  const [filterImpact, setFilterImpact] = useState<FilterImpact | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  useEffect(() => {
    fetchLatestScan();
    fetchUniverseMeta();
    fetchSettings();
    fetchFilterImpact();
    fetchChartStatus();
    // Resume polling if a universe update is already in progress when page loads
    fetch('/api/universe/progress')
      .then((r) => r.json())
      .then((data: UniverseProgress) => {
        if (data.running) {
          setUpdateProgress(data);
          setUpdatingUniverse(true);
          startProgressPolling();
        }
      })
      .catch(() => {});
    // Resume chart polling if a chart refresh is already running
    fetch('/api/charts/progress')
      .then((r) => r.json())
      .then((data: ChartRefreshProgress) => {
        if (data.running) {
          setChartRefreshProgress(data);
          setRefreshingCharts(true);
          startChartPolling();
        }
      })
      .catch(() => {});
  }, []);

  const fetchLatestScan = async () => {
    try {
      const res = await fetch('/api/scan/latest');
      const data = await res.json();
      const candidates: ScanResult[] = data.candidates ?? [];
      setResults(candidates);
      setScanStats(data.stats ?? null);
      if (candidates.length > 0) setSelectedStock(candidates[0]);
      if (candidates.length === 0) setSelectedStock(null);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchUniverseMeta = async () => {
    try {
      const res = await fetch('/api/universe');
      const data = await res.json();
      setUniverseMeta(data);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      const merged: ScannerSettings = {
        ...DEFAULTS,
        ...data,
        scoreWeights: { ...DEFAULT_WEIGHTS, ...(data.scoreWeights ?? {}) },
      };
      setSettings(merged);
      setDraft(merged);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchFilterImpact = async () => {
    try {
      const res = await fetch('/api/settings/impact');
      const data = await res.json();
      setFilterImpact(data);
    } catch (e) {
      console.error(e);
    }
  };

  const pollProgress = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/universe/progress');
      const data: UniverseProgress = await res.json();
      setUpdateProgress(data);
      if (!data.running) {
        setUpdatingUniverse(false);
        await Promise.all([fetchUniverseMeta(), fetchFilterImpact()]);
        return false; // done
      }
    } catch (e) {
      console.error(e);
    }
    return true; // still running
  };

  const startProgressPolling = () => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    // Poll once immediately, then every 2s
    pollProgress().then((stillRunning) => {
      if (!stillRunning) return;
      pollingRef.current = setInterval(async () => {
        const stillRunning = await pollProgress();
        if (!stillRunning && pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }, 2000);
    });
  };

  const fetchChartStatus = async () => {
    try {
      const res = await fetch('/api/charts/status');
      const data = await res.json();
      setChartStatus(data);
    } catch (e) {
      console.error(e);
    }
  };

  const pollChartProgress = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/charts/progress');
      const data: ChartRefreshProgress = await res.json();
      setChartRefreshProgress(data);
      if (!data.running) {
        setRefreshingCharts(false);
        await fetchChartStatus();
        return false;
      }
    } catch (e) {
      console.error(e);
    }
    return true;
  };

  const startChartPolling = () => {
    if (chartPollingRef.current) clearInterval(chartPollingRef.current);
    pollChartProgress().then((stillRunning) => {
      if (!stillRunning) return;
      chartPollingRef.current = setInterval(async () => {
        const still = await pollChartProgress();
        if (!still && chartPollingRef.current) {
          clearInterval(chartPollingRef.current);
          chartPollingRef.current = null;
        }
      }, 2000);
    });
  };

  const refreshCharts = async () => {
    setRefreshingCharts(true);
    try {
      const res = await fetch('/api/charts/refresh', { method: 'POST' });
      if (res.status === 409) return;
      startChartPolling();
    } catch (e) {
      console.error(e);
      setRefreshingCharts(false);
    }
  };

  const updateUniverse = async () => {
    setUpdatingUniverse(true);
    try {
      const res = await fetch('/api/universe/update', { method: 'POST' });
      if (res.status === 409) return; // already running
      startProgressPolling();
    } catch (e) {
      console.error(e);
      setUpdatingUniverse(false);
    }
  };

  const runScan = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/scan', { method: 'POST' });
      const data = await res.json();
      const candidates: ScanResult[] = data.candidates ?? [];
      setResults(candidates);
      setScanStats(data.stats ?? null);
      if (candidates.length > 0) setSelectedStock(candidates[0]);
      if (candidates.length === 0) setSelectedStock(null);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const err = await res.json();
        alert((err as { error: string }).error ?? 'Failed to save settings');
        return;
      }
      const savedRaw = await res.json();
      const saved: ScannerSettings = {
        ...DEFAULTS,
        ...savedRaw,
        scoreWeights: { ...DEFAULT_WEIGHTS, ...(savedRaw.scoreWeights ?? {}) },
      };
      setSettings(saved);
      setDraft(saved);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
      await fetchFilterImpact();
    } catch (e) {
      console.error(e);
    } finally {
      setSavingSettings(false);
    }
  };

  const revertDraft = () => setDraft(settings);

  const resetToDefaults = async () => {
    setSavingSettings(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(DEFAULTS),
      });
      const savedRaw = await res.json();
      const saved: ScannerSettings = {
        ...DEFAULTS,
        ...savedRaw,
        scoreWeights: { ...DEFAULT_WEIGHTS, ...(savedRaw.scoreWeights ?? {}) },
      };
      setSettings(saved);
      setDraft(saved);
      await fetchFilterImpact();
    } catch (e) {
      console.error(e);
    } finally {
      setSavingSettings(false);
    }
  };

  const isDirty =
    draft.minDollarVolume !== settings.minDollarVolume ||
    draft.minPrice !== settings.minPrice ||
    (Object.keys(DEFAULT_WEIGHTS) as (keyof ScoreWeights)[]).some(
      (k) => draft.scoreWeights[k] !== settings.scoreWeights[k],
    );

  const formatDate = (iso: string | null) => {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#141414] flex items-center justify-center rounded-sm">
            <TrendingUp className="text-[#E4E3E0] w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase italic font-serif">Finansagenten</h1>
            <p className="text-[10px] uppercase tracking-widest opacity-50">Global Technical Scanner v1.0</p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 border border-[#141414] px-4 py-2 bg-white/60 rounded-sm">
            <Database size={14} className="opacity-50 shrink-0" />
            <div className="text-[10px] uppercase tracking-widest leading-tight">
              <span className="font-bold">{universeMeta.count.toLocaleString()} stocks</span>
              <span className="opacity-40 mx-2">·</span>
              <span className="opacity-60">Updated {formatDate(universeMeta.lastUpdated)}</span>
            </div>
          </div>

          <button
            onClick={updateUniverse}
            disabled={updatingUniverse}
            className={cn(
              'flex items-center gap-2 border border-[#141414] text-[#141414] px-4 py-2 rounded-sm font-bold uppercase text-[10px] tracking-widest hover:bg-[#141414] hover:text-[#E4E3E0] transition-all',
              updatingUniverse && 'opacity-50 cursor-not-allowed',
            )}
          >
            <RefreshCw className={cn('w-3 h-3', updatingUniverse && 'animate-spin')} />
            {updatingUniverse ? 'Updating...' : 'Update Universe'}
          </button>

          <button
            onClick={refreshCharts}
            disabled={refreshingCharts}
            className={cn(
              'flex items-center gap-2 border border-[#141414] text-[#141414] px-4 py-2 rounded-sm font-bold uppercase text-[10px] tracking-widest hover:bg-[#141414] hover:text-[#E4E3E0] transition-all',
              refreshingCharts && 'opacity-50 cursor-not-allowed',
            )}
          >
            <Database className={cn('w-3 h-3', refreshingCharts && 'animate-pulse')} />
            {refreshingCharts ? 'Caching...' : 'Refresh Charts'}
          </button>

          <button
            onClick={runScan}
            disabled={loading}
            className={cn(
              'flex items-center gap-2 bg-[#141414] text-[#E4E3E0] px-6 py-2 rounded-sm font-bold uppercase text-xs tracking-widest hover:invert transition-all',
              loading && 'opacity-50 cursor-not-allowed',
            )}
          >
            {loading ? <RefreshCw className="animate-spin w-4 h-4" /> : <Zap className="w-4 h-4" />}
            {loading ? 'Scanning...' : 'Run Weekly Scan'}
          </button>
        </div>
      </header>

      {/* Tab Bar */}
      <div className="border-b border-[#141414] flex">
        {(['scanner', 'settings'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'flex items-center gap-2 px-6 py-3 text-[10px] uppercase tracking-widest font-bold border-r border-[#141414] transition-all',
              activeTab === tab ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-[#141414]/5',
            )}
          >
            {tab === 'scanner' ? <BarChart3 size={12} /> : <Settings size={12} />}
            {tab}
          </button>
        ))}
      </div>

      {/* ── Universe Update Progress Banner ── */}
      {updateProgress && (updateProgress.running || updateProgress.phase === 'done' || updateProgress.phase === 'error') && (
        <div className={cn(
          'border-b border-[#141414] px-6 py-3',
          updateProgress.phase === 'error' ? 'bg-rose-50' : 'bg-white/70',
        )}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              {updateProgress.running && <RefreshCw size={13} className="animate-spin opacity-60 shrink-0" />}
              <span className="text-[11px] font-bold uppercase tracking-widest">
                {updateProgress.phase === 'fetching-symbols' && 'Henter symboler fra NASDAQ…'}
                {updateProgress.phase === 'fetching-fundamentals' && 'Henter markedsdata fra Yahoo Finance…'}
                {updateProgress.phase === 'saving' && 'Lagrer til database…'}
                {updateProgress.phase === 'done' && '✓ Universe oppdatert'}
                {updateProgress.phase === 'error' && `Feil: ${updateProgress.error}`}
              </span>
            </div>
            <div className="flex items-center gap-4 text-[10px] font-mono opacity-60">
              {updateProgress.total > 0 && (
                <>
                  <span>{updateProgress.completed.toLocaleString()} / {updateProgress.total.toLocaleString()}</span>
                  <span className="text-emerald-600">+{updateProgress.succeeded.toLocaleString()}</span>
                  {updateProgress.failed > 0 && (
                    <span className="text-rose-500">–{updateProgress.failed.toLocaleString()}</span>
                  )}
                </>
              )}
              {updateProgress.phase === 'done' && updateProgress.finishedAt && (
                <span className="opacity-40">Ferdig {new Date(updateProgress.finishedAt).toLocaleTimeString('no-NO')}</span>
              )}
            </div>
          </div>
          {updateProgress.total > 0 && (
            <div className="h-1 bg-[#E4E3E0] rounded-full overflow-hidden">
              <motion.div
                className={cn('h-full rounded-full', updateProgress.phase === 'error' ? 'bg-rose-500' : 'bg-[#141414]')}
                animate={{ width: `${(updateProgress.completed / updateProgress.total) * 100}%` }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Chart Refresh Progress Banner ── */}
      {chartRefreshProgress && (chartRefreshProgress.running || (chartRefreshProgress.finishedAt != null)) && (
        <div className={cn(
          'border-b border-[#141414] px-6 py-3',
          chartRefreshProgress.error ? 'bg-rose-50' : 'bg-blue-50/60',
        )}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              {chartRefreshProgress.running && <Database size={13} className="animate-pulse opacity-60 shrink-0" />}
              <span className="text-[11px] font-bold uppercase tracking-widest">
                {chartRefreshProgress.running
                  ? `Henter kursdata fra Yahoo Finance… (${chartRefreshProgress.completed.toLocaleString()} / ${chartRefreshProgress.total.toLocaleString()})`
                  : chartRefreshProgress.error
                  ? `Feil: ${chartRefreshProgress.error}`
                  : `✓ Chart-cache oppdatert — ${chartRefreshProgress.succeeded.toLocaleString()} aksjer cachet`}
              </span>
            </div>
            <div className="flex items-center gap-4 text-[10px] font-mono opacity-60">
              {chartRefreshProgress.total > 0 && chartRefreshProgress.running && (
                <>
                  <span className="text-emerald-600">+{chartRefreshProgress.succeeded.toLocaleString()}</span>
                  {chartRefreshProgress.failed > 0 && (
                    <span className="text-rose-500">–{chartRefreshProgress.failed.toLocaleString()}</span>
                  )}
                </>
              )}
              {!chartRefreshProgress.running && chartRefreshProgress.finishedAt && (
                <span className="opacity-40">Ferdig {new Date(chartRefreshProgress.finishedAt).toLocaleTimeString('no-NO')}</span>
              )}
            </div>
          </div>
          {chartRefreshProgress.total > 0 && (
            <div className="h-1 bg-[#E4E3E0] rounded-full overflow-hidden">
              <motion.div
                className={cn('h-full rounded-full', chartRefreshProgress.error ? 'bg-rose-500' : 'bg-blue-600')}
                animate={{ width: `${(chartRefreshProgress.completed / chartRefreshProgress.total) * 100}%` }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              />
            </div>
          )}
        </div>
      )}

      {/* ── SCANNER TAB ── */}
      {activeTab === 'scanner' && (
        <main className="grid grid-cols-12 h-[calc(100vh-137px)]">
          {/* Sidebar */}
          <div className="col-span-4 border-r border-[#141414] overflow-y-auto bg-white/50">
            <div className="p-4 border-b border-[#141414] bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
              <h2 className="text-[11px] uppercase tracking-[0.2em] font-bold italic font-serif">Top Candidates</h2>
              <span className="text-[10px] opacity-50">{results.length} Stocks Found</span>
            </div>

            {/* Scan Statistics */}
            {scanStats && (
              <div className="border-b border-[#141414] bg-[#141414]/5 px-4 py-3 space-y-2">
                <p className="text-[9px] uppercase tracking-widest font-bold opacity-40 mb-2">Last Scan Diagnostics</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  {[
                    { label: 'Scored universe', value: scanStats.hardFilters.scoredUniverse },
                    { label: 'Top returned', value: scanStats.candidates },
                    { label: 'Max score', value: scanStats.scoreSummary.maxScore },
                    { label: 'Attempted', value: scanStats.attempted },
                    { label: 'Failed', value: scanStats.failed, warn: scanStats.failed > scanStats.attempted * 0.3 },
                    { label: 'Scanned at', value: formatDate(scanStats.scannedAt) as any },
                  ].map((s) => (
                    <div key={s.label} className="flex justify-between items-center">
                      <span className="text-[9px] uppercase tracking-wider opacity-50">{s.label}</span>
                      <span className={cn(
                        'text-[10px] font-mono font-bold',
                        s.warn ? 'text-rose-500' : 'opacity-70',
                      )}>
                        {typeof s.value === 'number' ? s.value.toLocaleString() : s.value}
                      </span>
                    </div>
                  ))}
                </div>
                {scanStats.sampleErrors.length > 0 && (
                  <details className="mt-1">
                    <summary className="text-[9px] uppercase tracking-wider opacity-40 cursor-pointer">
                      Sample errors ({scanStats.sampleErrors.length})
                    </summary>
                    <div className="mt-1 space-y-0.5">
                      {scanStats.sampleErrors.map((e, i) => (
                        <p key={i} className="text-[8px] font-mono opacity-40 truncate">
                          {e.symbol}: {e.message}
                        </p>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            <div className="divide-y divide-[#141414]">
              {results.map((stock, idx) => (
                <motion.div
                  key={stock.symbol}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  onClick={() => setSelectedStock(stock)}
                  className={cn(
                    'p-4 cursor-pointer transition-all hover:bg-[#141414] hover:text-[#E4E3E0] group',
                    selectedStock?.symbol === stock.symbol && 'bg-[#141414] text-[#E4E3E0]',
                  )}
                >
                  {(() => {
                    const band = getScoreBand(stock.score, scanStats?.scoreSummary.maxScore ?? 0);
                    return (
                      <>
                  <div className="flex justify-between items-start mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold font-mono tracking-tighter">{stock.symbol}</span>
                      <div className="flex gap-1">
                        {stock.patterns.map((p) => (
                          <span key={p} className="text-[8px] px-1 border border-current opacity-70 uppercase font-bold">
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'font-mono text-sm font-bold',
                        stock.change >= 0
                          ? 'text-emerald-600 group-hover:text-emerald-400'
                          : 'text-rose-600 group-hover:text-rose-400',
                      )}
                    >
                      {stock.change >= 0 ? '+' : ''}
                      {stock.change.toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between items-end">
                    <div className="text-[10px] opacity-60 uppercase tracking-wider">
                      Price: ${stock.price.toFixed(2)}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[9px] uppercase opacity-50">Score</span>
                      <span className="text-xs font-bold font-mono">{stock.score}</span>
                      <span className={cn('text-[9px] font-bold uppercase', band.className)}>{band.label}</span>
                    </div>
                  </div>
                  <div className="mt-2 flex gap-3 text-[9px] uppercase opacity-50 tracking-wider">
                    <span>T {stock.scoreBuckets.trend}</span>
                    <span>P {stock.scoreBuckets.pattern}</span>
                    <span>C {stock.scoreBuckets.context}</span>
                  </div>
                      </>
                    );
                  })()}
                </motion.div>
              ))}

              {results.length === 0 && !loading && (
                <div className="p-12 text-center opacity-30 italic">
                  No scan results found. Add tickers and run a scan.
                </div>
              )}
            </div>
          </div>

          {/* Detail panel */}
          <div className="col-span-8 p-8 overflow-y-auto">
            {selectedStock ? (
              <AnimatePresence mode="wait">
                <motion.div
                  key={selectedStock.symbol}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="space-y-8"
                >
                  <div className="flex justify-between items-end border-b-2 border-[#141414] pb-4">
                    <div>
                      <h2 className="text-6xl font-black font-serif italic tracking-tighter leading-none">
                        {selectedStock.symbol}
                      </h2>
                      <p className="text-sm uppercase tracking-[0.3em] opacity-50 mt-2">Technical Analysis Report</p>
                    </div>
                    <div className="text-right">
                      <div className="text-4xl font-mono font-bold">${selectedStock.price.toFixed(2)}</div>
                      <div className="flex gap-2 justify-end mt-2">
                        <div className="flex items-center gap-1 px-2 py-1 bg-[#141414] text-[#E4E3E0] text-[10px] font-bold uppercase">
                          <ShieldAlert size={12} />
                          Stop Loss: ${selectedStock.stopLoss.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-4">
                    {[
                      { label: 'MA50', value: selectedStock.ma50, icon: Target },
                      { label: 'MA150', value: selectedStock.ma150, icon: BarChart3 },
                      { label: 'MA200', value: selectedStock.ma200, icon: TrendingUp },
                      { label: 'ATR (14)', value: selectedStock.atr, icon: AlertCircle },
                    ].map((m) => (
                      <div key={m.label} className="border border-[#141414] p-4 bg-white">
                        <div className="flex items-center gap-2 opacity-50 mb-1">
                          <m.icon size={12} />
                          <span className="text-[10px] uppercase font-bold tracking-widest">{m.label}</span>
                        </div>
                        <div className="text-xl font-mono font-bold">${m.value.toFixed(2)}</div>
                      </div>
                    ))}
                  </div>

                  <div className="bg-[#141414] text-[#E4E3E0] p-6 rounded-sm">
                    <h3 className="text-[11px] uppercase tracking-[0.2em] font-bold mb-4 flex items-center gap-2">
                      <Zap size={14} className="text-yellow-400" />
                      Detected Signals
                    </h3>
                    {selectedStock.patterns.length > 0 ? (
                      <div className="flex flex-wrap gap-3">
                        {selectedStock.patterns.map((p) => (
                          <div
                            key={p}
                            className="px-4 py-2 border border-[#E4E3E0]/30 rounded-full text-sm font-bold italic font-serif"
                          >
                            {p}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm opacity-60">No pattern bonus this week. Ranking comes from trend/context score only.</p>
                    )}
                  </div>

                  <div className="border border-[#141414] bg-white p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-[11px] uppercase tracking-[0.2em] font-bold flex items-center gap-2">
                        <BarChart3 size={14} />
                        Score Breakdown
                      </h3>
                      {(() => {
                        const band = getScoreBand(selectedStock.score, scanStats?.scoreSummary.maxScore ?? 0);
                        return <span className={cn('text-[10px] uppercase font-bold tracking-widest', band.className)}>{band.label}</span>;
                      })()}
                    </div>
                    <div className="grid grid-cols-3 gap-4 mb-5">
                      {[
                        { label: 'Trend', value: selectedStock.scoreBuckets.trend, max: scanStats?.scoreSummary.trendMax ?? 0 },
                        { label: 'Pattern', value: selectedStock.scoreBuckets.pattern, max: scanStats?.scoreSummary.patternMax ?? 0 },
                        { label: 'Context', value: selectedStock.scoreBuckets.context, max: scanStats?.scoreSummary.contextMax ?? 0 },
                      ].map((bucket) => (
                        <div key={bucket.label} className="border border-[#141414]/20 px-4 py-3 bg-[#E4E3E0]/30">
                          <div className="text-[10px] uppercase tracking-widest opacity-50">{bucket.label}</div>
                          <div className="text-2xl font-mono font-bold mt-1">{bucket.value}<span className="opacity-30 text-base">/{bucket.max}</span></div>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-2">
                      {Object.entries(selectedStock.scoreBreakdown).length > 0 ? (
                        Object.entries(selectedStock.scoreBreakdown).map(([label, value]) => (
                          <div key={label} className="flex items-center justify-between border-b border-[#141414]/10 pb-2 text-sm">
                            <span className="opacity-70">{label}</span>
                            <span className="font-mono font-bold">+{value}</span>
                          </div>
                        ))
                      ) : (
                        <p className="text-sm opacity-50">No active score signals on this symbol.</p>
                      )}
                    </div>
                  </div>

                  <div className="border-2 border-[#141414] p-8 bg-white aspect-video flex flex-col items-center justify-center text-center space-y-4">
                    <BarChart3 size={48} className="opacity-20" />
                    <div>
                      <h4 className="text-lg font-bold font-serif italic">Interactive Charting</h4>
                      <p className="text-xs opacity-50 max-w-xs mx-auto">
                        In a production environment, this would render a full OHLCV chart with MA overlays. Currently
                        using simulated data visualization.
                      </p>
                    </div>
                  </div>
                </motion.div>
              </AnimatePresence>
            ) : (
              <div className="h-full flex items-center justify-center text-[#141414]/20 italic font-serif text-2xl">
                Select a stock to view detailed analysis
              </div>
            )}
          </div>
        </main>
      )}

      {/* ── SETTINGS TAB ── */}
      {activeTab === 'settings' && (
        <main className="h-[calc(100vh-137px)] overflow-y-auto p-8 pb-20">
          <div className="max-w-3xl mx-auto space-y-8">

            {/* Chart Cache Status */}
            <section>
              <h2 className="text-[11px] uppercase tracking-[0.2em] font-bold mb-4 flex items-center gap-2">
                <Database size={12} />
                Chart Data Cache
              </h2>
              <div className="border border-[#141414] bg-white p-5 flex items-center justify-between gap-6">
                <div className="space-y-1">
                  <p className="text-sm font-bold">
                    {chartStatus && chartStatus.cachedSymbols > 0
                      ? `${chartStatus.cachedSymbols.toLocaleString()} aksjer cachet · ${(chartStatus.totalRows ?? 0).toLocaleString()} datapunkter`
                      : 'Ingen chart-data i cache'}
                  </p>
                  <p className="text-[10px] opacity-50 uppercase tracking-widest">
                    {chartStatus?.lastDate
                      ? `Siste dato i cache: ${chartStatus.lastDate}`
                      : 'Trykk "Refresh Charts" for å laste ned kurshistorikk for alle filtrerte aksjer'}
                  </p>
                  <p className="text-[10px] opacity-40 mt-2">
                    Scan leser fra lokal cache — ingen Yahoo rate-limiting. Oppdater én gang i uken.
                  </p>
                </div>
                <button
                  onClick={refreshCharts}
                  disabled={refreshingCharts}
                  className={cn(
                    'shrink-0 flex items-center gap-2 bg-[#141414] text-[#E4E3E0] px-5 py-2.5 rounded-sm font-bold uppercase text-[10px] tracking-widest transition-all',
                    refreshingCharts ? 'opacity-50 cursor-not-allowed' : 'hover:invert',
                  )}
                >
                  <Database className={cn('w-3 h-3', refreshingCharts && 'animate-pulse')} />
                  {refreshingCharts ? 'Caching...' : 'Refresh Charts'}
                </button>
              </div>
            </section>

            {/* Filter Funnel */}
            <section>
              <h2 className="text-[11px] uppercase tracking-[0.2em] font-bold mb-4 flex items-center gap-2">
                <Filter size={12} />
                Filter Pipeline
              </h2>

              <div className="border border-[#141414] bg-white divide-y divide-[#141414]">
                {filterImpact ? (
                  <>
                    {[
                      {
                        label: 'Universe',
                        description: 'All US-listed symbols in database',
                        count: filterImpact.universe,
                        dropFrom: null as number | null,
                      },
                      {
                        label: 'Price Filter',
                        description: `Price per share > $${filterImpact.settings.minPrice}`,
                        count: filterImpact.afterPrice,
                        dropFrom: filterImpact.universe,
                      },
                      {
                        label: 'Dollar Volume Filter',
                        description: `Avg. daily turnover > ${formatMarketCap(filterImpact.settings.minDollarVolume)}`,
                        count: filterImpact.afterDollarVolume,
                        dropFrom: filterImpact.afterPrice,
                      },
                      {
                        label: 'Chart Data Available',
                        description: 'Cached OHLCV data found in local database',
                        count: filterImpact.chartDataAvailable,
                        dropFrom: filterImpact.afterDollarVolume,
                      },
                      {
                        label: '>= 200 Bars',
                        description: 'Enough valid history to calculate indicators',
                        count: filterImpact.enoughBars,
                        dropFrom: filterImpact.chartDataAvailable,
                      },
                      {
                        label: 'Scored Universe',
                        description: 'All remaining stocks receive a technical score',
                        count: filterImpact.scoredUniverse,
                        dropFrom: filterImpact.enoughBars,
                      },
                    ].map((stage, i) => {
                      const barWidth =
                        filterImpact.universe > 0
                          ? `${(stage.count / filterImpact.universe) * 100}%`
                          : '0%';
                      return (
                        <div key={stage.label} className="p-5">
                          <div className="flex items-center justify-between mb-3">
                            <div className="flex items-center gap-3">
                              <span className="w-6 h-6 rounded-full bg-[#141414] text-[#E4E3E0] text-[10px] font-bold flex items-center justify-center shrink-0">
                                {i + 1}
                              </span>
                              <div>
                                <div className="font-bold text-sm tracking-tight">{stage.label}</div>
                                <div className="text-[10px] opacity-50 uppercase tracking-widest mt-0.5">
                                  {stage.description}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-5">
                              {stage.dropFrom !== null && (
                                <span className="text-[11px] font-mono font-bold text-rose-600">
                                  {dropOff(stage.dropFrom, stage.count)}
                                </span>
                              )}
                              <div className="text-right">
                                <div className="text-2xl font-mono font-bold leading-none">
                                  {stage.count.toLocaleString()}
                                </div>
                                <div className="text-[10px] font-mono opacity-40 mt-0.5">
                                  {pct(stage.count, filterImpact.universe)}
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="h-1.5 bg-[#E4E3E0] rounded-full overflow-hidden">
                            <motion.div
                              className="h-full bg-[#141414] rounded-full"
                              initial={{ width: 0 }}
                              animate={{ width: barWidth }}
                              transition={{ duration: 0.6, ease: 'easeOut' }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </>
                ) : (
                  <div className="p-12 text-center opacity-30 italic">
                    Run "Update Universe" to populate filter stats.
                  </div>
                )}
              </div>
            </section>

            {/* Technical Score Coverage */}
            <section>
              <h2 className="text-[11px] uppercase tracking-[0.2em] font-bold mb-1 flex items-center gap-2">
                <BarChart3 size={12} />
                Technical Score Coverage
              </h2>
              <p className="text-[10px] opacity-40 uppercase tracking-widest mb-4">
                Ingen aksjer ryker ut her. Tallene viser hvor mange i scored universe som treffer hvert poengsignal.
              </p>

              <div className="border border-[#141414] bg-white divide-y divide-[#141414]">
                {scanStats ? (
                  <>
                    <div className="px-5 py-3 bg-[#141414]/5 text-[10px] uppercase tracking-widest opacity-60">
                      Basert på siste weekly scan · {formatDate(scanStats.scannedAt)}
                    </div>
                    {[
                      {
                        title: 'Trend Signals',
                        items: [
                          {
                            label: 'Price > MA50',
                            count: scanStats.scoreSummary.coverage.trendAboveMa50,
                            weight: settings.scoreWeights.wTrendAboveMa50,
                          },
                          {
                            label: 'MA50 > MA200',
                            count: scanStats.scoreSummary.coverage.trendMa50AboveMa200,
                            weight: settings.scoreWeights.wTrendMa50AboveMa200,
                          },
                        ],
                      },
                      {
                        title: 'Pattern Signals',
                        items: [
                          { label: 'Breakout', count: scanStats.scoreSummary.coverage.breakout, weight: settings.scoreWeights.wBreakout },
                          { label: 'Pullback', count: scanStats.scoreSummary.coverage.pullback, weight: settings.scoreWeights.wPullback },
                          { label: 'MA50 Reclaim', count: scanStats.scoreSummary.coverage.ma50Reclaim, weight: settings.scoreWeights.wMa50Reclaim },
                          { label: 'MA50 Pressure', count: scanStats.scoreSummary.coverage.ma50Pressure, weight: settings.scoreWeights.wMa50Pressure },
                        ],
                      },
                      {
                        title: 'Context Signals',
                        items: [
                          {
                            label: 'Volume-confirmed Reclaim',
                            count: scanStats.scoreSummary.coverage.volumeConfirmedReclaim,
                            weight: settings.scoreWeights.wVolumeConfirmation,
                          },
                          {
                            label: 'Positive Low-VIX Trend',
                            count: scanStats.scoreSummary.coverage.positiveLowVixTrend,
                            weight: settings.scoreWeights.wVixRegime,
                          },
                        ],
                      },
                    ].map((group) => (
                      <div key={group.title}>
                        <div className="px-5 py-3 bg-[#141414]/5">
                          <p className="text-[9px] uppercase tracking-widest font-bold opacity-50">{group.title}</p>
                        </div>
                        <div className="divide-y divide-[#141414]/10">
                          {group.items.map((item) => {
                            const total = scanStats.hardFilters.scoredUniverse;
                            const barWidth = total > 0 ? `${(item.count / total) * 100}%` : '0%';
                            return (
                              <div key={item.label} className="p-5">
                                <div className="flex items-center justify-between mb-3">
                                  <div>
                                    <div className="font-bold text-sm tracking-tight">{item.label}</div>
                                    <div className="text-[10px] opacity-50 uppercase tracking-widest mt-0.5">
                                      {pct(item.count, total)} av scored universe
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-5">
                                    <div className="text-right">
                                      <div className="text-2xl font-mono font-bold leading-none">
                                        {item.count.toLocaleString()}
                                      </div>
                                      <div className="text-[10px] font-mono opacity-40 mt-0.5">
                                        Weight {item.weight}
                                      </div>
                                    </div>
                                  </div>
                                </div>
                                <div className="h-1.5 bg-[#E4E3E0] rounded-full overflow-hidden">
                                  <motion.div
                                    className="h-full bg-[#141414] rounded-full"
                                    initial={{ width: 0 }}
                                    animate={{ width: barWidth }}
                                    transition={{ duration: 0.6, ease: 'easeOut' }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="px-5 py-4 bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
                      <span className="text-[10px] uppercase tracking-widest opacity-60">Scored universe</span>
                      <span className="font-mono font-bold text-lg">{scanStats.hardFilters.scoredUniverse.toLocaleString()}</span>
                    </div>
                  </>
                ) : (
                  <div className="p-12 text-center opacity-30 italic">
                    Run a weekly scan to inspect score signal coverage.
                  </div>
                )}
              </div>
            </section>

            {/* Score Weights */}
            <section>
              <h2 className="text-[11px] uppercase tracking-[0.2em] font-bold mb-1 flex items-center gap-2">
                <Zap size={12} />
                Score Weights
              </h2>
              <p className="text-[10px] opacity-40 uppercase tracking-widest mb-4">
                Justér vekting av de ulike score-komponentene. Max mulig score = sum av alle vekter.
              </p>

              <div className="border border-[#141414] bg-white divide-y divide-[#141414]">
                {/* Trend */}
                <div className="px-5 py-3 bg-[#141414]/5">
                  <p className="text-[9px] uppercase tracking-widest font-bold opacity-50">Trend-komponenter</p>
                </div>
                {[
                  { key: 'wTrendAboveMa50' as keyof ScoreWeights, label: 'Price > MA50', desc: 'Kortsiktig oppadgående trend' },
                  { key: 'wTrendMa50AboveMa200' as keyof ScoreWeights, label: 'MA50 > MA200', desc: 'Langsiktig oppadgående struktur (Golden Cross-sone)' },
                ].map(({ key, label, desc }) => (
                  <div key={key} className="px-5 py-4 flex items-center gap-6">
                    <div className="flex-1">
                      <div className="font-bold text-sm">{label}</div>
                      <div className="text-[10px] opacity-50 uppercase tracking-widest mt-0.5">{desc}</div>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={5}
                      value={draft.scoreWeights[key]}
                      onChange={(e) => setDraft((d) => ({ ...d, scoreWeights: { ...d.scoreWeights, [key]: Number(e.target.value) } }))}
                      className="w-20 border border-[#141414] px-3 py-2 font-mono text-sm text-center bg-[#E4E3E0] focus:outline-none focus:ring-2 focus:ring-[#141414]"
                    />
                  </div>
                ))}

                {/* Patterns */}
                <div className="px-5 py-3 bg-[#141414]/5">
                  <p className="text-[9px] uppercase tracking-widest font-bold opacity-50">Mønster-bonuser</p>
                </div>
                {[
                  { key: 'wBreakout' as keyof ScoreWeights, label: 'Breakout', desc: 'Pris over 20-dagers høy — sterkest signal' },
                  { key: 'wMa50Reclaim' as keyof ScoreWeights, label: 'MA50 Reclaim', desc: 'Krysset over MA50 fra under — institusjonell interesse' },
                  { key: 'wPullback' as keyof ScoreWeights, label: 'Pullback', desc: 'Tilbaketrekk til MA50 i oppadgående trend' },
                  { key: 'wMa50Pressure' as keyof ScoreWeights, label: 'MA50 Pressure', desc: 'Gjentatt testing av MA50 fra under — oppbygning' },
                ].map(({ key, label, desc }) => (
                  <div key={key} className="px-5 py-4 flex items-center gap-6">
                    <div className="flex-1">
                      <div className="font-bold text-sm">{label}</div>
                      <div className="text-[10px] opacity-50 uppercase tracking-widest mt-0.5">{desc}</div>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={5}
                      value={draft.scoreWeights[key]}
                      onChange={(e) => setDraft((d) => ({ ...d, scoreWeights: { ...d.scoreWeights, [key]: Number(e.target.value) } }))}
                      className="w-20 border border-[#141414] px-3 py-2 font-mono text-sm text-center bg-[#E4E3E0] focus:outline-none focus:ring-2 focus:ring-[#141414]"
                    />
                  </div>
                ))}

                {/* Context */}
                <div className="px-5 py-3 bg-[#141414]/5">
                  <p className="text-[9px] uppercase tracking-widest font-bold opacity-50">Markedskontekst (nye)</p>
                </div>
                {[
                  { key: 'wVolumeConfirmation' as keyof ScoreWeights, label: 'Volum-bekreftelse på MA50 Reclaim', desc: 'Høyt volum (>2x snitt) ved reclaim = institusjonell kjøping. Sett til 0 for å deaktivere.' },
                  { key: 'wVixRegime' as keyof ScoreWeights, label: 'Positiv trend i lav-VIX-perioder', desc: 'Var aksjen stigende når VIX < 20 de siste 6 mnd? Svakhet nå kan være VIX-drevet, ikke fundamental. Sett til 0 for å deaktivere.' },
                ].map(({ key, label, desc }) => (
                  <div key={key} className="px-5 py-4 flex items-center gap-6">
                    <div className="flex-1">
                      <div className="font-bold text-sm">{label}</div>
                      <div className="text-[10px] opacity-50 uppercase tracking-widest mt-0.5">{desc}</div>
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={5}
                      value={draft.scoreWeights[key]}
                      onChange={(e) => setDraft((d) => ({ ...d, scoreWeights: { ...d.scoreWeights, [key]: Number(e.target.value) } }))}
                      className="w-20 border border-[#141414] px-3 py-2 font-mono text-sm text-center bg-[#E4E3E0] focus:outline-none focus:ring-2 focus:ring-[#141414]"
                    />
                  </div>
                ))}

                {/* Max score summary */}
                <div className="px-5 py-4 bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
                  <span className="text-[10px] uppercase tracking-widest opacity-60">Max mulig score</span>
                  <span className="font-mono font-bold text-lg">
                    {Object.values(draft.scoreWeights).reduce((a, b) => a + b, 0)}
                  </span>
                </div>
              </div>
            </section>

            {/* Settings Form */}
            <section>
              <h2 className="text-[11px] uppercase tracking-[0.2em] font-bold mb-4 flex items-center gap-2">
                <Settings size={12} />
                Hard Filter Settings
              </h2>

              <div className="border border-[#141414] bg-white p-6 space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  {/* Min Dollar Volume */}
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest font-bold mb-2 opacity-60">
                      Min Avg. Daily Dollar Volume (USD)
                    </label>
                    <input
                      type="number"
                      value={draft.minDollarVolume}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, minDollarVolume: Number(e.target.value) }))
                      }
                      min={0}
                      step={1_000_000}
                      className="w-full border border-[#141414] px-4 py-3 font-mono text-sm bg-[#E4E3E0] focus:outline-none focus:ring-2 focus:ring-[#141414]"
                    />
                    <p className="text-[10px] opacity-40 mt-1.5">
                      Current: {formatMarketCap(draft.minDollarVolume)}/day — Default: $5M
                    </p>
                  </div>

                  {/* Min Price */}
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest font-bold mb-2 opacity-60">
                      Min Price Per Share (USD)
                    </label>
                    <input
                      type="number"
                      value={draft.minPrice}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, minPrice: Number(e.target.value) }))
                      }
                      min={0}
                      step={0.5}
                      className="w-full border border-[#141414] px-4 py-3 font-mono text-sm bg-[#E4E3E0] focus:outline-none focus:ring-2 focus:ring-[#141414]"
                    />
                    <p className="text-[10px] opacity-40 mt-1.5">
                      Current: ${draft.minPrice.toFixed(2)} — Default: $3.00
                    </p>
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-3 pt-2 border-t border-[#141414]/20">
                  <button
                    onClick={saveSettings}
                    disabled={savingSettings || !isDirty}
                    className={cn(
                      'flex items-center gap-2 bg-[#141414] text-[#E4E3E0] px-6 py-2 rounded-sm font-bold uppercase text-[10px] tracking-widest transition-all',
                      savingSettings || !isDirty ? 'opacity-40 cursor-not-allowed' : 'hover:invert',
                    )}
                  >
                    {savingSettings ? (
                      <RefreshCw size={12} className="animate-spin" />
                    ) : (
                      <Save size={12} />
                    )}
                    {settingsSaved ? 'Saved!' : 'Save Settings'}
                  </button>

                  <button
                    onClick={revertDraft}
                    disabled={!isDirty}
                    className={cn(
                      'flex items-center gap-2 border border-[#141414] px-4 py-2 rounded-sm font-bold uppercase text-[10px] tracking-widest transition-all',
                      !isDirty ? 'opacity-40 cursor-not-allowed' : 'hover:bg-[#141414] hover:text-[#E4E3E0]',
                    )}
                  >
                    <RotateCcw size={12} />
                    Revert
                  </button>

                  <button
                    onClick={resetToDefaults}
                    disabled={savingSettings}
                    className="flex items-center gap-2 border border-[#141414]/40 px-4 py-2 rounded-sm font-bold uppercase text-[10px] tracking-widest opacity-50 hover:opacity-100 transition-all hover:bg-[#141414] hover:text-[#E4E3E0]"
                  >
                    Reset to Defaults
                  </button>
                </div>
              </div>
            </section>
          </div>
        </main>
      )}

      {/* Footer / Status Bar */}
      <footer className="fixed bottom-0 left-0 right-0 bg-[#141414] text-[#E4E3E0] px-6 py-2 flex justify-between items-center text-[10px] uppercase tracking-widest font-bold">
        <div className="flex gap-6">
          <span>Universe Size: {universeMeta.count.toLocaleString()}</span>
          <span>Last Update: {formatDate(universeMeta.lastUpdated)}</span>
        </div>
        <div className="flex gap-4">
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-500" /> System Active
          </span>
          <span>SQLite DB Connected</span>
        </div>
      </footer>
    </div>
  );
}
