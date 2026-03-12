import React, { useState, useEffect } from 'react';
import { 
  BarChart3, 
  Search, 
  TrendingUp, 
  AlertCircle, 
  Plus, 
  RefreshCw,
  ChevronRight,
  Target,
  ShieldAlert,
  Zap
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  ReferenceLine
} from 'recharts';
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
}

export default function App() {
  const [results, setResults] = useState<ScanResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [universe, setUniverse] = useState<{ symbol: string }[]>([]);
  const [newTicker, setNewTicker] = useState('');
  const [selectedStock, setSelectedStock] = useState<ScanResult | null>(null);

  useEffect(() => {
    fetchLatestScan();
    fetchUniverse();
  }, []);

  const fetchLatestScan = async () => {
    try {
      const res = await fetch('/api/scan/latest');
      const data = await res.json();
      setResults(data);
      if (data.length > 0) setSelectedStock(data[0]);
    } catch (e) {
      console.error(e);
    }
  };

  const fetchUniverse = async () => {
    try {
      const res = await fetch('/api/universe');
      const data = await res.json();
      setUniverse(data);
    } catch (e) {
      console.error(e);
    }
  };

  const runScan = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/scan', { method: 'POST' });
      const data = await res.json();
      setResults(data);
      if (data.length > 0) setSelectedStock(data[0]);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const addTicker = async () => {
    if (!newTicker) return;
    try {
      await fetch('/api/universe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: [newTicker.toUpperCase()] })
      });
      setNewTicker('');
      fetchUniverse();
    } catch (e) {
      console.error(e);
    }
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
        
        <div className="flex items-center gap-4">
          <div className="flex bg-white border border-[#141414] rounded-sm overflow-hidden">
            <input 
              type="text" 
              placeholder="ADD TICKER (E.G. AAPL)" 
              className="px-3 py-2 text-xs outline-none w-40 uppercase"
              value={newTicker}
              onChange={(e) => setNewTicker(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTicker()}
            />
            <button 
              onClick={addTicker}
              className="bg-[#141414] text-[#E4E3E0] px-3 py-2 hover:bg-opacity-90 transition-colors"
            >
              <Plus size={16} />
            </button>
          </div>
          
          <button 
            onClick={runScan}
            disabled={loading}
            className={cn(
              "flex items-center gap-2 bg-[#141414] text-[#E4E3E0] px-6 py-2 rounded-sm font-bold uppercase text-xs tracking-widest hover:invert transition-all",
              loading && "opacity-50 cursor-not-allowed"
            )}
          >
            {loading ? <RefreshCw className="animate-spin w-4 h-4" /> : <Zap className="w-4 h-4" />}
            {loading ? 'Scanning...' : 'Run Weekly Scan'}
          </button>
        </div>
      </header>

      <main className="grid grid-cols-12 h-[calc(100vh-89px)]">
        {/* Sidebar: Results List */}
        <div className="col-span-4 border-r border-[#141414] overflow-y-auto bg-white/50">
          <div className="p-4 border-b border-[#141414] bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
            <h2 className="text-[11px] uppercase tracking-[0.2em] font-bold italic font-serif">Top Candidates</h2>
            <span className="text-[10px] opacity-50">{results.length} Stocks Found</span>
          </div>
          
          <div className="divide-y divide-[#141414]">
            {results.map((stock, idx) => (
              <motion.div
                key={stock.symbol}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.05 }}
                onClick={() => setSelectedStock(stock)}
                className={cn(
                  "p-4 cursor-pointer transition-all hover:bg-[#141414] hover:text-[#E4E3E0] group",
                  selectedStock?.symbol === stock.symbol && "bg-[#141414] text-[#E4E3E0]"
                )}
              >
                <div className="flex justify-between items-start mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold font-mono tracking-tighter">{stock.symbol}</span>
                    <div className="flex gap-1">
                      {stock.patterns.map(p => (
                        <span key={p} className="text-[8px] px-1 border border-current opacity-70 uppercase font-bold">{p}</span>
                      ))}
                    </div>
                  </div>
                  <span className={cn(
                    "font-mono text-sm font-bold",
                    stock.change >= 0 ? "text-emerald-600 group-hover:text-emerald-400" : "text-rose-600 group-hover:text-rose-400"
                  )}>
                    {stock.change >= 0 ? '+' : ''}{stock.change.toFixed(2)}%
                  </span>
                </div>
                <div className="flex justify-between items-end">
                  <div className="text-[10px] opacity-60 uppercase tracking-wider">
                    Price: ${stock.price.toFixed(2)}
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[9px] uppercase opacity-50">Score</span>
                    <span className="text-xs font-bold font-mono">{stock.score}</span>
                  </div>
                </div>
              </motion.div>
            ))}
            
            {results.length === 0 && !loading && (
              <div className="p-12 text-center opacity-30 italic">
                No scan results found. Add tickers and run a scan.
              </div>
            )}
          </div>
        </div>

        {/* Main Content: Details & Charts */}
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
                {/* Stock Header */}
                <div className="flex justify-between items-end border-b-2 border-[#141414] pb-4">
                  <div>
                    <h2 className="text-6xl font-black font-serif italic tracking-tighter leading-none">{selectedStock.symbol}</h2>
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

                {/* Metrics Grid */}
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

                {/* Pattern Analysis */}
                <div className="bg-[#141414] text-[#E4E3E0] p-6 rounded-sm">
                  <h3 className="text-[11px] uppercase tracking-[0.2em] font-bold mb-4 flex items-center gap-2">
                    <Zap size={14} className="text-yellow-400" />
                    Detected Signals
                  </h3>
                  <div className="flex flex-wrap gap-3">
                    {selectedStock.patterns.map(p => (
                      <div key={p} className="px-4 py-2 border border-[#E4E3E0]/30 rounded-full text-sm font-bold italic font-serif">
                        {p}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Chart Placeholder / Info */}
                <div className="border-2 border-[#141414] p-8 bg-white aspect-video flex flex-col items-center justify-center text-center space-y-4">
                  <BarChart3 size={48} className="opacity-20" />
                  <div>
                    <h4 className="text-lg font-bold font-serif italic">Interactive Charting</h4>
                    <p className="text-xs opacity-50 max-w-xs mx-auto">
                      In a production environment, this would render a full OHLCV chart with MA overlays. 
                      Currently using simulated data visualization.
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

      {/* Footer / Status Bar */}
      <footer className="fixed bottom-0 left-0 right-0 bg-[#141414] text-[#E4E3E0] px-6 py-2 flex justify-between items-center text-[10px] uppercase tracking-widest font-bold">
        <div className="flex gap-6">
          <span>Universe Size: {universe.length}</span>
          <span>Last Scan: {new Date().toLocaleDateString()}</span>
        </div>
        <div className="flex gap-4">
          <span className="flex items-center gap-1"><div className="w-2 h-2 rounded-full bg-emerald-500" /> System Active</span>
          <span>SQLite DB Connected</span>
        </div>
      </footer>
    </div>
  );
}
